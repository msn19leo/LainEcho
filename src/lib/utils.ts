/** 通用工具函数 */

export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

export function pad(n: number): string {
  return n.toString().padStart(2, '0')
}

export function formatTime(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function formatTimeFull(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 相对时间（列表用）：刚刚 / x 分钟前 / x 小时前 / 日期 */
export function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  const d = new Date(ts)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

export function truncate(text: string, len: number): string {
  const t = text.trim().replace(/\s+/g, ' ')
  return t.length > len ? `${t.slice(0, len)}…` : t
}

export function errText(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
