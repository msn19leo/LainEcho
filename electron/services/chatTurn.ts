/**
 * 聊天轮次核心（从 ai.ipc.ts 的 send-message 处理器抽取，供两个入口复用）：
 *  1. 渲染端 IPC（用户在聊天窗/宠物窗发消息）
 *  2. 主动搭话调度器（主进程自触发，旁白作为 user 消息入史）
 *
 * 职责不变：组装 system prompt（Section 树 + 记忆检索）→ A1/A2 上下文 → 流式请求 →
 * 状态块结算 → TTS 跟读 → 持久化（user+assistant）→ 记忆沉淀（后台）。
 * 与原实现的行为差异（均为主动搭话所需，用户路径不受影响）：
 *  - 模型上下文改为「磁盘会话历史 + 本轮 user 消息」，不再信任渲染端传入的消息列表；
 *  - user 消息可携带 meta 标记（proactive/story）落盘并随 stream-user 广播；
 *  - proactive 轮次跳过记忆抽取，且历史中的 proactive 旁白消息一律不参与抽取。
 */
import type { ChatMessage, ChatMessageMeta } from '../../src/types'
import { sendChatCompletion } from './aiClient'
import { parseDialogueJson, extractStreamingJsonText, extractDialogueChunkDelta, salvageDialogueFromText, consumeLeadingNarration, stripParenGroups, emotionAdherence, splitLeadingNarrGroups, extractScriptChunkDelta, prepareScriptPartial, stripStreamWrappers } from './emotion'
import { buildModelContext, SUMMARY_MAX_TOKENS, toModelMessage, type ModelMessage } from './context'
import { estimateMessagesTokens } from './token'
import { getTTSConfig } from '../ipc/tts.ipc'
import { resolveProfile, type ResolvedLlmConfig } from './apiProfiles'
import { resolveAuxLlmConfig } from './auxModel'
import { buildSceneSection, buildCharacterBrief, updateSceneDigestAfterTurn } from './sceneContext'
import { extractMemoriesFromSession } from './memoryExtraction'
import {
  appendSessionMessages,
  buildSystemPrompt,
  getCharacterCard,
  getModelPalette,
  getModelSettings,
  getSpritePalette,
  getSession,
  getSettings,
  updateSessionSummary,
} from './repository'
import type { EmotionPaletteRef } from '../../src/types'
import { retrieveMemories } from './memory/retriever'
import { windowManager } from '../windows/windowManager'
import * as turnCoordinator from './turnCoordinator'

/**
 * ① 历史格式示范轮数：最近 N 条 assistant 消息以紧凑 dialogue JSON 回传给模型。
 * 根因（2026-10-15 结构修复高频触发）：落库 assistant.content 是解析后纯文本，回传历史
 * 全是「（旁白）台词（旁白）台词」形态，JSON 契约只在 system prompt 一处——会话越长，
 * 纯文本历史的 few-shot 诱导力越强，压过纸面契约 → 模型漂移到引号剧本/退化 JSON。
 * 回传 JSON 示范让 few-shot 从"诱导漂移"反转为"锚定格式"。只取最近 N 条控 token 预算。
 */
const HISTORY_JSON_TURNS = 6

/**
 * ⑤ 尾部格式提醒（不落盘）：追加在请求 messages 末尾（最后一条 user 之后，离生成点最近）。
 * Shinsekai 式收尾契约（closing_json_reminder）放在 system 段末尾——长会话下仍会被 history
 * 稀释；放 messages 尾部权重最高。与 ① 历史格式示范（最近 N 条 JSON few-shot）构成双保险，
 * 压制长会话 JSON 漂移（2026-10-20 00:46 轮实锤：msgs 47 起连续 8 轮直通、状态词恒默认）。
 * 仅组装层动态注入：不进落盘历史、不影响记忆检索（与时间戳前缀同一策略）。
 */
const TAIL_FORMAT_REMINDER =
  '【格式提醒】你的整条回复必须且只能是一个 JSON 对象：{"dialogue":[{"text":"台词或旁白","emotion":"状态词","kind":"speak 或 narr"}]}——"emotion" 只能从角色状态词表中选取，kind="narr" 的 "text" 必须用圆括号（）完整包裹；除该 JSON 外一个字都不要输出（禁止 markdown 围栏、解释、开场白与后记）。'

/**
 * ① 历史格式示范：把最近 N 条含 chunks 的 assistant 消息改写为紧凑 dialogue JSON 内容。
 * 无 chunks（剧情/旁白/旧消息）与 proactive 旁白自然跳过；JSON.stringify 紧凑序列化零空白。
 * 配额从**尾部**向前收集（2026-10-20 bug 修复）：旧实现 map 旧→新遍历先消耗配额，JSON 示范
 * 落在 history 最开头——会话变长后离生成点数千字符，最近几十条全是纯文本 few-shot，诱导力
 * 反转压过契约（2026-10-20 00:46 轮实锤：msgs 47 起连续 8 轮漂移直通，msgs<45 时全 JSON）。
 */
function backfillHistoryJson(history: ChatMessage[]): ChatMessage[] {
  /** 命中索引 → JSON 内容（先收集再改写，遍历顺序不影响配额归属） */
  const rewrite = new Map<number, string>()
  for (let i = history.length - 1; i >= 0 && rewrite.size < HISTORY_JSON_TURNS; i--) {
    const m = history[i]!
    if (m.role !== 'assistant' || m.meta?.proactive) continue
    const chunks = (m.chunks ?? []).filter((c) => typeof c.text === 'string' && c.text.trim())
    if (chunks.length === 0) continue
    rewrite.set(i, JSON.stringify({ dialogue: chunks.map((c) => ({ text: c.text, emotion: c.emotion, kind: c.kind ?? 'speak' })) }))
  }
  if (rewrite.size === 0) return history
  return history.map((m, i) => {
    const json = rewrite.get(i)
    return json ? { ...m, content: json } : m
  })
}

/** 方案1 轮间间隔标注已移除（2026-10-16）：被逐条绝对时间前缀取代——
 *  绝对时刻下模型可自行推导时长，相对跳转标注冗余 */

/**
 * 时间感知（Shinsekai 式逐条绝对时间，2026-10-16）：给每条 user 消息按**自身 timestamp** 注入
 * `[YYYY-MM-DD HH:mm:ss]` 独立行前缀。历史消息携带"当时的时刻"，"现在几点/我们聊了多久/
 * 开始说话时几点"均可从历史推导（2026-10-16 00:23 轮实锤：模型被问时间时只能按场景编造）。
 *
 * 关键设计：前缀在**组装层动态生成**而非持久化——落盘内容不变，记忆检索发生在组装前、
 * 用原始 content，天然无嵌入污染（Shinsekai 因持久化前缀需要额外的剥前缀防御，本方案不需要）。
 * 仅标 user 消息（assistant 时刻可由前后 user 消息推导，省 token）；**剧情轮次不标**（故事
 * 时间轴优先，真实时间戳会干扰剧情沉浸）。user 消息不被 ①JSON 示范改写（只作用 assistant），
 * 前缀无冲突。总开关关闭时原样返回。
 */
