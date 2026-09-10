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
import { parseDialogueJson, extractStreamingJsonText, extractDialogueChunkDelta } from './emotion'
import { buildModelContext, SUMMARY_MAX_TOKENS, toModelMessage } from './context'
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
  sessionId: string
  /** 本轮 user 消息文本（普通聊天 = 用户输入；主动搭话 = 系统旁白） */
  content: string
  /** 消息来源标记（落盘 + stream-user 广播携带） */
  meta?: ChatMessageMeta
}

/**
 * 执行一轮完整聊天：旁白/用户消息入史 → 流式生成 → 语音跟读 → 持久化 → 记忆沉淀。
 * @returns 落盘的 assistant 消息；出错时向渲染端广播 stream-error 后 rethrow
 */
export async function runChatTurn(params: ChatTurnParams): Promise<ChatMessage> {
  const { sessionId, content, meta } = params
  if (!content.trim()) throw new Error('消息内容为空')

  const userMsg: ChatMessage = { role: 'user', content, timestamp: Date.now(), meta }
  let partial = ''

  // 广播本轮的 user 消息，让跟随窗口（非发起方）也能立刻补上用户气泡，
  // 无需等 stream-done 全量拉取才出现（否则跟随窗口会缺用户消息、且中途消息闪变）
  windowManager.broadcastAI('ai:stream-user', { sessionId, content: userMsg.content, timestamp: userMsg.timestamp, meta: meta ?? null })
  // 记录"进行中的流"所属会话：窗口重载/新建后就绪时补发用于认领，避免漏该轮事件
  windowManager.setActiveStreamingSession(sessionId)

  // 进入"思考中"：通知桌宠切换到思考立绘
  windowManager.notifyThinking(true)
  // 首个可读文本块到达后即退出思考立绘（见 flushChunks）的一次性标记
  let needExitThinking = true
  // 语音是否启用（由 onChunk 在 voiceActive 求值后同步，供 flushChunks 闭包安全读取）
  let voiceActiveRef = false

  // 合并推送：把模型原始输出实时提取成纯净台词文本，累积后按 CHUNK_FLUSH_MS 窗口一次性 send，
  // 避免把 JSON（花括号/键名）暴露给聊天窗，也减少 IPC 往返。lastDisplayLen 用于只发新增片段。
  let lastDisplayLen = 0
  let chunkTimer: NodeJS.Timeout | null = null
  const flushChunks = () => {
    chunkTimer = null
    const display = extractStreamingJsonText(partial)
    const delta = display.length > lastDisplayLen ? display.slice(lastDisplayLen) : ''
    lastDisplayLen = Math.max(lastDisplayLen, display.length)
    if (delta) {
      windowManager.broadcastAI('ai:stream-chunk', delta)
      // 未启用语音：思考立绘显示到首个文本开始输出（首个可读文本块即退出）
      if (!voiceActiveRef && needExitThinking) {
        needExitThinking = false
        windowManager.notifyThinking(false)
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
    const session = await getSession(sessionId)
    const card = await getCharacterCard(session.characterCardId)
    const retrieval = await retrieveMemories(session.characterCardId, content, MAX_MEMORIES)
    const systemMessage: ChatMessage = {
      role: 'system',
      content: buildSystemPrompt(card, retrieval.items, settings.userName, retrieval.profileDigest, settings.enableProactive),
    }
    console.log('[memory] 注入模式=%s 条数=%d 画像=%s', retrieval.mode, retrieval.items.length, retrieval.profileDigest ? 'yes' : 'no')

    // A1+A2 上下文组装：磁盘历史（含旁白消息，作为对话上下文的一部分）+ 本轮 user 消息 → 净化 → 预算装填/自动摘要
    const history = session.messages
    const modelMessages = [...history, userMsg].map(toModelMessage)
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
      enableAutoCompact: settings.enableAutoCompact,
      summarize,
    })
    const fullMessages = ctx.messages
    // 摘要落盘复用（失败静默，不影响本轮请求）
    if (ctx.newSummary) {
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
    // 广播上下文 token 用量给桌宠窗显示（会话收放按钮旁）
    windowManager.broadcastAI('ai:context-stats', {
      sessionId,
      system: estimateMessagesTokens([systemMessage]),
      history: estimateMessagesTokens(modelMessages),
      total: estimateMessagesTokens(fullMessages),
      window: settings.contextWindowTokens,
    })

    // ---- 语音生成策略（始终跟读文本） ----
    const effMode = card?.voiceMode ?? (card?.voiceId ? 'mimo' : 'none')
    const voiceEngine: 'genie' | 'mimo' | null =
      effMode === 'genie' ? 'genie' : effMode === 'mimo' ? 'mimo' : null
    const voiceActive =
      effMode === 'genie' ? true : effMode === 'mimo' ? !!card?.voiceId : false
    const genieOverride = effMode === 'genie' ? (card?.genieOverride ?? null) : null
    // 流式一开始即广播本轮语音模式，让宠物窗提前用跟读展示方式
    windowManager.notifyVoiceMode({ voiceEnabled: voiceActive })
    let speechCursor = 0
    let pendingBlock: { texts: string[]; emotion: StandardEmotion } | null = null
    /** 是否已通过流式触发过至少一次语音（用于非流式/分块失败的兜底判定） */
    let speechEmitted = false
    // 结算当前情绪块并触发桌宠语音（语音启用时才发声）
    const flushPendingBlock = () => {
      const b = pendingBlock
      pendingBlock = null
      if (!b || b.texts.length === 0 || !card || !voiceActive) return
      speechEmitted = true
      const text = b.texts.join('\n')
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
    const rawOutput = await sendChatCompletion(fullMessages, {
      model: settings.model,
      baseURL: settings.baseURL,
      apiKey,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      stream: settings.stream,
      signal: abort.signal,
      onChunk: (chunk) => {
        voiceActiveRef = voiceActive
        partial += chunk
        if (!chunkTimer) chunkTimer = setTimeout(flushChunks, CHUNK_FLUSH_MS)
        if (!mergeSpeech) pumpSpeech()
      },
    })

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
        windowManager.speak(parsed.text, voiceId, langOverride, {
          chunks: [{ text: parsed.text, emotion: parsed.emotion }],
          follow: true,
          engine: voiceEngine ?? undefined,
          genieOverride,
        })
      } else {
        for (const c of parsed.chunks) {
          windowManager.speak(c.text, voiceId, langOverride, { chunks: [c], follow: true, engine: voiceEngine ?? undefined, genieOverride })
        }
      }
    }

    // 持久化：user 消息 + assistant 完整回复
    const now = Date.now()
    console.log('[thinking] parseDone needExitThinking=%s voiceActive=%s speechEmitted=%s', needExitThinking, voiceActive, speechEmitted)
    if (needExitThinking && !voiceActive) {
      needExitThinking = false
      console.log('[thinking] no-voice fallback: exit thinking')
      windowManager.notifyThinking(false)
    }
    const { text, emotion, sentences, emotionSegments, chunks } = parseDialogueJson(rawOutput)
    const asstMsg: ChatMessage = { role: 'assistant', content: text, emotion, sentences, emotionSegments, chunks, timestamp: now }
    await appendSessionMessages(sessionId, [userMsg, asstMsg])

    // 记忆自动沉淀（后台，不阻塞）：proactive 旁白轮次跳过；历史中的旁白消息也不参与抽取
    if (settings.enableMemoryExtraction && !meta?.proactive) {
      const extractable = history.filter((m) => !m.meta?.proactive)
      void extractMemoriesFromSession({
        sessionId,
        cardId: session.characterCardId,
        messages: [...extractable, userMsg, asstMsg],
        settings: { model: settings.model, baseURL: settings.baseURL, apiKey },
      })
    }

    windowManager.broadcastAI('ai:stream-done', { sessionId, message: asstMsg })
    // 立绘/表情驱动策略：有语音由语音块驱动；无语音由文本输出驱动
    if (!voiceActive) windowManager.notifyEmotion(emotion)
    return asstMsg
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)

    // 出错/取消时也持久化 user 消息（携带错误信息，供渲染端「未收到回复」提示展示具体原因）
    // 与已流出的部分回复，避免 UI 与磁盘状态分叉
    try {
      const failedUser: ChatMessage = { ...userMsg, error: message }
      const extra: ChatMessage[] = [failedUser]
      if (partial) extra.push({ role: 'assistant', content: extractStreamingJsonText(partial), timestamp: Date.now() })
      await appendSessionMessages(sessionId, extra)
    } catch {
      // 持久化失败不影响错误上报
    }

    // 出错/取消前 flush 残余文本，让已流出的部分也上屏
    if (chunkTimer) {
      clearTimeout(chunkTimer)
      chunkTimer = null
    }
    flushChunks()

    windowManager.broadcastAI('ai:stream-error', { sessionId, error: message, cancelled: abort.signal.aborted })
    throw err
  } finally {
    if (currentAbort === abort) currentAbort = null
    // 流式结束/出错/取消：清除"进行中的流"标记，避免窗口在之后才就绪时误认领已结束的会话
    windowManager.setActiveStreamingSession(null)
    // 退出思考立绘：仅无语音场景在此复位（有语音场景由渲染端 lipSync 播放时负责）
    console.log('[thinking] finally voiceActiveRef=%s needExitThinking=%s', voiceActiveRef, needExitThinking)
    if (!voiceActiveRef && needExitThinking) {
      needExitThinking = false
      windowManager.notifyThinking(false)
    }
  }
}

