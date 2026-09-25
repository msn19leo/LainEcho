/**
 * 聊天轮次核心（从 ai.ipc.ts 的 send-message 处理器抽取，供两个入口复用）：
 *  1. 渲染端 IPC（用户在聊天窗/宠物窗发消息）
 *  2. 主动搭话调度器（主进程自触发，旁白作为 user 消息入史）
 *
 * 职责不变：组装 system prompt（Section 树 + 记忆检索）→ A1/A2 上下文 → 流式请求 →
 * 情绪块结算 → TTS 跟读 → 持久化（user+assistant）→ 记忆沉淀（后台）。
 * 与原实现的行为差异（均为主动搭话所需，用户路径不受影响）：
 *  - 模型上下文改为「磁盘会话历史 + 本轮 user 消息」，不再信任渲染端传入的消息列表；
 *  - user 消息可携带 meta 标记（proactive/story）落盘并随 stream-user 广播；
 *  - proactive 轮次跳过记忆抽取，且历史中的 proactive 旁白消息一律不参与抽取。
 */
import type { AppSettings, ChatMessage, ChatMessageMeta, StandardEmotion } from '../../src/types'
import { sendChatCompletion } from './aiClient'
import { parseDialogueJson, extractStreamingJsonText, extractDialogueChunkDelta, salvageDialogueFromText, extractLeadingNarration, splitNarrationGroups, consumeLeadingNarration } from './emotion'
import { buildModelContext, SUMMARY_MAX_TOKENS, toModelMessage, type ModelMessage } from './context'
import { estimateMessagesTokens } from './token'
import { getTTSConfig } from '../ipc/tts.ipc'
import { readApiKey } from './crypto'
import { extractMemoriesFromSession } from './memoryExtraction'
import {
  appendSessionMessages,
  buildSystemPrompt,
  getCharacterCard,
  getSession,
  getSettings,
  updateSessionSummary,
} from './repository'
import { retrieveMemories } from './memory/retriever'
import { windowManager } from '../windows/windowManager'

/** 降级模式的记忆注入条数（与旧 MAX_MEMORIES 一致） */
const MAX_MEMORIES = 8

/** 当前进行中的轮次（ai:cancel 取消 / 投放闸门判定用） */
let currentAbort: AbortController | null = null

/** 系统旁白包装前缀（仅模型视角）：proactive 旁白以 user 角色入史，若不加标记，
 * 模型会把旁白当成对方的发言——曾导致 AI 把"（你揉了揉困倦的眼睛…）"
 * 当成用户的动作来回应。主措辞用"角色本人"降低"你=角色"的锚定强度；
 * 但旧会话已落盘的旁白仍是第二人称，必须保留"句中'你'即指你本人"的桥接条款。
 * 落盘与两窗展示文本不变，只在组装模型上下文时包装。 */
const PROACTIVE_NARRATION_PREFIX =
  '【系统旁白】以下内容是舞台指示，描述的是角色本人（你）的动作与心情；旁白句中若以"你"作主语，即指你本人。这不是对方说的话，也不是让你复述的台词。请把它当作你自己的举动来消化，以你自己的口吻自然开口：\n'

/**
 * 净化单条消息为模型消息；meta.proactive 的旁白消息附加系统旁白标记。
 * 历史中的旁白同样处理，避免错误归因在后续轮次累积。
 */
function toModelMessageWithNarration(m: ChatMessage): ModelMessage {
  const msg = toModelMessage(m)
  if (m.meta?.proactive) msg.content = `${PROACTIVE_NARRATION_PREFIX}${msg.content}`
  return msg
}

/** 是否有正在进行的聊天轮次（主动搭话投放闸门用） */
export function isChatBusy(): boolean {
  return currentAbort !== null
}

/** 取消当前轮次（ai:cancel） */
export function cancelCurrentTurn(): void {
  currentAbort?.abort()
}

/** 摘要压缩专用 system prompt：独立上下文，绝不混入主对话的 EMOTION_PROMPT JSON 约束 */
const SUMMARY_SYSTEM_PROMPT =
  '你是一个专业的对话总结助手。将用户与角色之间的对话历史压缩成简洁准确的总结，' +
  '保留关键信息、人物关系进展、重要约定与当前话题，忽略无关细节。' +
  '直接输出总结文本本身，不要输出 JSON、不要加任何解释或格式标记。'

