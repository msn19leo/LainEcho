/**
 * Token 估算器 —— 基于 gpt-tokenizer（cl100k_base，纯 JS）。
 *
 * 用途：上下文预算装填（A1）与自动摘要触发判断（A2）都需要估算「发给模型的
 * 消息一共占多少 token」，避免只按「最近 N 条」固定截断。
 *
 * cl100k_base 与 OpenAI gpt-4 系编码一致，中文/英文计数都较准；
 */
import { encode } from 'gpt-tokenizer'

/** 一条消息除 content 外的固定开销（role 等元数据，近似值） */
const MESSAGE_OVERHEAD_TOKENS = 4

/** 估算任意文本的 token 数；空文本返回 0 */
export function estimateTextTokens(text: string): number {
  const value = String(text ?? '')
  if (!value) return 0
  try {
    return encode(value).length
  } catch {
    // 极端情况（超大输入等）兜底：UTF-8 字节数 / 3 的保守估算
    return Math.max(1, Math.ceil(Buffer.byteLength(value, 'utf8') / 3))
  }
}

/** 估算单条消息的 token 数（content + 固定开销） */
export function estimateMessageTokens(message: { role?: string; content?: unknown }): number {
  return MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(String(message?.content ?? ''))
}

/** 估算整组消息的总 token 数 */
export function estimateMessagesTokens(messages: Array<{ role?: string; content?: unknown }>): number {
  let total = 0
  for (const m of messages) total += estimateMessageTokens(m)
  return total
}
