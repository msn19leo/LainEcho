/**
 * 上下文组装模块 —— 把「固定最近 N 条截断」升级为 A1（Token 预算装填）+ A2（自动摘要压缩）。
 *
 * 职责：
 *  1. 消息净化：剥离 UI 元数据（sentences/emotionSegments/chunks 等），只把 {role, content} 发给模型
 *  2. A1 预算装填：按模型上下文窗口 × HISTORY_BUDGET_RATIO 从最新消息向前装填，超预算的旧消息丢弃
 *  3. A2 自动摘要：总 token 超过 contextWindow × COMPACT_THRESHOLD 时，把「最近 RECENT_MESSAGE_LIMIT 条
 *     之外」的旧历史交给外部 summarize 回调生成摘要，摘要落盘复用（下次超阈值时再更新）
 *
 * 摘要走独立 prompt（对话总结助手），绝不混入主对话的 EMOTION_PROMPT JSON 约束。
 */
import type { ChatImage, ChatMessage } from '../../src/types'
import { estimateMessagesTokens } from './token'

/** 触发摘要的阈值：总 token > contextWindow × COMPACT_THRESHOLD 时压缩 */
const COMPACT_THRESHOLD = 0.4
/** 历史可用预算：contextWindow × HISTORY_BUDGET_RATIO（system 占用后剩余给历史） */
const HISTORY_BUDGET_RATIO = 0.6
/** 摘要时保留的最近消息条数（更早的进摘要） */
const RECENT_MESSAGE_LIMIT = 20
/** 摘要消息的识别标记（下次压缩可据此替换旧摘要） */
export const SUMMARY_MARKER = '【历史对话总结】'
/** 摘要输出 token 上限（摘要走非流式独立请求） */
export const SUMMARY_MAX_TOKENS = 1024

/** 摘要时间线的行首时刻格式：M-D HH:mm（相对轻量，无年份——跨年对话极罕见且摘要本就是模糊产物） */
function formatSummaryTs(ts: number): string {
  const d = new Date(ts)
  return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * 方案3 摘要时间线：旧消息行首标注 [M-D HH:mm]。A2 压缩只传 `role: content`，压缩后的
 * 会话完全失去时间轴（"那天我们…"无从定位）；时间前缀让摘要有据可依保留时间线索。
 * 受时间感知总开关门控；无 timestamp 的消息（旧数据）原样输出。
 */
function formatSummaryLine(m: ModelMessage, timeAware: boolean): string {
  const t = timeAware && typeof m.timestamp === 'number' && m.timestamp > 0 ? `[${formatSummaryTs(m.timestamp)}] ` : ''
  return `${t}${m.role}: ${m.content}`
}

/** 单条 model 消息的净形状：只保留 role + content（timestamp 供摘要时间线/间隔标注消费，不发给模型） */
export interface ModelMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  /**
   * 本轮附带的图片（仅 user 消息；由 chatTurn 按「图片记忆轮数」裁剪后再转成
   * 多模态 content parts）。摘要/导出等纯文本链路一律忽略本字段。
   */
  images?: ChatImage[]
  /** 消息时间戳（时间感知方案1/3 的数据通道；仅用于间隔标注与摘要时间线，不作为消息内容发送） */
  timestamp?: number
}

/** 上下文构建入参 */
export interface ContextBuildParams {
  /** 组装好的 system 消息（人设 + 记忆 + 输出约束） */
  systemMessage: ModelMessage
  /** 已按顺序排列的完整历史消息（已净化） */
  messages: ModelMessage[]
  /** 模型上下文窗口 token 数（用户配置，0 表示不限制） */
  contextWindowTokens: number
  /** 是否启用自动摘要压缩 */
  enableAutoCompact: boolean
  /** 时间感知总开关（方案3 摘要时间线门控）：开启时摘要输入的旧消息行首标注时刻 */
  timeAwareness?: boolean
  /** 摘要回调：把旧历史文本压成摘要文本（由调用方用独立 prompt 调模型），失败应 throw */
  summarize: (olderText: string) => Promise<string>
}

/** 上下文构建结果 */
export interface ContextBuildResult {
  /** 最终发给模型的完整消息列表（system + 摘要 + 近段历史） */
  messages: ChatMessage[]
  /** 本轮产生的新摘要（供调用方落盘复用）；未产生则为 null */
  newSummary: string | null
}

/** 消息净化：剥离 UI 元数据，只保留 {role, content}（timestamp 一并透传，供时间感知链路消费） */
export function toModelMessage(m: ChatMessage): ModelMessage {
  const msg: ModelMessage = { role: m.role, content: m.content ?? '', timestamp: m.timestamp }
  // 图片随消息透传到装填层（是否真的发给模型由 chatTurn 的读图方式与轮数窗口决定）
  if (m.images?.length) msg.images = m.images
  return msg
}

/** 构造「历史对话总结」占位消息（带标记，供下次识别替换） */
export function buildSummaryMessage(summary: string): ModelMessage {
  return {
    role: 'user',
    content: `${SUMMARY_MARKER}以下是之前的对话摘要：\n${summary}\n\n请基于以上上下文与最近的对话继续。`,
  }
}

/**
 * A1：按 token 预算从尾部向前装填历史。
 * 始终保留最后一条（当前用户消息）；从倒数第二条起向前累加，装到接近预算为止。
 * 若传入 protectedHead（摘要消息），先扣掉它的 token，再给正文装填。
 */
