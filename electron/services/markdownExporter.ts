/**
 * 会话导出为 Markdown。
 * 格式见技术方案 7.5 节：
 *   标题 / 角色卡 / 时间头 + 逐条消息（用户/角色名 + 时间 + 正文）
 */
import type { ChatMessage, SessionDetail } from '../../src/types'

function pad(n: number): string {
  return n.toString().padStart(2, '0')
}

function formatDateTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function formatTime(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 导出单个会话为 Markdown 文本 */
export function sessionToMarkdown(
  session: SessionDetail,
  meta: { title: string; characterCardName: string; createdAt: number },
): string {
  const lines: string[] = []

  lines.push(`# 会话记录：${meta.title}`)
  lines.push('')
  lines.push(`- 角色卡：${meta.characterCardName}`)
  lines.push(`- 创建时间：${formatDateTime(meta.createdAt)}`)
  lines.push(`- 导出时间：${formatDateTime(Date.now())}`)
  lines.push('')
  lines.push('---')
  lines.push('')

  // 过滤掉 system 消息，只导出用户与 AI 的对话
  const chatMessages = session.messages.filter(
    (m): m is ChatMessage & { role: 'user' | 'assistant' } => m.role === 'user' || m.role === 'assistant',
  )

  for (const msg of chatMessages) {
    const name = msg.role === 'user' ? '用户' : meta.characterCardName || 'AI'
    lines.push(`**${name}** [${formatTime(msg.timestamp)}]`)
    lines.push('')
    lines.push(msg.content.trim())
    lines.push('')
    lines.push('---')
    lines.push('')
  }

  return lines.join('\n')
}
