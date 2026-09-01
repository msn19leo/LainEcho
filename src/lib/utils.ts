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

/** 按标点/换行把文本切成句子序列（与主进程 emotion.ts 规则一致，供句级朗读高亮）。
 *  成对圆括号整体保护，不被内部标点切开，保证与主进程句子索引对齐。 */
export function splitSentences(text: string): string[] {
  if (!text) return []
  const tokens: string[] = []
  let buf = ''
  let depth = 0
  let start = -1
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch === '（' || ch === '(') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '）' || ch === ')') {
      depth--
      if (depth === 0 && start >= 0) {
        tokens.push(text.slice(start, i + 1))
        buf += `\u0001${tokens.length - 1}\u0001`
      } else if (start < 0) {
        buf += ch
      }
    } else if (depth === 0) {
      buf += ch
    }
  }
  const parts = buf.match(/[^。！？；…!?;…。\n]+[。！？；…!?;…]?/g) ?? []
  return parts
    .map((s) => s.replace(/\u0001(\d+)\u0001/g, (_m, id: string) => tokens[Number(id)] ?? ''))
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 移除中/英文括号、方括号中的心理/动作旁白，用于语音合成（不读出旁白）。
 *  循环剥离直到无变化，处理嵌套括号与残留孤括号。 */
export function stripBrackets(text: string): string {
  let prev: string
  let t = text
  do {
    prev = t
    t = t
      .replace(/[（(][^（()）]*[）)]/gs, '')
      .replace(/【[^【】]*】/gs, '')
      .replace(/\[[^\[\]]*\]/gs, '')
  } while (t !== prev)
  // 清理可能残留的孤立括号字符
  t = t.replace(/[（()）【】\[\]]/g, '')
  return t.replace(/\s+/g, ' ').trim()
}

export function errText(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
