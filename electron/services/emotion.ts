/**
 * 结构化情绪解析：把 AI 回复末尾的情绪标签归一化到 8 标准情绪。
 *
 * prompt 承诺的标签格式：{#emotion:<standard>}，占回复最后一行。
 * 这里负责：
 *  1. extractEmotion —— 从完整回复剥离标签行，返回纯净文本 + 标准情绪
 *  2. normalizeEmotion —— 把任意自由情绪词（furious/委屈…）收窄到 8 标准情绪
 */
import { DEFAULT_EMOTION, type DialogueChunk, type EmotionSegment, type StandardEmotion } from '../../src/types'

/** 情绪标签正则：匹配回复末尾独占一行的 {#emotion:xxx} */
const EMOTION_TAG = /\{#emotion:([a-z]+)\}\s*$/i
/** 内嵌情绪点正则：文本中任意位置的 {#emo:xxx}（表达情绪转折） */
const EMBED_EMOTION_TAG = /\{#emo:([a-z]+)\}/gi

/** 情绪别名表：自由情绪词 → 标准情绪（未命中回退 neutral）。
 *  已删除情绪回退：担心/紧张类 → sad；亲近/撒娇类 → happy。 */
const EMOTION_ALIASES: Record<string, StandardEmotion> = {
  // neutral / 平静
  neutral: 'neutral', calm: 'neutral', relaxed: 'neutral', plain: 'neutral',
  平静: 'neutral', 淡定: 'neutral', 平和: 'neutral', 平常: 'neutral',
  // happy / 开心（含原「亲近/撒娇」回退）
  happy: 'happy', glad: 'happy', joy: 'happy', delighted: 'happy', cheerful: 'happy',
  开心: 'happy', 高兴: 'happy', 快乐: 'happy', 愉悦: 'happy', 兴奋: 'happy', 满意: 'happy',
  playful: 'happy', teasing: 'happy', coy: 'happy', flirty: 'happy', cutesy: 'happy',
  亲近: 'happy', 撒娇: 'happy', 俏皮: 'happy', 打趣: 'happy', 卖萌: 'happy',
  // sad / 难过（含原「担心/紧张」回退）
  sad: 'sad', sorrow: 'sad', heartbroken: 'sad', upset: 'sad', down: 'sad',
  难过: 'sad', 悲伤: 'sad', 伤心: 'sad', 失落: 'sad', 沮丧: 'sad', 委屈: 'sad', 想哭: 'sad',
  anxious: 'sad', nervous: 'sad', tense: 'sad', worried: 'sad', panic: 'sad', uneasy: 'sad',
  担心: 'sad', 紧张: 'sad', 不安: 'sad', 焦虑: 'sad', 心慌: 'sad', 害怕: 'sad',
  // angry / 生气
  angry: 'angry', anger: 'angry', mad: 'angry', annoyed: 'angry', irritated: 'angry', furious: 'angry',
  生气: 'angry', 愤怒: 'angry', 恼火: 'angry', 烦: 'angry', 火大: 'angry',
  // surprised / 惊讶
  surprised: 'surprised', surprise: 'surprised', shocked: 'surprised', amazed: 'surprised', astonished: 'surprised',
  惊讶: 'surprised', 吃惊: 'surprised', 震惊: 'surprised', 意外: 'surprised',
  // shy / 害羞
  shy: 'shy', embarrassed: 'shy', blushing: 'shy', bashful: 'shy', awkward: 'shy',
  害羞: 'shy', 脸红: 'shy', 不好意思: 'shy', 羞涩: 'shy', 难为情: 'shy',
}

/**
 * 把 AI 自由情绪词归一化为 8 标准情绪之一。
 * @param raw AI 输出中的情绪标签值（已去空白、转小写）
 * @returns 命中的标准情绪；未命中回退 neutral
 */
export function normalizeEmotion(raw: string): StandardEmotion {
  const key = raw.trim().toLowerCase()
  return EMOTION_ALIASES[key] ?? DEFAULT_EMOTION
}

/** 按标点/换行把文本切成句子序列（trim 后保留非空句）。
 *  成对圆括号内容会被当作一个整体保护，切句时不被其内部标点拆开（否则语音剥离旁白会失败）。 */
export function splitSentences(text: string): string[] {
  if (!text) return []
  // 1) 把成对圆括号整体替换为占位符，避免内部标点切开括号区块
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
  // 2) 按标点切句
  const parts = buf.match(/[^。！？；…!?;…。\n]+[。！？；…!?;…]?/g) ?? []
  // 3) 还原括号原文
  return parts
    .map((s) => s.replace(/\u0001(\d+)\u0001/g, (_m, id: string) => tokens[Number(id)] ?? ''))
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * 从 AI 完整回复中解析情绪与句子：
 * - 末尾 {#emotion:xxx} 作为兜底情绪
 * - 文本内 {#emo:xxx} 作为情绪转折点，落到对应句子索引生成 emotionSegments
 * 返回：
 *   text            剥离所有标签后的纯净文本（用于显示/落盘）
 *   emotion         末尾兜底情绪（未命中 neutral）
 *   sentences       按标点切分的句子序列
 *   emotionSegments 句子级情绪切换点（startSentence 0 基）
 */
export function extractEmotion(content: string): {
  text: string
  emotion: StandardEmotion
  sentences: string[]
  emotionSegments: EmotionSegment[]
} {
  const trimmed = content.trimEnd()
  let text = trimmed
  let emotion: StandardEmotion = DEFAULT_EMOTION
  // 1. 末尾兜底标签
  const tail = EMOTION_TAG.exec(trimmed)
  if (tail) {
    text = trimmed.slice(0, tail.index).trimEnd()
    emotion = normalizeEmotion(tail[1] ?? '')
  }
  // 2. 内嵌情绪点（位置在去掉末尾标签后的文本上计算）
  const embeds: { offset: number; emotion: StandardEmotion }[] = []
  EMBED_EMOTION_TAG.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = EMBED_EMOTION_TAG.exec(text))) {
    embeds.push({ offset: m.index, emotion: normalizeEmotion(m[1] ?? '') })
  }
  // 3. 移除所有标签，得到纯净文本；同时修正 embed offset（标签本身被删除会改变后续偏移）
  let clean = ''
  let removed = 0
  EMBED_EMOTION_TAG.lastIndex = 0
  const consumed: { offset: number; emotion: StandardEmotion }[] = []
  let cm: RegExpExecArray | null
  let cursor = 0
  while ((cm = EMBED_EMOTION_TAG.exec(text))) {
    clean += text.slice(cursor, cm.index) + ' '
    removed += cm[0].length + 1 // 标签 + 代替空格
    cursor = EMBED_EMOTION_TAG.lastIndex
    consumed.push({ offset: cm.index - removed, emotion: normalizeEmotion(cm[1] ?? '') })
  }
  clean += text.slice(cursor)
  // 4. 切句并映射情绪点到句子索引
  const sentences = splitSentences(clean)
  const emotionSegments: EmotionSegment[] = []
  if (sentences.length > 0) {
    for (const e of consumed) {
      const sentenceIndex = locateSentenceIndex(clean, sentences, e.offset)
      const prev = emotionSegments[emotionSegments.length - 1]
      if (prev && prev.emotion === e.emotion) continue // 相邻相同合并
      emotionSegments.push({ startSentence: sentenceIndex, emotion: e.emotion })
    }
    if (emotionSegments.length === 0) {
      // 无内嵌情绪点时，末尾兜底作为唯一情绪段落起点
      emotionSegments.push({ startSentence: 0, emotion })
    }
  }
  return { text: clean, emotion, sentences, emotionSegments }
}

/** 依据字符偏移在句子序列中找到所属句索引（0 基） */
function locateSentenceIndex(full: string, sentences: string[], offset: number): number {
  // 重建每句的起始累积长度（近似，忽略 trim 差异，用首句在 full 中首次出现定位）
  let cumulative = 0
  let searchFrom = 0
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i]!
    const idx = full.indexOf(s, searchFrom)
    if (idx === -1) {
      // 无法精确匹配时退回累计推进
      cumulative += s.length
      searchFrom = cumulative
    } else {
      cumulative = idx + s.length
      searchFrom = cumulative
    }
    if (offset <= cumulative) return i
  }
  return sentences.length - 1
}

/**
 * 从角色卡的情绪映射中取出某情绪的目标文件名/表情名，缺顶回退 neutral。
 * @param map 情绪 → 资源名 的映射（可为 null）
 * @param emotion 当前情绪
 * @returns 解析出的资源名；未配置则取 neutral 项
 */
export function resolveEmotionAsset(
  map: Partial<Record<StandardEmotion, string>> | null | undefined,
  emotion: StandardEmotion,
): string {
  const direct = map?.[emotion]
  if (direct) return direct
  return map?.[DEFAULT_EMOTION] ?? ''
}

/**
 * 从可能带 markdown 代码围栏的回复中抽取最外层 JSON 块内容（首个 { 到末个 }）。
 * @param content 模型整段输出
 * @returns 纯净的 JSON 块；无法定位时返回空串
 */
function extractJsonBlock(content: string): string {
  const stripped = content.replace(/```json\s*/gi, '').replace(/```/g, '')
  const start = stripped.indexOf('{')
  const end = stripped.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return ''
  return stripped.slice(start, end + 1)
}

/** JSON 字符串值转义还原（\\n、\\"、\\uXXXX 等） */
function decodeJsonString(raw: string): string {
  return raw
    .replace(/\\(["\\/bfnrt])/g, '$1')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)))
}

/**
 * 解析结构化 JSON dialogue 输出（Shinsekai 式，prompt 强制契约）。
 * 每个元素是一个台词节拍 { text, emotion }，按元素顺序拼接成段落文本，
 * 并把每项的 emotion 落到其首句的句子索引上生成 emotionSegments（相邻相同合并）。
 *
 * 当内容不是合法 JSON（模型漏标/降级）时：
 *   - 若仍含旧式 {#emo}/{#emotion} 标签，回退 extractEmotion；
 *   - 否则整段视为单一 neutral。
 * 返回：
 *   text            拼接后的纯净段落文本（各项以空行分隔）
 *   emotion         末尾（最后一项）情绪，缺省 neutral
 *   sentences       按标点/换行切分的句子序列（用于展示/句级元数据）
 *   emotionSegments 句子级情绪切换点（startSentence 0 基）
 *   chunks          合成分段（dialogue 逐项），供语音段级合成与立绘切换
 */
export function parseDialogueJson(content: string): {
  text: string
  emotion: StandardEmotion
  sentences: string[]
  emotionSegments: EmotionSegment[]
  chunks: DialogueChunk[]
} {
  const block = extractJsonBlock(content)
  let dialogue: Array<{ text?: string; emotion?: string }> = []
  if (block) {
    try {
      const parsed = JSON.parse(block) as { dialogue?: Array<{ text?: string; emotion?: string }> }
      if (Array.isArray(parsed?.dialogue)) dialogue = parsed.dialogue
    } catch {
      dialogue = []
    }
  }
  const items = dialogue.filter((it) => typeof it?.text === 'string' && it.text.trim() !== '')

  if (items.length === 0) {
    // 结构化解析失败：回退旧式标签解析（历史消息兼容），否则整段 neutral
    try {
      const fallback = extractEmotion(content)
      return { ...fallback, chunks: [{ text: fallback.text, emotion: fallback.emotion }] }
    } catch {
      const single: DialogueChunk = { text: content, emotion: DEFAULT_EMOTION }
      return { text: content, emotion: DEFAULT_EMOTION, sentences: splitSentences(content), emotionSegments: [{ startSentence: 0, emotion: DEFAULT_EMOTION }], chunks: [single] }
    }
  }

  // 拼接段落文本（单换行分隔，去掉过密的空行，保持与 AssistantSentences 段级展示一致）
  const text = items.map((it) => decodeJsonString(it.text!.trim())).join('\n')
  const sentences = splitSentences(text)
  // 合成分段：每个 dialogue 项一条，段级合成（不再按标点切碎）+ 段级切立绘
  const chunks: DialogueChunk[] = items.map((it) => ({
    text: decodeJsonString(it.text!.trim()),
    emotion: normalizeEmotion(it.emotion ?? ''),
  }))

  // 逐项累计句子数，把每项情绪落到其首句索引
  const emotionSegments: EmotionSegment[] = []
  let sentCursor = 0
  for (const it of items) {
    const n = splitSentences(decodeJsonString(it.text!.trim())).length
    const emo = normalizeEmotion(it.emotion ?? '')
    const prev = emotionSegments[emotionSegments.length - 1]
    if (!prev || prev.emotion !== emo) emotionSegments.push({ startSentence: sentCursor, emotion: emo })
    sentCursor += n
  }
  if (emotionSegments.length === 0) emotionSegments.push({ startSentence: 0, emotion: DEFAULT_EMOTION })
  const emotion = normalizeEmotion(items[items.length - 1]?.emotion ?? '')

  return { text, emotion, sentences, emotionSegments, chunks }
}

/**
 * 流式上屏用：从尚不完整的 JSON 输出中尽力提取已吐出的台词文本，
 * 避免把原始 JSON（含花括号/键名）直接外露给用户。
 *
 * 处理策略：
 * - 先提取所有"已闭合"的 "text":"..." 值；
 * - 再追加"正在写入、尚未闭合"的最后一个 text 值（流式中实时可见，保证打字感）；
 * - 若整段完全不含 text 键且不像 JSON（无花括号）——即模型未按 JSON 输出——
 *   则退化原样返回原始文本，确保流式与语音链路不被切断。
 * @param partial 累积中的原始回复文本
 * @returns 已提取的纯净段落文本（或非 JSON 时的原始文本）
 */
export function extractStreamingJsonText(partial: string): string {
  if (!partial) return ''
  const re = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g
  const out: string[] = []
  let m: RegExpExecArray | null
  let lastEnd = 0
  while ((m = re.exec(partial))) {
    lastEnd = re.lastIndex
    const v = decodeJsonString(m[1] ?? '').trim()
    if (v) out.push(v)
  }

  // 追加正在写入、尚未闭合的最后一个 text 值（从上次匹配末尾之后找 "text": 开头的片段）
  let trailing = ''
  const rel = partial.slice(lastEnd).search(/"text"\s*:\s*"/)
  if (rel !== -1) {
    const after = partial.slice(lastEnd + rel).replace(/^"text"\s*:\s*"/, '')
    // 取到第一个未转义的引号为止（该值要么闭合，要么仍在书写中）
    const partialVal = after.split(/(?<!\\)"/)[0] ?? ''
    if (partialVal.trim()) trailing = decodeJsonString(partialVal)
  }

  const joined = [...out, trailing].join('\n')
  if (out.length === 0 && !trailing) {
    // 没有任何 text 键：若不是 JSON（即不含花括号），可能是模型未按 JSON 输出的纯文本，
    // 退化回放原始文本，保住流式与后续语音触发。
    return /[{}\[\]]/.test(partial) ? '' : partial
  }
  return joined
}