function annotateUserTimestamps(messages: ChatMessage[], enabled: boolean, isStory: boolean): ChatMessage[] {
  if (!enabled || isStory) return messages
  return messages.map((m) => {
    if (m.role !== 'user' || typeof m.timestamp !== 'number' || m.timestamp <= 0) return m
    const d = new Date(m.timestamp)
    const ts = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
    return { ...m, content: `[${ts}]\n${m.content}` }
  })
}

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
 * @param cfg 主模型激活档案解析出的生效三元组（摘要跟随主模型）
 */
export function createSummarizer(cfg: ResolvedLlmConfig, signal?: AbortSignal) {
  return async (olderText: string): Promise<string> => {
    const summary = await sendChatCompletion(
      [
        { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: `以下是对话历史：\n${olderText}\n\n请输出总结：` },
      ],
      {
        model: cfg.model,
        baseURL: cfg.baseURL,
        apiKey: cfg.apiKey,
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

/** 主进程合并 chunk 的 flush 间隔（毫秒）：多个 delta 合并为一次 IPC 推送，减少消息数 */
const CHUNK_FLUSH_MS = 16
/** 单个"状态块"最多合并的 dialogue 项数：超过即提前结算，保持在"边生成边读"的实时性，避免单块越长越延迟出声 */
const BLOCK_MAX_ITEMS = 3
/**
 * ② 漂移探测阈值（可见正文字符数）：剥掉思考/围栏后累积到此长度仍无任何 `{`，
 * 判定模型放弃 JSON 契约（剧本/纯文本漂移）→ 切纯文本直通。正常 JSON 输出的 `{`
 * 在头几个 token 就出现，200 字判据不会误伤。
 */
const DRIFT_PROBE_CHARS = 200

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
   * 状态词表来源立绘集 id（可选覆盖）：剧情轮传 run.spriteId（演出词表），
   * 普通聊天缺省用角色卡绑定的 spriteId。决定 emotion 输出值域与解析链。
   */
  spriteId?: string | null
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

/** 轮次执行互斥标志（重答/发送的并发防护用）：runChatTurn 任何调用方（用户消息/主动搭话/剧情）
 *  在执行期间置位。消息重答（ai:regenerate）据此拒绝"轮次进行中"的重答请求。 */
let turnBusyCount = 0

/** 当前是否有轮次在执行（LLM 流式/持久化阶段；语音朗读在 runChatTurn 返回后由宠物窗继续） */
export function isTurnBusy(): boolean {
  return turnBusyCount > 0
}

/**
 * 执行一轮完整聊天：旁白/用户消息入史 → 流式生成 → 语音跟读 → 持久化 → 记忆沉淀。
 * @returns 落盘的 assistant 消息；出错时向渲染端广播 stream-error 后 rethrow
 */
export async function runChatTurn(params: ChatTurnParams): Promise<ChatMessage> {
  turnBusyCount++
  try {
    return await runChatTurnInner(params)
  } finally {
    turnBusyCount--
  }
}

async function runChatTurnInner(params: ChatTurnParams): Promise<ChatMessage> {
  const { sessionId, content, meta, storyDirective, store, spriteId: spriteIdOverride } = params
  if (!content.trim()) throw new Error('消息内容为空')

  const userMsg: ChatMessage = { role: 'user', content, timestamp: Date.now(), meta }
  let partial = ''

  // 广播本轮的 user 消息，让跟随窗口（非发起方）也能立刻补上用户气泡，
  // 无需等 stream-done 全量拉取才出现（否则跟随窗口会缺用户消息、且中途消息闪变）
  // 剧情轮次（store 覆盖）：完全不经由 ai:stream-* 通道（聊天/宠物窗与剧情彻底隔离），
  // 剧情窗由 story:message 增量同步驱动
  if (!store) {
    windowManager.broadcastAI('ai:stream-user', { sessionId, content: userMsg.content, timestamp: userMsg.timestamp, meta: meta ?? null })
    // 记录"进行中的流"所属会话：窗口重载/新建后就绪时补发用于认领，避免漏该轮事件（剧情 run 无此需求）。
    // user 载荷一并记录：user 消息回合结束才落盘，中途打开的窗口认领时补气泡（否则缺用户消息）。
    // 时间戳兜底：userMsg.timestamp 理论上必有，防御 undefined 不符合 StreamUserPayload 契约
    const userPayload = { sessionId, content: userMsg.content, timestamp: userMsg.timestamp ?? Date.now(), meta: meta ?? null }
    windowManager.setActiveStreamingSession(sessionId, '', userPayload)
    // 方案A：开启回合文档（仅普通聊天轮；剧情轮 store 门隔离零接触）。
    // voice 标记本轮是否有语音跟读：有语音 → 渲染端文本揭示由语音进度门控（段随语音显示）。
    // 注意：此处置基于 settings 尚未加载的保守估计，settings 加载后在第一次 flush 前已由
    // beginTurn 的调用时序保证（beginTurn 在 settings 读取后无法回调），因此这里以
    // card 未加载前的默认值先建文档，语音可用性由下文 voiceActive 求值后经 markVoice 修正。
    turnCoordinator.beginTurn(sessionId, { content: userMsg.content, timestamp: userPayload.timestamp, meta: meta ?? null }, false)
  }

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
  // ---- 「回答仅含台词」括号剥除（普通聊天专用；剧情 store 与主动搭话 meta.proactive 豁免）----
  // settings 在下方 try 块内加载后赋值；闭包首次调用发生在 onChunk/flush 时，届时必已赋值
  let stripParen = false
  const maybeStrip = (t: string): string => (stripParen ? stripParenGroups(t) : t)
  // ---- 开头括号剥除状态（旧契约兼容：模型把开头旁白括号带进 speak 项时防重复朗读）----
  // 新契约（kind 字段）下旁白是独立 narr 项走 displayOnly，不再有前置通道；此状态仅剩
  // "旧习惯输出把（）写进 speak 项"时的防重复职责，narr 项不经过它。
  /** 前置旁白的括号组数组（speak 语音块剥除用，逐组消费） */
  let narrationGroups: string[] = []
  /** 语音块已消费的组数游标（跨块推进） */
  let narrationCursor = { count: 0 }

  /** 重置括号剥除状态（空回复重试轮从头流式时调用）。前置流已退役，无需广播 reset。 */
  const resetNarrationState = () => {
    narrationGroups = []
    narrationCursor = { count: 0 }
  }

  // ---- ② 漂移探测与纯文本直通状态（尝试轮内重置，见 attempt 循环）----
  /** 已判定为剧本漂移：三条 JSON 提取链对纯文本恒零产出，切直通提取（括号/标点规则） */
  let driftMode = false
  /** 探测已出结论（命中或排除），不再重复探测 */
  let driftChecked = false
  /** ④ 观测：本轮流式起始时刻 / 首个 chunk 到达时刻（漂移判定与耗时归因用） */
  let streamStartAt = 0
  let firstChunkAt = 0

  /** ② 直通模式的提取源：剥思考/围栏 + 尾围栏。对游标安全：只动未被消费的尾部区域，
   *  文档切片与语音链都必须用同一整形源，游标语义才一致 */
  const scriptSource = () => prepareScriptPartial(partial)

  /** ② 漂移探测（flushChunks 每帧调用，廉价）：可见正文 ≥ DRIFT_PROBE_CHARS 且不含 `{` → 直通 */
  const probeDrift = () => {
    if (driftChecked) return
    const visible = stripStreamWrappers(partial)
    if (visible.length < DRIFT_PROBE_CHARS) return
    driftChecked = true
    if (visible.includes('{')) {
      console.log('[diag] 漂移探测：前 %d 字含 JSON 结构字符，维持 JSON 提取链', visible.length)
      return
    }
    driftMode = true
    if (!store) turnCoordinator.beginScriptMode()
    console.log('[diag] 漂移判定：前 %d 字可见文本无 JSON 结构（不含 {）→ 纯文本直通（跳过结构修复）', visible.length)
  }

  /** 方案A：文档切片用的状态词表（try 块内加载后设置；此前切片用内置词表兜底） */
  let turnPalette: import('../../src/types').EmotionPaletteRef | null = null

  const flushChunks = () => {
    chunkTimer = null
    probeDrift()
    // 方案A单源：同一 partial 喂给文档状态机——两窗直播显示的唯一数据源。
    // 【剧情隔离】syncFromPartial 必须在 store 门内：剧情轮次不创建文档也不喂切片，
    // 否则剧情内容会经快照泄漏到桌宠窗/聊天窗（2026-10-14 01:14 日志实锤）
    if (!store) {
      // 台词模式：文档切片与定型/语音链**同口径剥除（）组**——文档保留旁白会让直播期间
      // 显示旁白、语音播完落定型（已剥）后消失（2026-10-14 22:46 轮实锤），且旁白不产生
      // 语音槽位、文档总量却计入旁白字符，进度上限少报。stripParenGroups 只删字符串值里的
      // 括号组，不碰 JSON 结构字符；未闭合的书写中组同样剥除，闭合前后保持单调。
      // ② 直通模式：JSON 闭合切片器恒零产出，改走括号/标点规则切片（docPartial 已按
      // 台词模式剥括号，直通提取器在其中只产出 speak 项，与定型口径一致）
      if (driftMode) {
        const docFresh = turnCoordinator.syncFromPartialScript(scriptSource(), turnPalette)
        void docFresh
      } else {
        const docPartial = stripParen ? stripParenGroups(partial) : partial
        const docFresh = turnCoordinator.syncFromPartial(docPartial, turnPalette)
        void docFresh
      }
    }
    // ② 直通模式显示源 = 整形后的纯文本（extractStreamingJsonText 对无 text 键文本回放
    // 原文，但直接用整形源语义更明确）；认领快照与剧情预览共用该值
    const display = driftMode ? maybeStrip(scriptSource()) : maybeStrip(extractStreamingJsonText(partial))
    // 提取回退监测：display 长度比上次短 = trailing→out 交接或转义边界导致提取回退，
    // lastDisplayLen 卡高水位后 delta 跳段 → 流式文本永久缺段（保留 warn 便于诊断）
    if (display.length < lastDisplayLen) {
      console.warn(
        '[stream] 流式提取回退：上次=%d 本次=%d 回退差=%d 帧=%j',
        lastDisplayLen,
        display.length,
        lastDisplayLen - display.length,
        display.slice(0, 48),
      )
    }
    const delta = display.length > lastDisplayLen ? display.slice(lastDisplayLen) : ''
    lastDisplayLen = Math.max(lastDisplayLen, display.length)
    // 累积显示快照同步给窗口管理器：中途就绪（打开/重载）的窗口认领会话时补发，
    // 让晚开的窗口立即对齐流式进度而不是空泡干等（2026-10-13 截图案例）
    if (!store) windowManager.setActiveStreamDisplay(display)
    if (delta) {
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
  }

  const abort = new AbortController()
  currentAbort = abort
  try {
    const settings = await getSettings()
    stripParen = settings.stripParenNarration && !store && !meta?.proactive
    const ttsCfg = await getTTSConfig()
    // 整段合音：开启时主进程关闭"边生成边读"，流式结束后整段一次合成（音调连贯）；关闭时保持逐句实时朗读
    const mergeSpeech = ttsCfg.mergeSpeech === true
    // 主模型三元组走档案解析（档案制）：未激活档案或地址/模型/Key 不完整时报错
    const mainCfg = await resolveProfile('main')
    if (!mainCfg) throw new Error('未配置主模型（地址/模型/Key 需完整），请先在「设置 → AI API 配置」中选择并配置档案')

    // 组装 system prompt：人设字段 + 示例对话 + 记忆注入
    // 记忆来源由检索器决定：向量模式（语义检索 top-k + 画像/约定常驻）或降级模式（最近 N 条，旧行为）
    // 剧情轮次（store 覆盖）：角色卡从 run 取，跳过会话读取与记忆检索（剧情与记忆系统隔离）
    let card
    let history: ChatMessage[]
    let retrievalItems: import('../../src/types').MemoryItem[] = []
    let profileDigest: string | null = null
    /** 记忆检索模式（vector=向量分池检索 / recent=降级分层最近）：日志观测用 */
    let memoryRetrievalMode: 'vector' | 'recent' = 'recent'
    /** 本会话的场景摘要缓存（情境服务 Phase 1；剧情轮次不参与） */
    let prevSceneDigest: string | undefined
    if (store) {
      card = await getCharacterCard(store.cardId)
      history = store.history
    } else {
      const session = await getSession(sessionId)
      card = await getCharacterCard(session.characterCardId)
      const retrieval = await retrieveMemories(session.characterCardId, content)
      retrievalItems = retrieval.items
      profileDigest = retrieval.profileDigest
      memoryRetrievalMode = retrieval.mode
      history = session.messages
      prevSceneDigest = session.sceneDigest
    }
    // 状态词表分轨（演出词表双轨对等）：演出形象二选一，词表跟着形象走——
    // sprite 模式 → 立绘集词表（剧情轮恒 sprite：run.spriteId > 角色卡绑定 > 全局选中）；
    // live2d 模式 → Live2D 模型词表（角色卡绑定模型 > 全局选中模型）。
    // 模式判定与渲染端同口径：角色卡显式 renderMode > 全局形象（selectedSpriteId 非空 = sprite）。
    // 两轨词表为空都落内置最小词表（仅"平静"），永不返回 null。
    const modelSettings = await getModelSettings()
    const paletteMode: 'live2d' | 'sprite' = store
      ? 'sprite'
      : (card?.renderMode ?? (modelSettings.selectedSpriteId ? 'sprite' : 'live2d'))
    let emotionPalette: EmotionPaletteRef
    if (paletteMode === 'live2d') {
      const modelId = card?.modelId ?? modelSettings.selectedModelId ?? null
      emotionPalette = await getModelPalette(modelId)
      console.log(
        '[chat] 状态词表 mode=live2d model=%s（%d 词，默认「%s」）',
        modelId ?? '无',
        emotionPalette.entries.length,
        emotionPalette.defaultEmotion,
      )
    } else {
      const emotionSpriteId = spriteIdOverride ?? card?.spriteId ?? modelSettings.selectedSpriteId ?? null
      emotionPalette = await getSpritePalette(emotionSpriteId)
      console.log(
        '[chat] 状态词表 mode=sprite sprite=%s（%d 词，默认「%s」）',
        emotionSpriteId ?? '无',
        emotionPalette.entries.length,
        emotionPalette.defaultEmotion,
      )
    }
    // 方案A：词表就绪后交给文档切片（此后新入稿分段用正式词表归一化 emotion）
    turnPalette = emotionPalette
    const systemMessage: ChatMessage = {
      role: 'system',
      content: buildSystemPrompt(
        card,
        retrievalItems,
        settings.userName,
        profileDigest,
        settings.enableProactive,
        storyDirective,
        stripParen,
        emotionPalette,
        settings.timeAwarenessEnabled,
        // 情境 Section（情境服务 Phase 1）：仅普通聊天轮注入（剧情轮次不参与）
        !store && settings.enableSceneDigest ? buildSceneSection(prevSceneDigest) : null,
      ),
    }
    if (!store) {
      console.log('[memory] 注入条数=%d 画像=%s 模式=%s（分层：约定≤10 事实≤5 经历≤8）', retrievalItems.length, profileDigest ? 'yes' : 'no', memoryRetrievalMode)
    }

    // A1+A2 上下文组装：历史（剧情 = run.messages）+ 本轮 user 消息 → 净化 → 预算装填/自动摘要
    // proactive 旁白消息在此附加系统旁白标记（历史中的旁白同样处理，见 toModelMessageWithNarration）
    // ① 历史格式示范：最近 N 条 assistant 以紧凑 dialogue JSON 回传（见 backfillHistoryJson 注释）
    // 时间感知（Shinsekai 式逐条绝对时间）：user 消息按自身 timestamp 注入时刻前缀（剧情轮豁免，
    // 见 annotateUserTimestamps 注释）；userMsg 带当前时间戳，本轮"现在几点"由此锚定
    const timeAwareMessages = annotateUserTimestamps([...backfillHistoryJson(history), userMsg], settings.timeAwarenessEnabled, !!store)
    const modelMessages = timeAwareMessages.map(toModelMessageWithNarration)
    // 当前时间已由 system prompt 的【当前真实时间】Section 权威声明（见 repository.buildSystemPrompt），
    // user 消息前缀链已移除——避免双时间源竞争与 24h→12h 制换算幻觉
    const summarize = createSummarizer(mainCfg, abort.signal)
    const ctx = await buildModelContext({
      systemMessage,
      messages: modelMessages,
      contextWindowTokens: settings.contextWindowTokens,
      // 剧情轮次跳过 A2 自动摘要（run 摘要暂不落盘，仅 A1 预算装填）
      enableAutoCompact: store ? false : settings.enableAutoCompact,
      // 时间感知总开关（方案3 摘要时间线门控）
      timeAwareness: settings.timeAwarenessEnabled,
      summarize,
    })
    // ⑤ 尾部格式提醒（不落盘）：在预算装填/摘要**之后**追加，保证提醒恒为请求的最后一条
    // （不被装填裁剪/摘要吞掉）；离生成点最近，长会话下格式约束权重最高
    const fullMessages: ModelMessage[] = [...ctx.messages, { role: 'system', content: TAIL_FORMAT_REMINDER }]
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
      fullMessages.length - 2, // 尾部格式提醒（不落盘）不计入消息数口径
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
    // 方案A：语音可用性求值完成 → 修正文档 voice 标记（渲染端据此门控文本揭示）
    if (!store) turnCoordinator.markVoice(voiceActive)
    let speechCursor = 0
    let pendingBlock: { texts: string[]; emotion: string; kind: 'speak' | 'narr'; segIndex?: number } | null = null
    /** 是否已通过流式触发过至少一次语音（用于非流式/分块失败的兜底判定） */
    let speechEmitted = false
    /** 结构修复产物已采纳（parsed=repaired）：允许兜底块按 speechSegIdx 对齐增量续投（2026-10-20） */
    let repairAppended = false
    /**
     * 方案A：语音块 ↔ 文档分段索引对齐。语音链（extractDialogueChunkDelta）与文档切片
     * （syncFromPartial → extractDialogueObjects）对同一 partial 独立切片，闭合项序列一致：
     * 第 N 个语音项 = 文档第 N 段。pumpSpeech 每处理一项推进 speechSegIdx，flushPendingBlock
     * 投放时携带当前项索引，宠物窗经 ai:turn-speaking/spoken 回写文档 state。
     */
    let speechSegIdx = 0
    // 结算当前状态块并触发桌宠语音（语音启用时才发声）
    // 角色 TTS 语速倍率（随 speak payload 下发，渲染端合成时传给主进程变速；null = 原速）
    const speakSpeed = card?.ttsSpeed ?? null
    // 结算当前块并触发桌宠语音/上屏（语音启用时才发声；narr 块 displayOnly 不朗读）
    const flushPendingBlock = () => {
      const b = pendingBlock
      pendingBlock = null
      if (!b || b.texts.length === 0 || !card || !voiceActive) return
      const rawBlock = b.texts.join('\n')
      const langOverride = card.ttsOverride?.language ?? null
      const voiceId = voiceEngine === 'mimo' ? card.voiceId : null
      // narr 块（kind 权威或（）推断）：零时长槽位按序上屏，不合成不朗读
      if (b.kind === 'narr') {
        speechEmitted = true
        windowManager.speak(rawBlock, voiceId, langOverride, { chunks: [{ text: rawBlock, emotion: b.emotion }], follow: true, engine: voiceEngine ?? undefined, genieOverride, ttsSpeed: speakSpeed, displayOnly: true, segIndex: b.segIndex })
        return
      }
      // speak 块：开头括号前置通道消费防重复（旧契约模型把括号带进台词项时）
      const text = consumeLeadingNarration(rawBlock, narrationGroups, narrationCursor)
      if (!text.trim()) {
        speechEmitted = true
        return
      }
      speechEmitted = true
      // 不在此处退出思考立绘：speak 仅代表"发起合成"，此刻语音尚未真正发声。
      // 思考立绘的退出改由渲染端在 lipSync 真正开始播放音频时触发（见 PetStage）。
      windowManager.speak(text, voiceId, langOverride, { chunks: [{ text, emotion: b.emotion }], follow: true, engine: voiceEngine ?? undefined, genieOverride, ttsSpeed: speakSpeed, segIndex: b.segIndex })
    }
    // 流式 onChunk 中实时结算：speak 项并入当前块（同状态且未满块），narr 项**立即独立结算**
    // （零时长 displayOnly 上屏，不参与并块——并块会让 narr 与相邻 speak 的 flush 顺序依赖
    // 下一项到达，块切换竞态曾把整块 narr 吞掉：2026-10-14 02:00 轮 16 字旁白块丢失实锤）
    const pumpSpeech = (force = false) => {
      // ② 直通模式：改用括号/标点规则提取器（与文档切片同源整形，产出形状与 JSON 链一致，
      // 下方的并块/displayOnly/拆分逻辑零改动复用）；force 供流结束冲刷未定稿尾巴
      const { items, cursor } = driftMode
        ? extractScriptChunkDelta(scriptSource(), speechCursor, emotionPalette, force)
        : extractDialogueChunkDelta(partial, speechCursor, emotionPalette)
      speechCursor = cursor
      for (const it of items) {
        // 台词模式：先剥括号再入块；剥空即跳过（narr 内容在台词模式下不出语音也不上屏）
        const text = maybeStrip(it.text).trim()
        const kind: 'speak' | 'narr' = it.kind === 'narr' ? 'narr' : 'speak'
        // 本项对应的文档分段索引（块内所有项同索引——宠物窗按块回报，文档段以块为粒度推进）
        const itemSegIdx = speechSegIdx++
        if (!text) continue
        // narr 项立即结算：独立块，不与任何项合并
        if (kind === 'narr') {
          // 混合 narr 项拆分（与文档切片/定型解析同口径）：开头连续（）组为旁白
          // （零时长 displayOnly 不配音），尾部台词转 speak 并入常规并块（正常配音）——
          // 整项按旁白处理会让台词部分无语音、样式旁白化（2026-10-15 02:19 轮实锤）
          const { narr: leadingNarr, rest } = splitLeadingNarrGroups(text)
          if (leadingNarr && rest.trim() && card && voiceActive) {
            flushPendingBlock()
            speechEmitted = true
            windowManager.speak(
              leadingNarr,
              voiceEngine === 'mimo' ? card.voiceId : null,
              card.ttsOverride?.language ?? null,
              { chunks: [{ text: leadingNarr, emotion: it.emotion }], follow: true, engine: voiceEngine ?? undefined, genieOverride, ttsSpeed: speakSpeed, displayOnly: true, segIndex: itemSegIdx },
            )
            pendingBlock = { texts: [rest.trim()], emotion: it.emotion, kind: 'speak', segIndex: itemSegIdx }
            continue
          }
          flushPendingBlock()
          pendingBlock = { texts: [text], emotion: it.emotion, kind, segIndex: itemSegIdx }
          flushPendingBlock()
          continue
        }
        // speak 项开头连续（）组拆为独立 displayOnly 旁白槽位：模型偶发把开头旁白显式标成
        // kind:speak（2026-10-14 21:30 轮实锤），旁白粘进语音块会被语音门控卡到开播才显示；
        // 拆出后旁白零时长槽位入队即消费、立即按打字机上屏，与正确标注的 narr 项同节奏。
        // 剥离口径与文档分段同源（同一 fixUnclosedBrackets 文本），len(narr)+len(rest)=len(text)，
        // 宠物窗按槽位累计的字符进度与文档揭示总量保持对齐。守卫与 flushPendingBlock 一致。
        const { narr: leadingNarr, rest } = splitLeadingNarrGroups(text)
        if (leadingNarr && card && voiceActive) {
          flushPendingBlock()
          speechEmitted = true
          windowManager.speak(
            leadingNarr,
            voiceEngine === 'mimo' ? card.voiceId : null,
            card.ttsOverride?.language ?? null,
            { chunks: [{ text: leadingNarr, emotion: it.emotion }], follow: true, engine: voiceEngine ?? undefined, genieOverride, ttsSpeed: speakSpeed, displayOnly: true, segIndex: itemSegIdx },
          )
          if (!rest.trim()) continue
        }
        const blockText = leadingNarr && card && voiceActive ? rest : text
        if (!pendingBlock) { pendingBlock = { texts: [blockText], emotion: it.emotion, kind, segIndex: itemSegIdx }; continue }
        if (it.emotion !== pendingBlock.emotion || pendingBlock.kind !== kind || pendingBlock.texts.length >= BLOCK_MAX_ITEMS) {
          flushPendingBlock()
          pendingBlock = { texts: [blockText], emotion: it.emotion, kind, segIndex: itemSegIdx }
        } else {
          pendingBlock.texts.push(blockText)
        }
      }
    }

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
    /** ① LLM 结构修复已用次数（整轮上限 2，防退化轮反复修补） */
    let repairsUsed = 0
    /**
     * ① LLM 结构修复（Shinsekai 式，2026-10-15 03:22 轮"引号剧本"实锤后加）：
     * 结构化解析失败（空文本）或走了非 JSON 降级（rawEmotions 为空 = 内容来自
     * 引号剧本/纯文本等漂移形态）时，把模型**原始输出**发回 LLM，要求重新格式化为
     * 合法的 dialogue JSON（最多 2 次）——恢复分段与逐段状态，免整体重新生成。
     * 修复结果再过 parseDialogueJson（含键名回显契约检查）校验；失败返回 null，
     * 调用方保留降级解析结果（引号剧本已经过 ② 清洗）。
     */
    const repairDialogueJson = async (raw: string): Promise<ReturnType<typeof parseDialogueJson> | null> => {
      // ③ 修复走辅助模型（P0-2B 基建复用）：修复是机械格式化任务，主对话模型（可能是
      // 思考型/昂贵模型）耗时数秒；辅助快速模型压到 1s 级。未配置辅助模型时回落主模型。
      const aux = await resolveAuxLlmConfig()
      // ③ 词表约束：修回的状态词必须落在词表内——此前修复追回的自创状态词 6/7 miss 词表
      // 全部回落默认词，修复的状态维度等于白修；贴词表后修回的词才有用
      const paletteWords = emotionPalette.entries.length > 0 ? emotionPalette.entries.map((e) => e.name).join('、') : emotionPalette.defaultEmotion
      const repairPrompt = (strong: boolean) =>
        '你是一个 JSON 修复助手。用户输入的内容本应是角色扮演对话的结构化 JSON（格式：{"dialogue": [{"text": "台词或旁白文本", "emotion": "状态词", "kind": "speak 或 narr"}]}，speak=说出口的台词，narr=（）包裹的动作/心理旁白），但格式损坏了。' +
        '请将其修复为严格合法的该格式 JSON：只输出修复后的 JSON 对象本体，不要任何解释、代码围栏或额外文本；dialog 数组不得为空；每一项都必须包含 text 与 emotion 字段；必须完整保留原文中的全部台词与旁白文字，不得改写、翻译、增删任何字词。' +
        `emotion 字段必须从以下词表中为每项选择最贴切的一个：${paletteWords}；kind 只能是 speak 或 narr。` +
        (strong ? '\n【强制】只输出一个合法 JSON 对象，禁止输出剧本、纯文本、markdown 代码围栏、解释或任何非 JSON 内容。' : '')
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const out = await sendChatCompletion(
            [
              { role: 'system', content: repairPrompt(attempt > 1) },
              { role: 'user', content: raw },
            ],
            { model: aux?.model ?? mainCfg.model, baseURL: aux?.baseURL ?? mainCfg.baseURL, apiKey: aux?.apiKey ?? mainCfg.apiKey, temperature: 0.2, stream: false, maxTokensOverride: effectiveMaxTokens, signal: abort.signal },
          )
          const trimmed = (out ?? '').trim()
          if (!trimmed) {
            console.warn('[chat] LLM 结构修复：第 %d 次输出为空', attempt)
            continue
          }
          const check = parseDialogueJson(stripThink(trimmed), emotionPalette)
          if (check.text.trim()) {
            // 修复结果复检：模型可能复读自己的畸形（emotion 值再次内嵌 kind 结构字符 /
            // 再次普遍为空）——带异常则用强提示词再试一次（attempt<2），两次均异常才接受
            // （脏状态回落默认词）
            const contaminated = check.rawEmotions.some((r) => r.includes('kind') && /[:：]/.test(r))
            const blankDominant = check.rawEmotions.length >= 3 && check.rawEmotions.filter((r) => !r.trim()).length > check.rawEmotions.length / 2
            if ((contaminated || blankDominant) && attempt < 2) {
              console.warn('[chat] LLM 结构修复：第 %d 次结果状态值仍异常（结构污染/普遍为空），强提示词重试', attempt)
              continue
            }
            return check
          }
          console.warn('[chat] LLM 结构修复：第 %d 次结果未通过契约校验 输出=%j', attempt, trimmed.slice(0, 60))
        } catch (err) {
          console.warn('[chat] LLM 结构修复请求异常（第 %d 次）', attempt, err)
        }
      }
      return null
    }
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // 重置流式累积状态，避免上一次尝试的残片混入
      partial = ''
      lastDisplayLen = 0
      speechCursor = 0
      speechSegIdx = 0
      pendingBlock = null
      // 旁白前置状态一并重置：重试轮从头流式，渲染端已前置的旁白需清空重新接收
      resetNarrationState()
      // ② 漂移探测/直通状态随尝试轮重置（重试轮从头流式，重新探测）；④ 计时起点
      driftMode = false
      driftChecked = false
      firstChunkAt = 0
      streamStartAt = Date.now()
      // 方案A：重试轮换代——segments 重建、turnId 更新（渲染端见新 id 整体重置清屏）
      if (!store) turnCoordinator.renewTurn()
      let reasoningText = ''
      rawOutput = await sendChatCompletion(attemptMessages, {
        model: mainCfg.model,
        baseURL: mainCfg.baseURL,
        apiKey: mainCfg.apiKey,
        temperature: settings.temperature,
        maxTokens: effectiveMaxTokens,
        stream: settings.stream,
        signal: abort.signal,
        onChunk: (chunk) => {
          voiceActiveRef = voiceActive
          if (!firstChunkAt) firstChunkAt = Date.now()
          partial += chunk
          if (!chunkTimer) chunkTimer = setTimeout(flushChunks, CHUNK_FLUSH_MS)
          if (!mergeSpeech) pumpSpeech()
        },
        onReasoning: (chunk) => {
          reasoningText += chunk
        },
      })
      parsed = parseDialogueJson(maybeStrip(stripThink(rawOutput)), emotionPalette)
      // ④ 流式耗时观测：首块延迟（网络+思考）与总耗时，漂移直通标记一并打出
      console.log(
        '[diag] 流式：首块=%dms 总=%dms 提取链=%s',
        firstChunkAt ? firstChunkAt - streamStartAt : -1,
        Date.now() - streamStartAt,
        driftMode ? '直通(纯文本)' : 'json',
      )
      if (!parsed.text.trim() && reasoningText.trim()) {
        // content 通道为空但思考通道有内容：模型可能把最终 JSON 写进思考里了。
        // 能完整解析出正文就直接用，免去一次完整重试（首回复延迟减半）。
        const salvaged = salvageDialogueFromText(reasoningText, emotionPalette)
        if (salvaged) {
          console.log('[chat] content 为空，已从思考通道提取到回复（免重试）')
          parsed = salvaged
        }
      }
      // ① LLM 结构修复（Shinsekai 式）：触发条件 = 解析为空、走了非 JSON 降级（rawEmotions
      // 为空 = 内容来自引号剧本/纯文本等漂移形态，此时正文虽在但分段与逐段状态丢失）、
      // 或**状态值结构污染**（2026-10-16 02:28 轮实锤：模型把 kind 字段连同转义引号写进
      // emotion 值——值形如 `开心","kind":"narr`，JSON 本身合法、rawEmotions 非空，既有
      // 条件全部接不住，6 状态全回落默认词；内容级校验思路：字段值形态可疑也触发修复）、
      // 或**状态值普遍为空**（2026-10-17 19:20 轮实锤：6 项 emotion 全是空串——新退化
      // 形态，正文/分段正常但状态全回落默认词；空值占比过半且 ≥3 项即触发）
      // → 把原始输出发回 LLM 重新格式化，恢复结构；失败则保留降级解析结果（引号剧本已经过 ② 清洗）。
      // ② 直通轮跳过修复：正文已按剧本规则流式投递（doc/语音与直通切片同构），
      // 修复产出的分段会与已上屏文本错位；且直通轮 emotion 恒默认词（漂移形态的
      // 逐段状态本就 miss 词表），修复的增量价值只剩分段，不值得再等一趟 LLM。
      const emotionContaminated = parsed.rawEmotions.some((r) => r.includes('kind') && /[:：]/.test(r))
      const emptyEmotionCount = parsed.rawEmotions.filter((r) => !r.trim()).length
      const emotionBlankDominant = parsed.rawEmotions.length >= 3 && emptyEmotionCount > parsed.rawEmotions.length / 2
      if (
        (!parsed.text.trim() || parsed.rawEmotions.length === 0 || emotionContaminated || emotionBlankDominant) &&
        rawOutput.trim() &&
        repairsUsed < 2 &&
        !driftMode
      ) {
        repairsUsed++
        // ④ 修复观测：形态 A=解析为空（含契约剔除），B=非 JSON 降级（剧本漂移），
        // C=状态值结构污染，D=状态值普遍为空
        const repairForm = !parsed.text.trim()
          ? 'A(解析为空)'
          : parsed.rawEmotions.length === 0
            ? 'B(非JSON降级)'
            : emotionContaminated
              ? 'C(状态值结构污染)'
              : 'D(状态值普遍为空)'
        const repairStart = Date.now()
        const repaired = await repairDialogueJson(rawOutput.trim())
        console.log(
          '[diag] 结构修复：形态=%s rawLen=%d 耗时=%dms 结果=%s',
          repairForm,
          rawOutput.trim().length,
          Date.now() - repairStart,
          repaired ? '成功' : '失败',
        )
        if (repaired && repaired.text.trim()) {
          // 内容量守卫：修复结果不足降级文本一半 = 疑似改写/缩写 → 保留降级结果
          const keptLen = parsed.text.trim().length
          if (!keptLen || repaired.text.trim().length >= keptLen * 0.5) {
            console.log('[chat] LLM 结构修复成功：恢复 %d 字 / %d 段（免整体重新生成）', repaired.text.length, repaired.chunks.length)
            parsed = repaired
            repairAppended = true
          } else {
            console.warn('[chat] LLM 结构修复结果过短（%d < %d 的一半）→ 保留降级解析结果', repaired.text.trim().length, keptLen)
          }
        } else {
          console.log('[chat] LLM 结构修复未成功，保留降级解析结果')
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
    // ② 直通轮收尾冲刷：把未达封段条件的尾巴（最后一句可能没有句号）入稿/投放——
    // JSON 链由下方"结算最后一个未闭合的状态块"兜底，直通链的等价物是 force 冲刷
    // （mergeSpeech 模式保持整段一次合成语义：文档冲刷显示，语音走下方兜底整投）
    if (driftMode) {
      if (!store) {
        const tailFresh = turnCoordinator.syncFromPartialScript(scriptSource(), turnPalette, true)
        void tailFresh
      }
      if (!mergeSpeech) pumpSpeech(true)
    }
    // 结算最后一个未闭合的状态块
    flushPendingBlock()
    // 未触发"边生成边读"时兜底：整段文本生成完毕后触发语音。
    // 输入与重试循环内的主解析保持同构（同样剥思考包裹），否则带思考包裹的输出会在这里
    // 解析失败 → extractEmotion 兜底把原始 JSON/思考文本当正文送进 TTS（2026-10-02 线上案例）。
    // 【2026-10-19 修复】直接复用外层 parsed（结构修复成功时已是修复产物）——早先在此重新
    // parseDialogueJson(rawOutput) 遮蔽了外层变量：形态 B 轮对未修复的原始文本再次解析，
    // 走降级路径产出单 chunk（整条 196 字一个语音槽位）→ 立绘只切一次、开头旁白混进音频
    // （旁白打字债务等待只覆盖块前旁白），与定型显示（修复产物 6 段）分裂。
    // 外层 parsed 非空已由上方守卫保证（空文本提前 throw）。
    // 【2026-10-20 修复】流式"前半合法、后半损坏"轮的增量续投：流式已投前 N 块
    // （speechEmitted=true）后流式链对损坏后半零产出，结构修复恢复全文 M 段（M>N，前 N 段
    // ≈已投块）——旧守卫 !speechEmitted 直接跳过整个兜底块，第 N+1~M 段无人投递
    // （2026-10-20 14:02 轮实锤：恢复 8 段只投 3 块，第一句播完即静默收尾）。
    // repairAppended（修复产物已采纳）时按 speechSegIdx 对齐续投；直通轮/修复被拒等
    // "产物与已投不同源"场景维持跳过，避免重复投已上屏内容。
    if (voiceActive && card && (!speechEmitted || repairAppended)) {
      const langOverride = card.ttsOverride?.language ?? null
      const voiceId = voiceEngine === 'mimo' ? card.voiceId : null
      // 增量对齐（仅逐段链）：speechSegIdx = 流式闭合项数，与修复产物前缀项同基
      // （修复约束"完整保留原文"，前缀项不重排）；起点越过尾部 = 无新增段（C/D 形态只修状态值）
      const startIdx = speechEmitted && !mergeSpeech ? Math.min(speechSegIdx, parsed.chunks.length) : 0
      if (speechEmitted) {
        console.log(
          '[chat] 结构修复增量投递：流式已投 %d 段，修复产物 %d 段，续投 %s',
          speechSegIdx,
          parsed.chunks.length,
          startIdx < parsed.chunks.length ? `${startIdx}~${parsed.chunks.length - 1}` : '（无新增段，跳过）',
        )
      }
      // 结构修复补段（2026-10-22 实锤）：续投段同步入回合文档——此前修复段只进语音管线，
      // 文档缺失导致跟读期间无文本可门控显示，语音播完收尾切定型才整段一次性直显。
      // 补段后语音门控照常工作（进度播到哪、文本逐字放行到哪），与正常轮行为一致。
      if (repairAppended && !mergeSpeech) {
        turnCoordinator.appendRepairedSegments(parsed.chunks, startIdx)
      }
      if (mergeSpeech) {
        // 合音模式：只合并 speak 段（narr 段零时长槽位按序上屏，保持与逐段链一致的可见性）
        const speakChunks = parsed.chunks.filter((c) => (c.kind ?? 'speak') === 'speak')
        const mergedText = speakChunks.map((c) => c.text).join('\n')
        if (mergedText.trim()) {
          // 合音块跨多个文档段：首段索引回报（进度按块推进，合音无中间边界）
          const firstSpeakIdx = parsed.chunks.findIndex((c) => (c.kind ?? 'speak') === 'speak')
          windowManager.speak(mergedText, voiceId, langOverride, {
            chunks: [{ text: mergedText, emotion: parsed.emotion }],
            follow: true,
            engine: voiceEngine ?? undefined,
            genieOverride,
            ttsSpeed: speakSpeed,
            segIndex: firstSpeakIdx,
          })
        }
        for (const c of parsed.chunks) {
          if ((c.kind ?? 'speak') === 'narr' && c.text.trim()) {
            windowManager.speak(c.text, voiceId, langOverride, { chunks: [{ text: c.text, emotion: c.emotion }], follow: true, engine: voiceEngine ?? undefined, genieOverride, ttsSpeed: speakSpeed, displayOnly: true, segIndex: parsed.chunks.indexOf(c) })
          }
        }
      } else {
        for (let ci = startIdx; ci < parsed.chunks.length; ci++) {
          const c = parsed.chunks[ci]!
          const kind = c.kind ?? 'speak'
          // narr 段：displayOnly 按序上屏不朗读（与流式 flushPendingBlock 行为对齐）
          if (kind === 'narr') {
            windowManager.speak(c.text, voiceId, langOverride, { chunks: [{ text: c.text, emotion: c.emotion }], follow: true, engine: voiceEngine ?? undefined, genieOverride, ttsSpeed: speakSpeed, displayOnly: true, segIndex: ci })
            continue
          }
          // speak 段：剥掉已前置上屏的开头括号（旧契约模型把括号带进台词项时），剥空跳过
          const chunkText = consumeLeadingNarration(c.text, narrationGroups, narrationCursor)
          if (!chunkText.trim()) continue
          // 开头连续（）组拆为独立 displayOnly 旁白槽位（与 pumpSpeech 同口径：模型误标
          // kind:speak 的开头旁白立即上屏，不随语音门控；len(narr)+len(rest)=len(chunkText)）
          const { narr: leadingNarr, rest } = splitLeadingNarrGroups(chunkText)
          if (leadingNarr) {
            windowManager.speak(leadingNarr, voiceId, langOverride, { chunks: [{ text: leadingNarr, emotion: c.emotion }], follow: true, engine: voiceEngine ?? undefined, genieOverride, ttsSpeed: speakSpeed, displayOnly: true, segIndex: ci })
            if (!rest.trim()) continue
            windowManager.speak(rest, voiceId, langOverride, { chunks: [{ text: rest, emotion: c.emotion }], follow: true, engine: voiceEngine ?? undefined, genieOverride, ttsSpeed: speakSpeed, segIndex: ci })
            continue
          }
          windowManager.speak(chunkText, voiceId, langOverride, { chunks: [{ text: chunkText, emotion: c.emotion }], follow: true, engine: voiceEngine ?? undefined, genieOverride, ttsSpeed: speakSpeed, segIndex: ci })
        }
      }
    }

    // 持久化：user 消息 + assistant 完整回复（剧情轮次写 run 文件，普通聊天写会话）
    const now = Date.now()
    // 状态依从统计（词表微调 P2a 观测）：模型输出的原始 emotion 命中词表/别名接住的比例，
    // 无效值回落默认词单独计数——回落率持续偏高说明词表需要精简或释义不清（纯日志，零行为影响）
    const rawEmotions = parsed!.rawEmotions
    if (rawEmotions.length > 0) {
      // miss 原始值一并打印：词表外的自由词（英文枚举/近义词/幻觉词）是词表精简与释义调优的输入；
      // 全部原始值随行打印：观测模型是否过度使用默认词「平静」（词表/提示词调优的依据）
      const missList = rawEmotions.filter((r) => emotionAdherence(r, emotionPalette) === 'miss')
      console.log(
        '[chat] 状态依从：%d/%d 命中词表 原始值=[%s]%s',
        rawEmotions.length - missList.length,
        rawEmotions.length,
        rawEmotions.join('、'),
        missList.length > 0 ? `（回落默认词 ${missList.length} 次，原始值见下一行）` : '',
      )
      if (missList.length > 0) console.log('[chat] 状态依从 miss 原始值：%j', missList)
    }
    if (!store && needExitThinking && !voiceActive) {
      needExitThinking = false
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

    // 情境摘要异步更新（情境服务 Phase 1）：fire-and-forget 不阻塞、失败保留旧值；剧情轮次不参与
    if (!store) {
      void updateSceneDigestAfterTurn({
        sessionId,
        prevDigest: prevSceneDigest,
        userText: userMsg.content,
        assistantText: asstMsg.content,
        characterBrief: buildCharacterBrief(card),
        settings,
        mainCfg,
      })
    }

    // 方案A：文档终态（普通聊天轮）。有语音 → reading（跟读中）；无语音 → done。
    // final 暂用定型解析产物（第 2 步切文档映射生成）；done 快照立即广播不节流。
    if (!store) {
      if (voiceActive) turnCoordinator.markReading()
      else turnCoordinator.finishTurn(asstMsg)
    }

    // 记忆自动沉淀（后台，不阻塞）：proactive 旁白轮次与剧情轮次（store 覆盖）跳过；旁白消息不参与抽取
    if (settings.enableMemoryExtraction && !store && !meta?.proactive) {
      const extractable = history.filter((m) => !m.meta?.proactive)
      void extractMemoriesFromSession({
        sessionId,
        cardId: card?.id ?? '',
        messages: [...extractable, userMsg, asstMsg],
        settings: { ...mainCfg },
      })
    }

    if (!store) windowManager.broadcastAI('ai:stream-done', { sessionId, message: asstMsg })
    // 立绘/表情驱动策略：有语音由语音块驱动；无语音由文本输出驱动（剧情轮次桌宠零参与）
    if (!store && !voiceActive) windowManager.notifyEmotion(emotion)
    return asstMsg
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)

    // 出错/取消时也持久化 user 消息与已流出的部分回复，避免 UI 与磁盘状态分叉：
    //  - 主动取消：user 消息打 meta.cancelled 标记（不写 error 文案），渲染端「未收到回复」提示据此豁免；
    //  - 真实失败：error 字段携带具体原因，供提示条展示。
    const cancelled = abort.signal.aborted
    const failedUser: ChatMessage = cancelled
      ? { ...userMsg, meta: { ...userMsg.meta, cancelled: true } }
      : { ...userMsg, error: message }
    const partialAsst: ChatMessage | undefined = partial
      ? { role: 'assistant', content: maybeStrip(extractStreamingJsonText(partial)), timestamp: Date.now() }
      : undefined
    try {
      const extra: ChatMessage[] = partialAsst ? [failedUser, partialAsst] : [failedUser]
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

    // 广播携带落盘的权威 user/部分 assistant 消息：渲染端一次 setState 原子对齐本地列表，
    // 无需为取失败标记再做异步往返（往返间隙会让失败提示条出现黄→红的状态闪变）
    if (!store) {
      windowManager.broadcastAI('ai:stream-error', {
        sessionId,
        error: message,
        cancelled,
        userMessage: failedUser,
        partialMessage: partialAsst,
      })
    }
    // 方案A：错误路径文档终态（已流出部分作为 final；无文档时内部直接返回）
    if (!store) {
      const partialText = partial ? maybeStrip(extractStreamingJsonText(partial)) : ''
      turnCoordinator.abortTurn(partialText ? { role: 'assistant', content: partialText, timestamp: Date.now() } : undefined)
    }
    throw err
  } finally {
    if (currentAbort === abort) currentAbort = null
    // 流式结束/出错/取消：清除"进行中的流"标记，避免窗口在之后才就绪时误认领已结束的会话
    if (!store) windowManager.setActiveStreamingSession(null)
    // 退出思考立绘：仅无语音场景在此复位（有语音场景由渲染端 lipSync 播放时负责）；剧情轮次桌宠零参与
    if (!store && !voiceActiveRef && needExitThinking) {
      needExitThinking = false
      windowManager.notifyThinking(false)
    }
  }
}