function budgetTruncate(
  body: ModelMessage[],
  systemMessage: ModelMessage,
  contextWindowTokens: number,
  protectedHead?: ModelMessage,
): ModelMessage[] {
  const sysTokens = estimateMessagesTokens([systemMessage])
  const budget = Math.floor(contextWindowTokens * HISTORY_BUDGET_RATIO) - sysTokens
  const headTokens = protectedHead ? estimateMessagesTokens([protectedHead]) : 0
  const bodyBudget = Math.max(1, budget - headTokens)

  const kept: ModelMessage[] = []
  let acc = 0
  for (let i = body.length - 1; i >= 0; i--) {
    const msg = body[i]!
    const t = estimateMessagesTokens([msg])
    // 至少保留最后一条（当前用户消息）；之后超预算就停止丢弃更早的
    if (acc + t > bodyBudget && kept.length > 0) break
    kept.unshift(msg)
    acc += t
  }
  return protectedHead ? [protectedHead, ...kept] : kept
}

/**
 * A1 + A2 编排入口：
 * - 未触发摘要阈值 → 纯预算装填（A1）
 * - 触发阈值 → 旧历史交给 summarize 生成摘要，保留最近 RECENT_MESSAGE_LIMIT 条，
 *   摘要 + 近段再套一次预算装填兜底（A2）
 */
export async function buildModelContext(params: ContextBuildParams): Promise<ContextBuildResult> {
  const { systemMessage, messages, contextWindowTokens, enableAutoCompact, timeAwareness, summarize } = params

  // 未配置上下文窗口（0/未填）→ 不限制，原样返回（保持旧行为）
  if (!(contextWindowTokens > 0)) {
    return { messages: [systemMessage, ...messages], newSummary: null }
  }

  const total = estimateMessagesTokens([systemMessage, ...messages])
  const threshold = contextWindowTokens * COMPACT_THRESHOLD

  if (enableAutoCompact && total > threshold && messages.length > 1) {
    // 拆分：更早的进摘要，最近的保持原文
    const start = Math.max(0, messages.length - RECENT_MESSAGE_LIMIT)
    const older = messages.slice(0, start)
    const recent = messages.slice(start)

    if (older.length > 0) {
      // 方案3 摘要时间线：行首标注时刻，摘要保留"对话发生在何时"的线索（受总开关门控）
      const olderText = older.map((m) => formatSummaryLine(m, timeAwareness !== false)).join('\n')
      let summary: string
      try {
        summary = await summarize(olderText)
      } catch (err) {
        // 摘要失败不阻塞聊天：回退 A1 预算装填
        console.warn('[context] 自动摘要压缩失败，回退预算装填：', err)
        return {
          messages: [systemMessage, ...budgetTruncate(messages, systemMessage, contextWindowTokens)],
          newSummary: null,
        }
      }

      const summaryMsg = buildSummaryMessage(summary)
      const compacted = budgetTruncate(recent, systemMessage, contextWindowTokens, summaryMsg)
      return { messages: [systemMessage, ...compacted], newSummary: summary }
    }
  }

  // 未触发摘要 → 纯预算装填
  return {
    messages: [systemMessage, ...budgetTruncate(messages, systemMessage, contextWindowTokens)],
    newSummary: null,
  }
}

/** 手动压缩入参 */
export interface ForceCompactParams {
  systemMessage: ModelMessage
  messages: ModelMessage[]
  /** 时间感知总开关（方案3 摘要时间线门控）：开启时摘要输入的旧消息行首标注时刻 */
  timeAwareness?: boolean
  /** 摘要回调：把旧历史文本压成摘要文本（由调用方用独立 prompt 调模型），失败应 throw */
  summarize: (olderText: string) => Promise<string>
}

/** 手动压缩结果 */
export interface ForceCompactResult {
  /** 压缩后的消息列表（system + 摘要消息 + 最近 RECENT_MESSAGE_LIMIT 条原文） */
  messages: ChatMessage[]
  /** 本次生成的新摘要；无旧历史可压时为 null */
  newSummary: string | null
}

/**
 * 手动压缩：无论是否超阈值，都把「最近 RECENT_MESSAGE_LIMIT 条之外」的旧历史压成摘要。
 * 与 buildModelContext 的区别：不按阈值触发、不做预算裁剪（保留最近 20 条原文即可）。
 * 失败直接抛出，由调用方（IPC handler）反馈给用户。
 */
export async function forceCompact(params: ForceCompactParams): Promise<ForceCompactResult> {
  const { systemMessage, messages, timeAwareness, summarize } = params
  if (messages.length <= 1) {
    return { messages: [systemMessage, ...messages], newSummary: null }
  }
  const start = Math.max(0, messages.length - RECENT_MESSAGE_LIMIT)
  const older = messages.slice(0, start)
  const recent = messages.slice(start)
  if (older.length === 0) {
    // 没有可压缩的旧历史（不足 20 条）
    return { messages: [systemMessage, ...messages], newSummary: null }
  }
  const olderText = older.map((m) => formatSummaryLine(m, timeAwareness !== false)).join('\n')
  const summary = await summarize(olderText)
  const summaryMsg = buildSummaryMessage(summary)
  return { messages: [systemMessage, summaryMsg, ...recent], newSummary: summary }
}