/**
 * 构造摘要回调：把旧历史文本交给模型（独立 prompt、非流式）压成摘要文本。
 * 与主对话隔离：绝不混入 EMOTION_PROMPT 的 JSON 输出约束。失败时 throw。
 */
export function createSummarizer(settings: AppSettings, apiKey: string, signal?: AbortSignal) {
  return async (olderText: string): Promise<string> => {
    const summary = await sendChatCompletion(
      [
        { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: `以下是对话历史：\n${olderText}\n\n请输出总结：` },
      ],
      {
        model: settings.model,
        baseURL: settings.baseURL,
        apiKey,
        temperature: 0.3,
        stream: false,
        maxTokensOverride: SUMMARY_MAX_TOKENS,
        signal,
      },
    )
    const trimmed = (summary ?? '').trim()
    if (!trimmed) throw new Error('摘要为空')
    return trimmed
  }
}

/** 格式化本地时间为 YYYY-MM-DD HH:MM:SS（用户消息本地时间注入用） */
function formatLocalTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
/** 主进程合并 chunk 的 flush 间隔（毫秒）：多个 delta 合并为一次 IPC 推送，减少消息数 */
const CHUNK_FLUSH_MS = 16
/** 单个"情绪块"最多合并的 dialogue 项数：超过即提前结算，保持在"边生成边读"的实时性，避免单块越长越延迟出声 */
const BLOCK_MAX_ITEMS = 3

/** 聊天轮次入参 */
export interface ChatTurnParams {
  /** 普通聊天 = 会话 id；剧情演出 = run id（仅作流式广播键，渲染端按各自持有的会话/run 过滤） */
  sessionId: string
  /** 本轮 user 消息文本（普通聊天 = 用户输入；主动搭话/剧情旁白 = 系统旁白） */
  content: string
  /** 消息来源标记（落盘 + stream-user 广播携带） */
  meta?: ChatMessageMeta
  /**
   * 剧情导演指令段（仅剧情 ai_dialogue/free_dialogue 轮次传入）：
   * 作为 StorySection 注入 system prompt 末尾，约束演出节奏与叙事边界。
   */
  storyDirective?: string
  /**
   * 剧情 run 存储覆盖（剧情演出专用；与聊天会话完全分离）：
   * - history/append：消息读写改走 run 文件（跳过会话索引/摘要/A2）；
   * - cardId：角色卡从 run 取（run 不在会话索引里）；
   * - storyRunId：传入时把流式生成的可读文本（累积全文）实时推给剧情窗做预览（7.7 性能第一批；
   *   生成完成后仍由消息同步接管正式分段播放，节奏队列语义不变）；
   * - 桌宠零参与：不发 notifyThinking/VoiceMode/Emotion，跳过记忆抽取。
   */
  store?: {
    cardId: string
    history: ChatMessage[]
    append: (msgs: ChatMessage[]) => Promise<void>
    storyRunId?: string
  }
}

/**
 * 执行一轮完整聊天：旁白/用户消息入史 → 流式生成 → 语音跟读 → 持久化 → 记忆沉淀。
 * @returns 落盘的 assistant 消息；出错时向渲染端广播 stream-error 后 rethrow
 */
