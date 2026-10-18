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

/** 多气泡渲染的一个分组：连续同类的段落合并为一个气泡 */
export interface MessageBubbleGroup {
  /** 'speak' = 台词气泡（正常样式）；'narr' = 旁白气泡（弱化样式 + 自动（）包裹） */
  kind: 'speak' | 'narr'
  /** 合并进该气泡的段落文本序列（渲染时段间换行） */
  texts: string[]
}

/**
 * 把一段文本按（）/() 包裹拆成旁白/台词片段：括号组 → narr（剥掉外层括号），
 * 其余文本 → 传入的 defaultKind（台词项内联的旁白括号在此被拆出来，按旁白样式渲染）。
 * 括号识别与 stripBrackets 一致（不处理嵌套）。
 */
function splitParenPieces(text: string, defaultKind: 'speak' | 'narr'): Array<{ kind: 'speak' | 'narr'; text: string }> {
  const pieces: Array<{ kind: 'speak' | 'narr'; text: string }> = []
  const re = /[（(][^（()）]*[）)]/g
  let cursor = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > cursor) {
      const before = text.slice(cursor, m.index)
      for (const line of before.split('\n')) if (line.trim()) pieces.push({ kind: defaultKind, text: line })
    }
    pieces.push({ kind: 'narr', text: (m[0] ?? '').replace(/^[（(]/, '').replace(/[）)]$/, '') })
    cursor = m.index + m[0].length
  }
  if (cursor < text.length) {
    for (const line of text.slice(cursor).split('\n')) if (line.trim()) pieces.push({ kind: defaultKind, text: line })
  }
  return pieces
}

/**
 * 把 AI 回复消息拆为多气泡分组（连续同类段合并，仅影响显示不影响存储）：
 * - 优先用 chunks 的 kind 字段（新契约，权威）；**台词项内联的（）括号组仍拆为旁白气泡**
 *   （模型偶发把旁白写进台词项，kind 标成 speak——整条按台词渲染会丢失旁白弱化样式，
 *   2026-10-14 16:32 轮实锤）；
 * - 无 chunks（旧消息/降级输出）时按（）/() 包裹把整段文本现场拆成旁白/台词序列；
 * - 旁白气泡渲染时自动补（），与老版本文本形态保持一致。
 * @param content 消息全文（chunks 缺失时的拆分源）
 * @param chunks 结构化分段（新消息必有）
 */
export function groupMessageBubbles(content: string, chunks?: Array<{ text: string; kind?: 'speak' | 'narr' }> | null): MessageBubbleGroup[] {
  const groups: MessageBubbleGroup[] = []
  const push = (kind: 'speak' | 'narr', text: string) => {
    const t = text.trim()
    if (!t) return
    const last = groups[groups.length - 1]
    if (last && last.kind === kind) last.texts.push(t)
    else groups.push({ kind, texts: [t] })
  }

  if (chunks && chunks.length > 0) {
    for (const c of chunks) {
      const kind = c.kind === 'narr' || c.kind === 'speak' ? c.kind : (/^[（(]/.test((c.text ?? '').trim()) ? 'narr' : 'speak')
      const raw = c.text ?? ''
      // 台词项内联（）旁白 → 拆成独立旁白片段（旁白项整体已是旁白，无需再拆）
      if (kind === 'speak' && /[（(]/.test(raw)) {
        for (const p of splitParenPieces(raw, 'speak')) push(p.kind, p.text)
      } else {
        push(kind, raw)
      }
    }
    return groups
  }

  // 无 chunks：按（）包裹拆分整段文本——（）组为 narr，其余按行归 speak
  for (const p of splitParenPieces(content, 'speak')) push(p.kind, p.text)
  return groups
}

/** 旁白气泡显示文本：自动补（），保证旁白气泡永远带成对括号（与类型一致，不依赖模型输出习惯） */
export function narrBubbleText(text: string): string {
  const t = text.trim()
  if (!t) return t
  return /^[（(]/.test(t) ? t : `（${t}）`
}

/**
 * 找出文本尾部"未闭合的 （ 组"起点：从末尾反向数括号配平，若处于未闭合组内，
 * 返回该组 （ 的索引（揭示游标切断在旁白中间时用于把半截旁白按旁白样式渲染）；无则 -1。
 */
function trailingOpenParenIndex(text: string): number {
  let depth = 0
  let openIdx = -1
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch === '（' || ch === '(') {
      if (depth === 0) openIdx = i
      depth++
    } else if (ch === '）' || ch === ')') {
      if (depth > 0) depth--
    }
  }
  return depth > 0 ? openIdx : -1
}

/**
 * 把直播可见分段（揭示游标切片产物，最后一段可能是半截文本）转为与定型渲染
 * （groupMessageBubbles）**同构**的气泡分组——直播与定型用同一组件渲染后，
 * "输出时什么样，结束时就什么样"，不存在收尾重排/样式跳变：
 *  - speak 项内联（）拆为旁白片段（与定型口径一致，模型把旁白写进台词项时样式不错乱）；
 *  - 末片尾部未闭合的 （… 按旁白渲染（闭合后即为其真身，样式无跳变）；
 *    模型显式 kind:speak 但整段以（开头的误标项也由此落旁白样式，与定型拆分结果一致；
 *  - narr 项整体按旁白渲染（不拆内文，与定型对 narr chunk 的处理一致）；
 *  - 连续同类合并（与定型多气泡的合并口径一致）。
 */
export function groupLiveSegments(segs: Array<{ text: string; kind: 'speak' | 'narr' }>): MessageBubbleGroup[] {
  const groups: MessageBubbleGroup[] = []
  const push = (kind: 'speak' | 'narr', text: string) => {
    const t = text.trim()
    if (!t) return
    const last = groups[groups.length - 1]
    if (last && last.kind === kind) last.texts.push(t)
    else groups.push({ kind, texts: [t] })
  }
  segs.forEach((seg, si) => {
    const isLastSeg = si === segs.length - 1
    if (seg.kind === 'narr') {
      push('narr', seg.text)
      return
    }
    // speak 项：先按已闭合（）组拆分（与定型 splitParenPieces 同口径）
    const pieces = splitParenPieces(seg.text, 'speak')
    for (let pi = 0; pi < pieces.length; pi++) {
      const p = pieces[pi]!
      const isVeryLast = isLastSeg && pi === pieces.length - 1
      if (p.kind === 'speak' && isVeryLast) {
        // 末片：尾部未闭合的 （ 组前瞻为旁白（揭示切断在旁白中间/开头（ 误标项）
        const idx = trailingOpenParenIndex(p.text)
        if (idx >= 0) {
          const head = p.text.slice(0, idx)
          const tail = p.text.slice(idx)
          if (head.trim()) push('speak', head)
          if (tail.trim()) push('narr', tail)
          continue
        }
      }
      push(p.kind, p.text)
    }
  })
  return groups
}
