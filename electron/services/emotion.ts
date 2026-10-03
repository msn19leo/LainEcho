/**
 * 结构化情绪解析：把 AI 回复末尾的情绪标签归一化到 8 标准情绪。
 *
 * prompt 承诺的标签格式：{#emotion:<standard>}，占回复最后一行。
 * 这里负责：
 *  1. extractEmotion —— 从完整回复剥离标签行，返回纯净文本 + 标准情绪
 *  2. normalizeEmotion —— 把任意自由情绪词（furious/委屈…）收窄到 8 标准情绪
 */
import { BUILTIN_DEFAULT_EMOTION, builtinPalette, type DialogueChunk, type EmotionPaletteRef, type EmotionSegment } from '../../src/types'

/** 情绪标签正则：匹配回复末尾独占一行的 {#emotion:xxx}（值域含中英文字词表词） */
const EMOTION_TAG = /\{#emotion:([\w\u4e00-\u9fff]+)\}\s*$/i
/** 内嵌情绪点正则：文本中任意位置的 {#emo:xxx}（表达情绪转折；值域含中英文字词表词） */
const EMBED_EMOTION_TAG = /\{#emo:([\w\u4e00-\u9fff]+)\}/gi

/** 情绪别名表：历史 6 枚举英文词/近义自由词 → 中文标准情绪词。
 *  词表方案下不再是值域，仅作归一化第二跳（识别旧词/近义词后回词表查词）。
 *  语义分组与旧版一致（担心/紧张类→难过；亲近/撒娇类→开心）。 */
const EMOTION_ALIASES: Record<string, string> = {
  // 平静（旧 neutral）
  neutral: '平静', calm: '平静', relaxed: '平静', plain: '平静',
  淡定: '平静', 平和: '平静', 平常: '平静',
  // 开心（旧 happy，含原「亲近/撒娇」回退）
  happy: '开心', glad: '开心', joy: '开心', delighted: '开心', cheerful: '开心',
  高兴: '开心', 快乐: '开心', 愉悦: '开心', 兴奋: '开心', 满意: '开心',
  playful: '开心', teasing: '开心', coy: '开心', flirty: '开心', cutesy: '开心',
  亲近: '开心', 撒娇: '开心', 俏皮: '开心', 打趣: '开心', 卖萌: '开心',
  // 难过（旧 sad，含原「担心/紧张」回退）
  sad: '难过', sorrow: '难过', heartbroken: '难过', upset: '难过', down: '难过',
  悲伤: '难过', 伤心: '难过', 失落: '难过', 沮丧: '难过', 委屈: '难过', 想哭: '难过',
  anxious: '难过', nervous: '难过', tense: '难过', worried: '难过', panic: '难过', uneasy: '难过',
  担心: '难过', 紧张: '难过', 不安: '难过', 焦虑: '难过', 心慌: '难过', 害怕: '难过',
  // 生气（旧 angry）
  angry: '生气', anger: '生气', mad: '生气', annoyed: '生气', irritated: '生气', furious: '生气',
  愤怒: '生气', 恼火: '生气', 烦: '生气', 火大: '生气',
  // 惊讶（旧 surprised）
  surprised: '惊讶', surprise: '惊讶', shocked: '惊讶', amazed: '惊讶', astonished: '惊讶',
  吃惊: '惊讶', 震惊: '惊讶', 意外: '惊讶',
  // 害羞（旧 shy）
  shy: '害羞', embarrassed: '害羞', blushing: '害羞', bashful: '害羞', awkward: '害羞',
  脸红: '害羞', 不好意思: '害羞', 羞涩: '害羞', 难为情: '害羞',
}

/** 兜底词：词表默认情绪；无词表时内置默认"平静" */
function defWord(palette?: EmotionPaletteRef | null): string {
  return palette?.defaultEmotion || BUILTIN_DEFAULT_EMOTION
}

/**
 * 把 AI 自由情绪词归一化到当前词表（唯一一条归一化链）：
 *  1. 词表精确命中 → 原样返回（软链降级由渲染端查表时进行）；
 *  2. 别名表（旧 6 枚举英文词/近义中文词 → 中文标准词）命中且该词在词表内 → 返回标准词；
 *  3. 其余 → 词表默认情绪。
 * @param raw AI 输出中的情绪标签值
 * @param palette 角色绑定的情绪词表（缺省 = 内置最小词表，仅"平静"）
 */
export function normalizeEmotion(raw: string, palette?: EmotionPaletteRef | null): string {
  const pal = palette ?? builtinPalette()
  const key = raw.trim().toLowerCase()
  if (!key) return pal.defaultEmotion
  const hit = pal.entries.find((e) => e.name.toLowerCase() === key)
  if (hit) return hit.name
  // 别名第二跳：旧枚举英文词/近义词 → 中文标准词 → 若在词表内则命中
  const aliased = EMOTION_ALIASES[key]
  if (aliased && pal.entries.some((e) => e.name === aliased)) return aliased
  return pal.defaultEmotion
}

/** 单个原始 emotion 值的依从判定（词表微调观测用）：
 *  hit = 词表精确命中；alias = 别名表接住（旧枚举英文词/近义词映射进词表）；miss = 无效值回落默认词。 */
export function emotionAdherence(raw: string, palette?: EmotionPaletteRef | null): 'hit' | 'alias' | 'miss' {
  const pal = palette ?? builtinPalette()
  const key = raw.trim().toLowerCase()
  if (!key) return 'miss'
  if (pal.entries.some((e) => e.name.toLowerCase() === key)) return 'hit'
  const aliased = EMOTION_ALIASES[key]
  if (aliased && pal.entries.some((e) => e.name === aliased)) return 'alias'
  return 'miss'
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
 * @param palette 角色绑定的情绪词表（null = 走旧 6 枚举链路）
 * 返回：
 *   text            剥离所有标签后的纯净文本（用于显示/落盘）
 *   emotion         末尾兜底情绪（未命中落默认词）
 *   sentences       按标点切分的句子序列
 *   emotionSegments 句子级情绪切换点（startSentence 0 基）
 */
export function extractEmotion(content: string, palette?: EmotionPaletteRef | null): {
  text: string
  emotion: string
  sentences: string[]
  emotionSegments: EmotionSegment[]
} {
  const trimmed = content.trimEnd()
  let text = trimmed
  let emotion: string = defWord(palette)
  // 1. 末尾兜底标签
  const tail = EMOTION_TAG.exec(trimmed)
  if (tail) {
    text = trimmed.slice(0, tail.index).trimEnd()
    emotion = normalizeEmotion(tail[1] ?? '', palette)
  }
  // 2. 内嵌情绪点（位置在去掉末尾标签后的文本上计算）
  const embeds: { offset: number; emotion: string }[] = []
  EMBED_EMOTION_TAG.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = EMBED_EMOTION_TAG.exec(text))) {
    embeds.push({ offset: m.index, emotion: normalizeEmotion(m[1] ?? '', palette) })
  }
  // 3. 移除所有标签，得到纯净文本；同时修正 embed offset（标签本身被删除会改变后续偏移）
  let clean = ''
  let removed = 0
  EMBED_EMOTION_TAG.lastIndex = 0
  const consumed: { offset: number; emotion: string }[] = []
  let cm: RegExpExecArray | null
  let cursor = 0
  while ((cm = EMBED_EMOTION_TAG.exec(text))) {
    clean += text.slice(cursor, cm.index) + ' '
    removed += cm[0].length + 1 // 标签 + 代替空格
    cursor = EMBED_EMOTION_TAG.lastIndex
    consumed.push({ offset: cm.index - removed, emotion: normalizeEmotion(cm[1] ?? '', palette) })
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

/**
 * 从思考通道文本（reasoning_content / <think> 内文）中抢救正文：
 * 思考型模型偶发把最终 dialogue JSON 写进思考里、content 通道为空（或思考耗尽 token 被截断）。
 * 仅当能完整解析出非空 dialogue 数组时返回解析结果，否则返回 null（由调用方走重试）。
 */
export function salvageDialogueFromText(content: string, palette?: EmotionPaletteRef | null): ReturnType<typeof parseDialogueJson> | null {
  const parsed = tryParseDialogueBlock(content)
  if (!parsed) return null
  const hasText =
    Array.isArray(parsed?.dialogue) &&
    parsed.dialogue.some((it) => typeof it?.text === 'string' && it.text.trim() !== '')
  return hasText ? parseDialogueJson(content, palette) : null
}

/**
 * 全角标点 JSON 结构修复（模型偶发把 JSON 结构字符写成全角/裸值的兜底，2026-09-26 线上案例）：
 * 1. 全角双引号 " " → 半角 "（JSON 输出里全角引号必然是结构字符笔误）；
 * 2. "text"/"emotion" 裸值补引号（线上样例："text"：（动作描写） 值没加引号、字段间还缺逗号）；
 * 3. 字符串字面量之外的 ： → : 、，→ ,（状态机扫描，进入字符串后不改动内容，台词里的中文标点不受污染）；
 * 4. 行尾引号与次行行首引号之间补逗号（"text" 与 "emotion" 分行书写且缺逗号的形态）；
 * 5. 缺失的根 { } 补齐（模型偶发漏掉最外层花括号，直接以 "dialogue": [ 开头）。
 * 只修结构、不动字符串内容，也不保证结果合法；调用方需重试 JSON.parse 并保留原失败兜底。
 */
function repairFullWidthJson(raw: string): string {
  // 1) 全角双引号（U+201C/U+201D）→ 半角
  let s = raw.replace(/[\u201C\u201D]/g, '"')
  // 2) 裸值补引号：必须先于第 3 步，否则裸值内容会被当作"字符串外"而误改其中的中文标点。
  //    值的边界：行尾 / 引号 / 结构符（, } ]），首个字符须非引号（已带引号的合法输出不命中）
  s = s.replace(
    /"(text|emotion)"\s*[:：]\s*((?:[^"\s,}\]])[^\n"",}\]]*)/g,
    (_m, key: string, val: string) => `"${key}":"${val.trim().replace(/,+$/, '')}"`,
  )
  // 3) 字符串外全角冒号/逗号 → 半角
  let out = ''
  let inStr = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    if (inStr) {
      if (ch === '\\') {
        out += ch + (s[i + 1] ?? '')
        i++
        continue
      }
      if (ch === '"') inStr = false
    } else if (ch === '"') {
      inStr = true
    } else if (ch === '\uFF1A') {
      out += ':'
      continue
    } else if (ch === '\uFF0C') {
      out += ','
      continue
    }
    out += ch
  }
  s = out
  // 4) 行尾引号与次行行首引号之间补逗号
  s = s.replace(/"\s*\n(\s*")/g, '",\n$1')
  // 5) 缺失的根花括号补齐
  const t = s.trim()
  if (t.startsWith('"') && /"dialogue"/.test(t)) {
    s = '{' + t + (t.endsWith(']') ? '}' : ']}')
  } else if (t.startsWith('{') && t.endsWith(']')) {
    s = t + '}'
  }
  return s
}

/**
 * 末级兜底（2026-10-02 变体）：结构字符被全角引号逐个包裹（“{“text”:“X”}”）。
 * 该形态无法用引号转换修复（键开引号天然紧贴 {，与包裹引号无法局部区分），改为直接扫描
 * 提取 text/emotion 值对——值内允许全角标点/引号，ASCII 逗号会截断（尽力 salvage）。
 * @returns 提取到的值对数组；无法提取时返回 null
 */
function salvageWrappedDialogue(raw: string): Array<{ text: string; emotion?: string }> | null {
  if (!/[“”]/.test(raw)) return null
  const items: Array<{ text: string; emotion?: string }> = []
  // 逐块扫描 {..}（该变体 item 内无嵌套花括号），块内按键提取 text/emotion 并剥包裹引号；
  // 不用单正则匹配整 item——包裹引号与正常键引号在“紧贴 {”上无法局部区分，块内提取更稳
  const blockRe = /\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(raw))) {
    const inner = m[1]!
    if (!inner.includes('text')) continue
    const km = inner.match(/text[”"]?\s*[:：]\s*([\s\S]*?)(?:,\s*[“”"]?emotion[””"]?\s*[:：]\s*([\s\S]*?))?\s*[”"]?\s*$/)
    if (!km) continue
    // 剥键值两侧的包裹引号（全角/ASCII 混用都能命中）
    const text = (km[1] ?? '').replace(/^[“"]+/, '').replace(/[”"]+$/, '').trim()
    const emotion = (km[2] ?? '').replace(/^[“"]+/, '').replace(/[”"]+$/, '').trim() || undefined
    if (text) items.push({ text, emotion })
  }
  return items.length > 0 ? items : null
}

/** 宽松解析单个对话项对象：JSON.parse 失败后做全角结构修复重试 */
function tryParseItemLoose(raw: string): { text?: string; emotion?: string } | null {
  try {
    return JSON.parse(raw) as { text?: string; emotion?: string }
  } catch {
    try {
      return JSON.parse(repairFullWidthJson(raw)) as { text?: string; emotion?: string }
    } catch {
      return null
    }
  }
}

/**
 * 从 open（开引号索引）起找与之配对的闭引号索引，跳过 \ 转义对。
 * 找不到（字符串仍在书写中/被截断）返回 -1。
 */
function findStringEnd(s: string, open: number): number {
  for (let i = open + 1; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === '"') return i
  }
  return -1
}

/**
 * 截断 JSON 补全（2026-10-02 线上案例：流被截断在字符串值/数组/对象中间，如 `{"dialogue": ["（`）：
 * 状态机扫描后按需补齐未闭合的字符串引号、] 与 }，使截断前的完整项可被解析抢救。
 * 只补结构闭合符、不动内容；补全后不保证语义完整，由调用方 JSON.parse 验证。
 */
function completeTruncatedJson(raw: string): string {
  let inStr = false
  let depthObj = 0
  let depthArr = 0
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (inStr) {
      if (ch === '\\') {
        i++
        continue
      }
      if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depthObj++
    else if (ch === '}') depthObj--
    else if (ch === '[') depthArr++
    else if (ch === ']') depthArr--
  }
  let s = raw
  if (inStr) s += '"'
  if (depthArr > 0) s += ']'.repeat(depthArr)
  if (depthObj > 0) s += '}'.repeat(depthObj)
  return s
}

/**
 * 宽松解析 dialogue JSON 块：先按原文取块解析；失败则对整段做全角结构修复后重新取块重试。
 * 截断补全不放这里：补全可能抢救出残缺半截回复，须在 parseDialogueJson 兜底链里做质量把关。
 * 返回 null 表示两种方式都失败（由调用方走既有兜底）。
 */
function tryParseDialogueBlock(content: string): { dialogue?: unknown; background?: unknown } | null {
  const block = extractJsonBlock(content)
  if (block) {
    try {
      return JSON.parse(block) as { dialogue?: unknown; background?: unknown }
    } catch {
      // fallthrough：全角结构修复后重试
    }
  }
  try {
    // 对整段（而非已截坏的块）修复：缺根花括号时 extractJsonBlock 抓到的首块是首个台词项，
    // 修不好根对象；先补全结构再重新取块才能拿到完整 {"dialogue":[...]}
    const repaired = extractJsonBlock(repairFullWidthJson(content))
    if (!repaired) return null
    return JSON.parse(repaired) as { dialogue?: unknown; background?: unknown }
  } catch {
    return null
  }
}

/** JSON 字符串值转义还原（\n、\"、\uXXXX 等） */
function decodeJsonString(raw: string): string {
  return raw
    .replace(/\\(["\\/bfnrt])/g, '$1')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)))
}

/**
 * 补全 text 值内未闭合的括号（模型偶发漏写右括号，2026-10-02 线上案例：
 * "text":"（听到这句话，……轻轻晃动"）。
 * 全角/半角分别配平，仅当差值 ≤2 且结尾不是闭合括号时在末尾补齐——中间成对缺失不动（保守）。
 */
function fixUnclosedBrackets(text: string): string {
  let out = text
  for (const [open, close] of [['（', '）'], ['(', ')']] as const) {
    let openCount = 0
    let closeCount = 0
    for (const ch of out) {
      if (ch === open) openCount++
      else if (ch === close) closeCount++
    }
    const diff = openCount - closeCount
    if (diff > 0 && diff <= 2 && !out.trimEnd().endsWith(close)) {
      out = out + close.repeat(diff)
    }
  }
  return out
}

/**
 * 全局剥除括号旁白组（全角（）与半角 ()），含未闭合的行尾/文尾残组；
 * 组前的紧邻空格随组一并移除，避免剥除后残留孤立空格。
 * 「回答仅含台词」开关的解析层兜底：prompt 拦不住的偶发括号输出在此剥掉，
 * 纯括号项剥后为空由调用方跳过。不处理嵌套括号（与旁白识别口径一致）。
 */
export function stripParenGroups(text: string): string {
  return text.replace(/[ \t]*（[^（）]*）|[ \t]*\([^()]*\)|[ \t]*（[^（）]*$|[ \t]*\([^()]*$/g, '')
}

/**
 * 解析结构化 JSON dialogue 输出（prompt 强制契约）。
 * 每个元素是一个台词节拍 { text, emotion }，按元素顺序拼接成段落文本，
 * 并把每项的 emotion 落到其首句的句子索引上生成 emotionSegments（相邻相同合并）。
 *
 * 剧情导演指令联动（设计文档 7.3）：模型可在 JSON 顶层额外输出可选 "background" 键
 * （背景引用），由剧情引擎解析后走现有 background 事件通道；普通聊天不会出现该键。
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
 *   background      剧情联动的背景引用（顶层可选键；缺省 undefined）
 */
export function parseDialogueJson(content: string, palette?: EmotionPaletteRef | null): {
  text: string
  emotion: string
  sentences: string[]
  emotionSegments: EmotionSegment[]
  chunks: DialogueChunk[]
  background?: string
  /** 归一化前的原始 emotion 值数组（依从率统计用；字符串元素变体无 emotion 记空串，兜底路径为空数组） */
  rawEmotions: string[]
} {
  const parsed = tryParseDialogueBlock(content)
  let dialogue: Array<{ text?: string; emotion?: string }> = []
  let background: string | undefined
  if (parsed) {
    if (Array.isArray(parsed.dialogue)) {
      // dialogue 数组元素兼容两种形态：{text, emotion} 对象（标准）与纯字符串（模型偶发的简化变体，
      // 字符串元素视作一段正文、情绪 neutral）——不支持后者时整条解析会退化为"JSON 源码当正文"
      dialogue = (parsed.dialogue as Array<unknown>).map((it) =>
        typeof it === 'string' ? { text: it } : (it as { text?: string; emotion?: string }),
      )
    }
    if (typeof parsed.background === 'string' && parsed.background.trim()) background = parsed.background.trim()
  }
  const items = dialogue.filter((it) => typeof it?.text === 'string' && it.text.trim() !== '')

  if (items.length === 0) {
    // 末级兜底（2026-10-02 变体）：结构字符被全角引号逐个包裹时，直接扫描提取 text/emotion 值对
    const salvaged = salvageWrappedDialogue(content)
    if (salvaged) {
      const sItems = salvaged
        .map((it) => ({ text: fixUnclosedBrackets(it.text), emotion: normalizeEmotion(it.emotion ?? '', palette) }))
        .filter((it) => it.text)
      if (sItems.length > 0) {
        const sText = sItems.map((it) => it.text).join('\n')
        const sentences = splitSentences(sText)
        const chunks: DialogueChunk[] = sItems.map((it) => ({ text: it.text, emotion: it.emotion }))
        const emotionSegments: EmotionSegment[] = []
        let sentCursor = 0
        for (const it of sItems) {
          const n = splitSentences(it.text).length
          const prev = emotionSegments[emotionSegments.length - 1]
          if (!prev || prev.emotion !== it.emotion) emotionSegments.push({ startSentence: sentCursor, emotion: it.emotion })
          sentCursor += n
        }
        return {
          text: sText,
          emotion: sItems[sItems.length - 1]!.emotion,
          sentences,
          emotionSegments,
          chunks,
          background,
          rawEmotions: salvaged.map((it) => it.emotion ?? ''),
        }
      }
    }
    // 结构化解析失败（如 dialogue JSON 未完整闭合 / 被截断 / 降级输出）。
    // 先尽力从原始输出中提取各 "text" 台词值，避免把整段原始 JSON 外露成文本、或拿去朗读；
    // 抢救出的正文须含实质台词（剥括号后非空）——纯括号/空半截不走此路，落到截断补全/拒收重试
    const prose = extractStreamingJsonText(content)
    if (prose && prose !== content && stripParenGroups(prose).trim()) {
      return {
        text: prose,
        emotion: defWord(palette),
        sentences: splitSentences(prose),
        emotionSegments: [{ startSentence: 0, emotion: defWord(palette) }],
        chunks: [{ text: prose, emotion: defWord(palette) }],
        background,
        rawEmotions: [],
      }
    }
    // 截断补全抢救（2026-10-02 线上案例：流被截断在 `{"dialogue": ["（` 之类的半截 JSON）：
    // 补齐未闭合的引号/]/} 后重解析，仅当抢救出实质台词（剥括号后非空）才采用截断前的完整项；
    // 纯括号/垃圾半截不采用 → 落到下方 JSON 形态拒收返回空，由调用方触发空回复自动重试
    const repairedRaw = repairFullWidthJson(content)
    const completedRaw = completeTruncatedJson(repairedRaw)
    if (completedRaw !== repairedRaw) {
      const reparsed = parseDialogueJson(completedRaw, palette)
      if (reparsed.chunks.some((c) => stripParenGroups(c.text).trim())) {
        return { ...reparsed, background }
      }
    }
    // JSON 形态拒收：结构化解析全失败但原文仍是 JSON 形态（截断/残缺的 dialogue 输出），
    // 绝不把 JSON 源码当正文（曾导致 TTS 朗读 "dialogue: "）→ 返回空文本触发调用方自动重试
    const jsonish = content.trim()
    if (jsonish.startsWith('{') || jsonish.startsWith('[') || /["\u201C]dialogue["\u201D]/.test(jsonish)) {
      return { text: '', emotion: defWord(palette), sentences: [], emotionSegments: [], chunks: [], background, rawEmotions: [] }
    }
    // 回退旧式标签解析（历史消息兼容），否则整段默认情绪
    try {
      const fallback = extractEmotion(content, palette)
      return { ...fallback, chunks: [{ text: fallback.text, emotion: fallback.emotion }], rawEmotions: [] }
    } catch {
      const single: DialogueChunk = { text: content, emotion: defWord(palette) }
      return { text: content, emotion: defWord(palette), sentences: splitSentences(content), emotionSegments: [{ startSentence: 0, emotion: defWord(palette) }], chunks: [single], background, rawEmotions: [] }
    }
  }

  // 拼接段落文本（单换行分隔，去掉过密的空行，保持与 AssistantSentences 段级展示一致）；
  // 先转义还原再补未闭合括号（2026-10-02 线上案例：模型漏写右括号导致纯旁白块被朗读）
  const decodeText = (t: string) => fixUnclosedBrackets(decodeJsonString(t.trim()))
  const text = items.map((it) => decodeText(it.text!)).join('\n')
  const sentences = splitSentences(text)
  // 合成分段：每个 dialogue 项一条，段级合成（不再按标点切碎）+ 段级切立绘
  const chunks: DialogueChunk[] = items.map((it) => ({
    text: decodeText(it.text!),
    emotion: normalizeEmotion(it.emotion ?? '', palette),
  }))

  // 逐项累计句子数，把每项情绪落到其首句索引
  const emotionSegments: EmotionSegment[] = []
  let sentCursor = 0
  for (const it of items) {
    const n = splitSentences(decodeText(it.text!)).length
    const emo = normalizeEmotion(it.emotion ?? '', palette)
    const prev = emotionSegments[emotionSegments.length - 1]
    if (!prev || prev.emotion !== emo) emotionSegments.push({ startSentence: sentCursor, emotion: emo })
    sentCursor += n
  }
  if (emotionSegments.length === 0) emotionSegments.push({ startSentence: 0, emotion: defWord(palette) })
  const emotion = normalizeEmotion(items[items.length - 1]?.emotion ?? '', palette)

  return { text, emotion, sentences, emotionSegments, chunks, background, rawEmotions: items.map((it) => it.emotion ?? '') }
}

/**
 * 流式"情绪块"已闭合项增量提取：从 fromCursor 之后提取所有**已完整闭合**的 dialogue 项
 * （`{ "text":..., "emotion":... }`，text 非空），供主进程在流式 onChunk 中逐块实时触发语音。
 *
 * - 只处理以 `"text"` 或 `"emotion"` 开头的扁平对象（对话项），自动跳过根对象 `{"dialogue":...}`
 *   及其它非对话对象，使 cursor 落在 dialogue 数组内部逐个推进。
 * - 遇未闭合/非法对象时立即停止（等更多 token），cursor 停在原地以便下一次用更长文本重试。
 * - cursor 语义：已消费的 partial 字符索引（与分析用的 partial 字符串保持一致）。
 */
export function extractDialogueChunkDelta(partial: string, fromCursor: number, palette?: EmotionPaletteRef | null): { items: Array<{ text: string; emotion: string }>; cursor: number } {
  const items: Array<{ text: string; emotion: string }> = []
  let cursor = fromCursor
  while (true) {
    const open = partial.indexOf('{', cursor)
    const quote = partial.indexOf('"', cursor)
    // 纯字符串数组变体（2026-10-02 线上案例）：引号先于花括号出现 = dialogue 数组里的裸字符串元素，
    // 视作 {text, 默认情绪} 对话项提取，保证流式语音链对该变体照常触发（否则零提取 → 语音全押兜底）。
    // 仅认「数组元素位置」的引号（前一个非空白字符是 [ 或 ,），避免把 "dialogue" 等键名误当台词。
    if (quote !== -1 && (open === -1 || quote < open)) {
      const end = findStringEnd(partial, quote)
      const before = partial.slice(0, quote).replace(/\s/g, '').slice(-1)
      if (before !== '[' && before !== ',') {
        // 非元素位置的引号（键名/键值结构符）：跳到该字符串之后继续扫描
        cursor = end === -1 ? partial.length : end + 1
        continue
      }
      if (end === -1) break // 字符串仍在书写中，等待更多 token
      const text = decodeJsonString(partial.slice(quote + 1, end)).trim()
      if (text) items.push({ text: fixUnclosedBrackets(text), emotion: normalizeEmotion('', palette) })
      cursor = end + 1
      continue
    }
    if (open === -1) break
    const afterBrace = partial.slice(open + 1).replace(/^\s*/, '')
    // 键名引号半角/全角都识别（模型偶发把结构引号写成全角，2026-09-26 线上案例）
    const isDialogueItem = /^["\u201C](?:text|emotion)["\u201D]/.test(afterBrace)
    if (!isDialogueItem) {
      // 根对象 {"dialogue":[...]}：跳进其数组内部（定位 '[' 之后），而非跳过整根——
      // 否则会把整段都跳过，永远扫不到内层对话项，导致流式语音块不触发。
      if (/^["\u201C]dialogue["\u201D]/.test(afterBrace)) {
        const arr = partial.indexOf('[', open)
        if (arr === -1) break
        cursor = arr + 1
        continue
      }
      // 其它非对话对象（可能的额外包裹层）：跳过其闭合
      const cl = findObjectEnd(partial, open)
      if (cl === -1) break
      cursor = cl + 1
      continue
    }
    const close = findObjectEnd(partial, open)
    if (close === -1) break // 该项未闭合，等待更多
    const raw = partial.slice(open, close + 1)
    const obj = tryParseItemLoose(raw)
    if (!obj) {
      // 末级兜底（2026-10-02 包裹变体）：item 级修复仍失败时直接扫描提取 text/emotion
      const salvaged = salvageWrappedDialogue(raw)
      if (salvaged && salvaged.length > 0) {
        for (const it of salvaged) {
          if (it.text) items.push({ text: fixUnclosedBrackets(it.text), emotion: normalizeEmotion(it.emotion ?? '', palette) })
        }
        cursor = close + 1
        continue
      }
      break // 非法/不完整：停在 open，待更长文本重试
    }
    const text = obj?.text?.trim()
    if (text) items.push({ text: fixUnclosedBrackets(text), emotion: normalizeEmotion(obj?.emotion ?? '', palette) })
    cursor = close + 1
  }
  return { items, cursor }
}

/**
 * 从 open（'"{' 索引）起找出与之配对的 '}' 索引。
 * 跳过字符串值（含转义引号）内的 {} 与引号，避免被台词文本中的花括号干扰。
 * 找不到则返回 -1（表示未闭合，等待更多 token）。
 */
function findObjectEnd(s: string, open: number): number {
  let inStr = false
  let depth = 0
  for (let i = open; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (ch === '\\') { i++; continue }
      if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) return i }
  }
  return -1
}

/**
 * 流式上屏用的裸字符串数组提取（2026-10-02 线上案例变体）：
 * dialogue 数组元素是无键名裸字符串（无 "text" 键可命中），逐个提取已闭合字符串 +
 * 正在书写的最后一个（保留流式打字感）。遇到对象元素（'{'）说明不是该变体
 * （text 键正则本就会命中），防御性返回空串由调用方走既有逻辑。
 */
function extractBareStringArray(partial: string): string {
  const dm = /["\u201C]dialogue["\u201D]\s*[:：]\s*\[/.exec(partial)
  if (!dm) return ''
  const body = partial.slice(dm.index + dm[0].length)
  const out: string[] = []
  let i = 0
  while (i < body.length) {
    const ch = body[i]
    if (ch === '{') return ''
    if (ch === '"') {
      const end = findStringEnd(body, i)
      if (end === -1) {
        // 正在书写中的最后一个字符串：取已写出的部分实时上屏
        const wip = decodeJsonString(body.slice(i + 1)).trim()
        if (wip) out.push(wip)
        break
      }
      const v = decodeJsonString(body.slice(i + 1, end)).trim()
      if (v) out.push(v)
      i = end + 1
      continue
    }
    i++
  }
  return out.length > 0 ? out.join('\n') : ''
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
  // "text" 值三种形态：半角引号（标准）/ 全角引号 / 裸值（模型漏写引号，取到行尾）
  const re =
    /["\u201C]text["\u201D]\s*[:：]\s*(?:"((?:[^"\\]|\\.)*)"|\u201C((?:[^\u201D\\]|\\.)*)\u201D|([^\n"“][^\n"]*))/g
  const out: string[] = []
  let m: RegExpExecArray | null
  let lastEnd = 0
  while ((m = re.exec(partial))) {
    lastEnd = re.lastIndex
    const v = decodeJsonString((m[1] ?? m[2] ?? m[3] ?? '').trim()).trim()
    if (v) out.push(v)
  }

  // 追加正在写入、尚未闭合的最后一个 text 值（从上次匹配末尾之后找 "text": 开头的片段）
  let trailing = ''
  const rel = partial.slice(lastEnd).search(/["\u201C]text["\u201D]\s*[:：]\s*/)
  if (rel !== -1) {
    const after = partial.slice(lastEnd + rel).replace(/^["\u201C]text["\u201D]\s*[:：]\s*/, '')
    if (after.startsWith('"') || after.startsWith('\u201C')) {
      // 引号值：取到第一个未转义的引号为止（该值要么闭合，要么仍在书写中）
      const partialVal = after.slice(1).split(/(?<!\\)["\u201D]/)[0] ?? ''
      if (partialVal.trim()) trailing = decodeJsonString(partialVal)
    } else {
      // 裸值：取到行尾（正在书写中时即当前行已写出的部分）
      const partialVal = after.split('\n')[0] ?? ''
      if (partialVal.trim()) trailing = partialVal
    }
  }

  // trailing 为空时不再多拼一个空段，避免输出末尾多出换行
  const joined = (trailing ? [...out, trailing] : out).join('\n')
  if (out.length === 0 && !trailing) {
    // 纯字符串数组变体（2026-10-02）：dialogue 元素是无键名裸字符串，无 "text" 键可提取
    const bare = extractBareStringArray(partial)
    if (bare) return bare
    // 没有任何 text 键：若不是 JSON（即不含花括号），可能是模型未按 JSON 输出的纯文本，
    // 退化回放原始文本，保住流式与后续语音触发。
    return /[{}\[\]]/.test(partial) ? '' : partial
  }
  return joined
}

/** 开头旁白正则：从文本第一个字符起、连续的（…）/(…) 括号组（组间允许空白/换行），
 *  遇到第一个台词字符即止。只匹配已闭合的括号组——流式中尚未写完的括号留待下次
 *  flush 再上屏，保证已前置文本的前缀稳定（Typewriter 只增不减依赖这一点）。 */
const LEADING_NARRATION_RE = /^(?:\s|(?:（[^（）]*）|\([^()]*\)))+/

/**
 * 提取回答开头的连续括号旁白（旁白前置上屏用）。
 * 只认"位于最前面"的括号组：台词出现后的括号（中间动作描写）不属于开头旁白，
 * 仍随其所在语音段上屏（段随语音，现状不变）。
 * @param display 流式提取的纯净文本（extractStreamingJsonText 的产物）
 * @returns 开头连续括号组原文（含组间空白）；无开头旁白返回空串
 */
export function extractLeadingNarration(display: string): string {
  if (!display) return ''
  const m = LEADING_NARRATION_RE.exec(display)
  return m ? m[0] : ''
}

/**
 * 把前置旁白文本解析为括号组数组（剥掉组间空白/换行）。
 * 逐组消费用于语音块剥除：一个括号组整体位于单个 dialogue 项内，
 * 块边界只可能落在组与组之间，逐组匹配即可精确对齐。
 */
export function splitNarrationGroups(narration: string): string[] {
  return narration.match(/（[^（）]*）|\([^()]*\)/g) ?? []
}

/**
 * 从语音块文本开头逐组剥掉已前置上屏的括号组（避免跟读气泡里旁白重复显示）。
 * @param text 语音块文本（dialogue 项原文 join）
 * @param groups 已前置旁白的括号组数组（splitNarrationGroups 产物）
 * @param consumed 已消费组数游标（跨块推进，调用方持有同一对象）
 * @returns 剥除后的块文本；纯前置旁白块剥后为空（调用方据此跳过合成投放）
 */
export function consumeLeadingNarration(text: string, groups: string[], consumed: { count: number }): string {
  let t = text
  while (consumed.count < groups.length) {
    const stripped = t.replace(/^\s+/, '')
    const group = groups[consumed.count]
    if (!group || !stripped.startsWith(group)) break
    t = stripped.slice(group.length)
    consumed.count++
  }
  return t
}