export async function runChatTurn(params: ChatTurnParams): Promise<ChatMessage> {
  const { sessionId, content, meta, storyDirective, store } = params
  if (!content.trim()) throw new Error('消息内容为空')

  const userMsg: ChatMessage = { role: 'user', content, timestamp: Date.now(), meta }
  let partial = ''

  // 广播本轮的 user 消息，让跟随窗口（非发起方）也能立刻补上用户气泡，
  // 无需等 stream-done 全量拉取才出现（否则跟随窗口会缺用户消息、且中途消息闪变）
  // 剧情轮次（store 覆盖）：完全不经由 ai:stream-* 通道（聊天/宠物窗与剧情彻底隔离），
  // 剧情窗由 story:message 增量同步驱动
  if (!store) windowManager.broadcastAI('ai:stream-user', { sessionId, content: userMsg.content, timestamp: userMsg.timestamp, meta: meta ?? null })
  // 记录"进行中的流"所属会话：窗口重载/新建后就绪时补发用于认领，避免漏该轮事件（剧情 run 无此需求）
  if (!store) windowManager.setActiveStreamingSession(sessionId)

  // 进入"思考中"：通知桌宠切换到思考立绘（剧情演出桌宠零参与，跳过）
  if (!store) windowManager.notifyThinking(true)
  // 首个可读文本块到达后即退出思考立绘（见 flushChunks）的一次性标记
  let needExitThinking = true
  // 语音是否启用（由 onChunk 在 voiceActive 求值后同步，供 flushChunks 闭包安全读取）
  let voiceActiveRef = false

  // 合并推送：把模型原始输出实时提取成纯净台词文本，累积后按 CHUNK_FLUSH_MS 窗口一次性 send，
  // 避免把 JSON（花括号/键名）暴露给聊天窗，也减少 IPC 往返。lastDisplayLen 用于只发新增片段。
  let lastDisplayLen = 0
  let chunkTimer: NodeJS.Timeout | null = null
  // ---- 开头括号旁白前置状态（跟读模式下旁白流式即时上屏，不等语音；台词仍段随语音）----
  /** 已确认的回答开头连续括号组全文（display 前缀，流式中只会增长） */
  let leadingNarration = ''
  /** 已广播给渲染端的旁白字符数（增量发送游标） */
  let narrationSent = 0
  /** 前置旁白的括号组数组（语音块剥除用，逐组消费） */
  let narrationGroups: string[] = []
  /** 语音块已消费的组数游标（跨块推进） */
  let narrationCursor = { count: 0 }

  /** 重置旁白前置状态（空回复重试轮从头流式时调用），并通知渲染端清空已前置旁白重收。
   *  voiceActiveRef：attempt 1 尚未收到 chunk 时为 false（无需 reset，onVoiceMode 已清空）；
   *  attempt ≥2 时已被 onChunk 同步为 voiceActive，此时必须广播 reset 清掉上一轮已前置旁白。 */
  const resetNarrationState = () => {
    leadingNarration = ''
    narrationSent = 0
    narrationGroups = []
    narrationCursor = { count: 0 }
    if (!store && voiceActiveRef) windowManager.broadcastAI('ai:stream-narration', { reset: true })
  }

  /** 从当前流式 partial 同步提取开头旁白到状态（不广播）。
   *  flushPendingBlock 在块满/情绪变化时可能在两次 flushChunks 之间触发，
   *  剥除前必须先同步一次，否则刚闭合的括号组未入状态会导致语音块剥不干净、跟读气泡里旁白重复。 */
  const syncLeadingNarration = () => {
    if (store) return
    const narration = extractLeadingNarration(extractStreamingJsonText(partial))
    if (narration !== leadingNarration) {
      leadingNarration = narration
      narrationGroups = splitNarrationGroups(narration)
    }
  }

  const flushChunks = () => {
    chunkTimer = null
    const display = extractStreamingJsonText(partial)
    const delta = display.length > lastDisplayLen ? display.slice(lastDisplayLen) : ''
    lastDisplayLen = Math.max(lastDisplayLen, display.length)
    if (delta) {
      // 剧情轮次：流式增量不经 ai:stream-* 通道（剧情窗按 run 消息逐段播放，不做流式上屏）
      if (!store) windowManager.broadcastAI('ai:stream-chunk', delta)
      // 未启用语音：思考立绘显示到首个文本开始输出（首个可读文本块即退出）；剧情轮次桌宠零参与
      if (!store && !voiceActiveRef && needExitThinking) {
        needExitThinking = false
        windowManager.notifyThinking(false)
      }
    }
    // 剧情轮次流式预览（7.7）：发送提取后的可读文本累积全文（窗端整体替换，重试轮自动纠偏）
    if (store?.storyRunId && display) {
      windowManager.pushStoryStream(store.storyRunId, display)
    }
    // 旁白前置：把回答开头的连续括号组实时广播上屏（仅跟读模式；非跟读下 streamingContent
    // 本就含括号全文）。只发已闭合的括号组（extractLeadingNarration 保证前缀稳定）。
    if (!store && voiceActiveRef) {
      syncLeadingNarration()
      if (leadingNarration.length > narrationSent) {
        windowManager.broadcastAI('ai:stream-narration', { delta: leadingNarration.slice(narrationSent) })
        narrationSent = leadingNarration.length
      }
    }
  }

  const abort = new AbortController()
  currentAbort = abort
  try {
    const settings = await getSettings()
    const ttsCfg = await getTTSConfig()
    // 整段合音：开启时主进程关闭"边生成边读"，流式结束后整段一次合成（音调连贯）；关闭时保持逐句实时朗读
    const mergeSpeech = ttsCfg.mergeSpeech === true
    const apiKey = await readApiKey()
    if (!apiKey) throw new Error('未配置 API Key，请先在「设置 → AI API 配置」中填写')
    if (!settings.baseURL.trim()) throw new Error('未配置 API 地址（baseURL）')
    if (!settings.model.trim()) throw new Error('未配置模型名（model）')

    // 组装 system prompt：人设字段 + 示例对话 + 记忆注入
    // 记忆来源由检索器决定：向量模式（语义检索 top-k + 画像/约定常驻）或降级模式（最近 N 条，旧行为）
    // 剧情轮次（store 覆盖）：角色卡从 run 取，跳过会话读取与记忆检索（剧情与记忆系统隔离）
    let card
    let history: ChatMessage[]
    let retrievalItems: import('../../src/types').MemoryItem[] = []
    let profileDigest: string | null = null
    if (store) {
      card = await getCharacterCard(store.cardId)
      history = store.history
    } else {
      const session = await getSession(sessionId)
      card = await getCharacterCard(session.characterCardId)
      const retrieval = await retrieveMemories(session.characterCardId, content, MAX_MEMORIES)
      retrievalItems = retrieval.items
      profileDigest = retrieval.profileDigest
      history = session.messages
    }
    const systemMessage: ChatMessage = {
      role: 'system',
      content: buildSystemPrompt(card, retrievalItems, settings.userName, profileDigest, settings.enableProactive, storyDirective),
    }
    if (!store) {
      console.log('[memory] 注入条数=%d 画像=%s', retrievalItems.length, profileDigest ? 'yes' : 'no')
    }

    // A1+A2 上下文组装：历史（剧情 = run.messages）+ 本轮 user 消息 → 净化 → 预算装填/自动摘要
    // proactive 旁白消息在此附加系统旁白标记（历史中的旁白同样处理，见 toModelMessageWithNarration）
    const modelMessages = [...history, userMsg].map(toModelMessageWithNarration)
    // 本地时间注入：仅给发送给模型的当前用户消息加前缀（不污染落盘历史），让角色感知发送时刻
    if (modelMessages.length > 0) {
      const lastMsg = modelMessages[modelMessages.length - 1]!
      if (lastMsg.role === 'user') {
        lastMsg.content = `[本地时间 ${formatLocalTime(new Date())}]\n${lastMsg.content}`
      }
    }
    const summarize = createSummarizer(settings, apiKey, abort.signal)
    const ctx = await buildModelContext({
      systemMessage,
      messages: modelMessages,
      contextWindowTokens: settings.contextWindowTokens,
      // 剧情轮次跳过 A2 自动摘要（run 摘要暂不落盘，仅 A1 预算装填）
      enableAutoCompact: store ? false : settings.enableAutoCompact,
      summarize,
    })
    const fullMessages = ctx.messages
    // 摘要落盘复用（失败静默，不影响本轮请求；剧情 run 无会话摘要）
    if (ctx.newSummary && !store) {
      await updateSessionSummary(sessionId, ctx.newSummary).catch(() => {})
    }
    // 上下文 token 用量日志（后续可上 UI 展示）
    console.log(
      '[context] system=%d history=%d total=%d (msgs %d->%d, compact=%s)',
      estimateMessagesTokens([systemMessage]),
      estimateMessagesTokens(modelMessages),
      estimateMessagesTokens(fullMessages),
      modelMessages.length,
      fullMessages.length - 1,
      ctx.newSummary ? 'yes' : 'no',
    )
    // 广播上下文 token 用量给桌宠窗显示（会话收放按钮旁；剧情轮次跳过）
    if (!store) {
      windowManager.broadcastAI('ai:context-stats', {
        sessionId,
        system: estimateMessagesTokens([systemMessage]),
        history: estimateMessagesTokens(modelMessages),
        total: estimateMessagesTokens(fullMessages),
        window: settings.contextWindowTokens,
      })
    }

    // ---- 语音生成策略（始终跟读文本）----
    // 剧情轮次（store 覆盖）桌宠零参与：语音由剧情窗独立 TTS 播放，主进程不做任何桌宠语音/状态通知
    const effMode = !store ? (card?.voiceMode ?? (card?.voiceId ? 'mimo' : 'none')) : 'none'
    const voiceEngine: 'genie' | 'mimo' | null =
      effMode === 'genie' ? 'genie' : effMode === 'mimo' ? 'mimo' : null
    const voiceActive =
      effMode === 'genie' ? true : effMode === 'mimo' ? !!card?.voiceId : false
    const genieOverride = effMode === 'genie' ? (card?.genieOverride ?? null) : null
    // 流式一开始即广播本轮语音模式，让宠物窗提前用跟读展示方式（剧情轮次跳过）
    if (!store) windowManager.notifyVoiceMode({ voiceEnabled: voiceActive })
    let speechCursor = 0
    let pendingBlock: { texts: string[]; emotion: StandardEmotion } | null = null
    /** 是否已通过流式触发过至少一次语音（用于非流式/分块失败的兜底判定） */
    let speechEmitted = false
    // 结算当前情绪块并触发桌宠语音（语音启用时才发声）
    const flushPendingBlock = () => {
      const b = pendingBlock
      pendingBlock = null
      if (!b || b.texts.length === 0 || !card || !voiceActive) return
      // 剥除前先同步一次开头旁白（块满触发的结算可能发生在两次 flushChunks 之间）
      syncLeadingNarration()
      // 剥掉已前置上屏的开头括号组，避免语音段上屏时旁白重复；纯前置旁白块剥后为空 → 跳过投放
      const text = consumeLeadingNarration(b.texts.join('\n'), narrationGroups, narrationCursor)
      if (!text.trim()) {
        speechEmitted = true // 该块已由旁白前置通道接管，视为已触发，避免兜底重复投放
        return
      }
      speechEmitted = true
      const langOverride = card.ttsOverride?.language ?? null
      const voiceId = voiceEngine === 'mimo' ? card.voiceId : null
      // 不在此处退出思考立绘：speak 仅代表"发起合成"，此刻语音尚未真正发声。
      // 思考立绘的退出改由渲染端在 lipSync 真正开始播放音频时触发（见 PetStage）。
      windowManager.speak(text, voiceId, langOverride, { chunks: [{ text, emotion: b.emotion }], follow: true, engine: voiceEngine ?? undefined, genieOverride })
    }
    // 流式 onChunk 中实时结算：新 dialogue 项并入当前块，情绪变化或块足够大即结算旧块，保持"边生成边读"
    const pumpSpeech = () => {
      const { items, cursor } = extractDialogueChunkDelta(partial, speechCursor)
      speechCursor = cursor
      for (const it of items) {
        if (!pendingBlock) { pendingBlock = { texts: [it.text], emotion: it.emotion }; continue }
        if (it.emotion !== pendingBlock.emotion || pendingBlock.texts.length >= BLOCK_MAX_ITEMS) {
          flushPendingBlock()
          pendingBlock = { texts: [it.text], emotion: it.emotion }
        } else {
          pendingBlock.texts.push(it.text)
        }
      }
    }

    console.log('[diag] settings.stream=', settings.stream)
    // 思考型模型（mimo-v2.5 等）的 reasoning 计入 max_tokens 预算：预算太小时思考就把 token
    // 吃光，content 通道为空 → 每轮都要靠重试。max_tokens 上限只影响截断、不影响实际计费，
    // 因此抬到至少 2048 给思考留足余量（与主动搭话旁白生成同款处理）。
    const effectiveMaxTokens = Math.max(settings.maxTokens ?? 0, 2048)
    // 空回复自动重试：模型偶发只输出思考内容（<think> 包裹/ reasoning 通道）或被截断时，
    // 解析结果为空文本。先尝试从思考文本中抢救正文，仍为空 → 附加纠正提示自动重试（最多 3 次尝试）。
    const stripThink = (s: string) => s.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '').trim()
    const baseMessages = fullMessages
    let attemptMessages = fullMessages
    let rawOutput = ''
    let parsed: ReturnType<typeof parseDialogueJson> | null = null
    const MAX_ATTEMPTS = 3
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // 重置流式累积状态，避免上一次尝试的残片混入
      partial = ''
      lastDisplayLen = 0
      speechCursor = 0
      pendingBlock = null
      // 旁白前置状态一并重置：重试轮从头流式，渲染端已前置的旁白需清空重新接收
      resetNarrationState()
      let reasoningText = ''
      rawOutput = await sendChatCompletion(attemptMessages, {
        model: settings.model,
        baseURL: settings.baseURL,
        apiKey,
        temperature: settings.temperature,
        maxTokens: effectiveMaxTokens,
        stream: settings.stream,
        signal: abort.signal,
        onChunk: (chunk) => {
          voiceActiveRef = voiceActive
          partial += chunk
          if (!chunkTimer) chunkTimer = setTimeout(flushChunks, CHUNK_FLUSH_MS)
          if (!mergeSpeech) pumpSpeech()
        },
        onReasoning: (chunk) => {
          reasoningText += chunk
        },
      })
      parsed = parseDialogueJson(stripThink(rawOutput))
      if (!parsed.text.trim() && reasoningText.trim()) {
        // content 通道为空但思考通道有内容：模型可能把最终 JSON 写进思考里了。
        // 能完整解析出正文就直接用，免去一次完整重试（首回复延迟减半）。
        const salvaged = salvageDialogueFromText(reasoningText)
        if (salvaged) {
          console.log('[chat] content 为空，已从思考通道提取到回复（免重试）')
          parsed = salvaged
        }
      }
      if (parsed.text.trim()) break
      if (attempt < MAX_ATTEMPTS) {
        console.warn(
          '[chat] 第 %d 次回复为空（content %d 字 / reasoning %d 字，raw=%j），附加纠正提示后自动重试',
          attempt,
          rawOutput.length,
          reasoningText.length,
          String(rawOutput || reasoningText).slice(0, 120),
        )
        attemptMessages = [
          ...baseMessages,
          { role: 'assistant', content: '（空回复）' },
          { role: 'user', content: '你的上一条回复是空的。请严格按【输出格式】直接输出 JSON 正文，不要输出任何思考过程，也不要输出空内容。' },
        ] as ChatMessage[]
      }
    }
    if (!parsed || !parsed.text.trim()) {
      throw new Error('AI 连续返回空回复（可能被截断或仅输出思考内容），请稍后重试')
    }

    // 流式结束：清空定时器并 flush 残余文本，保证最后一段也送达
    if (chunkTimer) {
      clearTimeout(chunkTimer)
      chunkTimer = null
    }
    flushChunks()
    // 结算最后一个未闭合的情绪块
    flushPendingBlock()
    // 未触发"边生成边读"时兜底：整段文本生成完毕后触发语音
    if (!speechEmitted && voiceActive && card) {
      const parsed = parseDialogueJson(rawOutput)
      const langOverride = card.ttsOverride?.language ?? null
      const voiceId = voiceEngine === 'mimo' ? card.voiceId : null
      if (mergeSpeech) {
        // 兜底投放同样剥掉已前置上屏的开头旁白，剥空（整条回复全是前置旁白）则不发声
        const mergedText = consumeLeadingNarration(parsed.text, narrationGroups, narrationCursor)
        if (mergedText.trim()) {
          windowManager.speak(mergedText, voiceId, langOverride, {
            chunks: [{ text: mergedText, emotion: parsed.emotion }],
            follow: true,
            engine: voiceEngine ?? undefined,
            genieOverride,
          })
        }
      } else {
        for (const c of parsed.chunks) {
          const chunkText = consumeLeadingNarration(c.text, narrationGroups, narrationCursor)
          if (!chunkText.trim()) continue // 纯前置旁白块：旁白已上屏，无需合成
          windowManager.speak(chunkText, voiceId, langOverride, { chunks: [{ text: chunkText, emotion: c.emotion }], follow: true, engine: voiceEngine ?? undefined, genieOverride })
        }
      }
    }

    // 持久化：user 消息 + assistant 完整回复（剧情轮次写 run 文件，普通聊天写会话）
    const now = Date.now()
    console.log('[thinking] parseDone needExitThinking=%s voiceActive=%s speechEmitted=%s', needExitThinking, voiceActive, speechEmitted)
    if (!store && needExitThinking && !voiceActive) {
      needExitThinking = false
      console.log('[thinking] no-voice fallback: exit thinking')
      windowManager.notifyThinking(false)
    }
    const { text, emotion, sentences, emotionSegments, chunks, background } = parsed!
    // 剧情轮次：透传模型输出的可选 background 键（引擎校验后走现有背景通道，设计文档 7.3）
    const asstMsg: ChatMessage = {
      role: 'assistant',
      content: text,
      emotion,
      sentences,
      emotionSegments,
      chunks,
      timestamp: now,
      meta: store ? { story: true, storyBackground: background } : undefined,
    }
    if (store) await store.append([userMsg, asstMsg])
    else await appendSessionMessages(sessionId, [userMsg, asstMsg])

    // 记忆自动沉淀（后台，不阻塞）：proactive 旁白轮次与剧情轮次（store 覆盖）跳过；旁白消息不参与抽取
    if (settings.enableMemoryExtraction && !store && !meta?.proactive) {
      const extractable = history.filter((m) => !m.meta?.proactive)
      void extractMemoriesFromSession({
        sessionId,
        cardId: card?.id ?? '',
        messages: [...extractable, userMsg, asstMsg],
        settings: { model: settings.model, baseURL: settings.baseURL, apiKey },
      })
    }

    if (!store) windowManager.broadcastAI('ai:stream-done', { sessionId, message: asstMsg })
    // 立绘/表情驱动策略：有语音由语音块驱动；无语音由文本输出驱动（剧情轮次桌宠零参与）
    if (!store && !voiceActive) windowManager.notifyEmotion(emotion)
    return asstMsg
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)

    // 出错/取消时也持久化 user 消息（携带错误信息，供渲染端「未收到回复」提示展示具体原因）
    // 与已流出的部分回复，避免 UI 与磁盘状态分叉
    try {
      const failedUser: ChatMessage = { ...userMsg, error: message }
      const extra: ChatMessage[] = [failedUser]
      if (partial) extra.push({ role: 'assistant', content: extractStreamingJsonText(partial), timestamp: Date.now() })
      if (store) await store.append(extra)
      else await appendSessionMessages(sessionId, extra)
    } catch {
      // 持久化失败不影响错误上报
    }

    // 出错/取消前 flush 残余文本，让已流出的部分也上屏
    if (chunkTimer) {
      clearTimeout(chunkTimer)
      chunkTimer = null
    }
    flushChunks()

    if (!store) windowManager.broadcastAI('ai:stream-error', { sessionId, error: message, cancelled: abort.signal.aborted })
    throw err
  } finally {
    if (currentAbort === abort) currentAbort = null
    // 流式结束/出错/取消：清除"进行中的流"标记，避免窗口在之后才就绪时误认领已结束的会话
    if (!store) windowManager.setActiveStreamingSession(null)
    // 退出思考立绘：仅无语音场景在此复位（有语音场景由渲染端 lipSync 播放时负责）；剧情轮次桌宠零参与
    console.log('[thinking] finally voiceActiveRef=%s needExitThinking=%s', voiceActiveRef, needExitThinking)
    if (!store && !voiceActiveRef && needExitThinking) {
      needExitThinking = false
      windowManager.notifyThinking(false)
    }
  }
}

