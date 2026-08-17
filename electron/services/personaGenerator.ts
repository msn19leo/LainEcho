/**
 * AI 角色人设生成服务。
 * 根据用户提供的角色来源描述（原作设定/台词/简介等），让 LLM 按 CharacterPersona
 * 模板输出结构化的"动漫角色复刻"人设。产物只是草稿，由渲染进程回填编辑器，
 * 需用户确认后才入库。API Key 只在主进程内存中使用，不经过 IPC 传给渲染进程。
 */
import type { CharacterPersona, PersonaGenerateInput } from '../../src/types'
import { sendChatCompletion } from './aiClient'
import { readApiKey } from './crypto'
import { getSettings } from './repository'

/** 生成时使用的 JSON 结构说明（作为 system prompt 的骨架约束） */
const JSON_SCHEMA_HINT = `{
  "anchor": "存在锚点：用1-3句话定性这个角色的本质",
  "inner": {
    "desire": "核心渴望：真正想要什么（最深的驱动）",
    "fear": "内在恐惧：本能回避什么",
    "conflict": "核心矛盾：A，但同时又B的张力，以及如何体现在行为中",
    "selfView": "自我认知状态：她/他怎么看自己，盲区在哪"
  },
  "perception": {
    "attention": "注意什么：对什么敏感、会忽略什么",
    "emotion": "情绪处理机制：表达还是内化",
    "worldview": "对外部世界的态度：世界在她/他眼里什么样"
  },
  "relation": {
    "approach": "靠近人的方式：主动还是被动",
    "intimacy": "亲密建立的节奏：怎么从陌生到熟悉",
    "boundary": "她/他的边界：不可触碰之物、被越界时的反应",
    "need": "对'被需要'的态度"
  },
  "you": {
    "identity": "你是谁：结合来源信息给出用户在角色世界里的身份定位；若未指定，用'① 无身份的观察者（来自外部的存在）'",
    "bond": "",
    "stance": "AI角色怎么看你：从角色视角写如何感知用户，允许'还没搞清楚'的不确定性",
    "memories": []
  },
  "language": {
    "rhythm": "说话节奏：快/慢、停顿、留白",
    "words": "用词特征：正式/口语、习惯句式",
    "neverSay": ["不会说的话1", "不会说的话2", "..."],
    "habits": "特殊的语言行为：反问、自言自语、重复等"
  },
  "state": {
    "daily": "日常状态：默认的样子",
    "triggers": "触发变化的开关：什么会让她/他突然不一样",
    "situations": "不同情境下的状态变化"
  },
  "worldview": ["世界观碎片1（角色口吻）", "..."],
  "prohibitions": ["禁止项1", "..."],
  "extra": ""
}`

/** 系统提示词：规定复刻原则与输出格式 */
const SYSTEM_PROMPT = `你是动漫角色复刻专家。用户会提供某部动漫角色的来源信息，请据此生成一份完整的角色人设，用于让 AI 完美再现这个角色。

输出要求：
1. 严格输出一个 \`\`\`json 代码块，代码块内是单个 JSON 对象，除此之外不要输出任何解释文字。
2. 必须是合法 JSON：字符串内的换行用 \\n 转义、双引号用 \\" 转义，不要输出尾逗号。
3. 所有文本用中文（角色本身若习惯日文口癖，可在语句中保留少量日文风味，但整体中文）。
4. 站在"你（这个角色）"的角度写作，让模型把内容当成自己的设定而非第三人称介绍。
5. "语言质感"的 neverSay 写 5-8 句"出戏"的表达（如"没问题！""哈哈哈哈哈"这类毁掉角色感的句子）。
6. "世界观碎片"写 3-6 条，用角色自己的语气、真实想法的碎片，不是金句。
7. "禁止项"只写 3-5 条最高优先级的硬性边界，其余约束改写为肯定句。
8. 未提及的信息不要凭空捏造；来源信息不足时，用角色原作中可推断的气质补全，并保持克制。
9. "you"字段只需生成 identity 和 stance 两项；bond、memories 保持空字符串/空数组（用户会自己填写，只有用户知道他和角色的具体关系）。

JSON 结构（严格按此结构输出）：
${JSON_SCHEMA_HINT}`

/** 安全尝试 JSON.parse，返回成功值或错误信息 */
function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 修复 LLM 常见的 JSON 瑕疵（逐字符扫描，维护 inString 状态避免误伤）：
 * - 字符串值内的字面换行（多行文本被直接写成真实换行）→ 转义为 \n
 * - 对象/数组末项后的尾逗号 → 删除
 */
function repairJsonText(text: string): string {
  let out = ''
  let inString = false
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i]!
    if (inString) {
      if (ch === '\\') {
        // 保留转义序列（含被转义的引号/反斜杠）
        out += ch
        if (i + 1 < n) {
          out += text[i + 1]!
          i++
        }
      } else if (ch === '"') {
        inString = false
        out += ch
      } else if (ch === '\n' || ch === '\r') {
        // 字符串内的真实换行 → 转义为 \n（CRLF 只记一个）
        out += '\\n'
        if (ch === '\r' && text[i + 1] === '\n') i++
      } else {
        out += ch
      }
      i++
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      i++
      continue
    }
    if (ch === ',') {
      // 逗号后紧跟 } 或 ]（跳过空白）→ 尾逗号，丢弃
      let j = i + 1
      while (j < n && /\s/.test(text[j]!)) j++
      if (text[j] === '}' || text[j] === ']') {
        i++
        continue
      }
      out += ch
      i++
      continue
    }
    out += ch
    i++
  }
  return out
}

/**
 * 从 LLM 输出中提取并解析 JSON。
 * 依次尝试：
 * 1. 提取 ```json ... ``` 代码块（若存在）
 * 2. 从首个 { 到文本末尾直接解析
 * 3. 修复常见瑕疵（字符串内字面换行、尾逗号）后重试
 * 4. 从末尾向前逐个 } 截取重试（容忍 JSON 后跟多余文本/注释）
 */
function parseJsonTolerant(raw: string): unknown {
  const trimmed = raw.trim()
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = (fence ? fence[1]! : trimmed).trim()
  const start = candidate.indexOf('{')
  if (start === -1) throw new Error('生成结果中未找到 JSON 对象')

  // 2. 直接解析
  const direct = tryParseJson(candidate.slice(start))
  if (direct.ok) return direct.value

  // 3. 修复后重试
  const repaired = repairJsonText(candidate.slice(start))
  const repairedTry = tryParseJson(repaired)
  if (repairedTry.ok) return repairedTry.value

  // 4. 从末尾向前逐个 } 截取重试（容忍尾部杂音），并对每个候选做修复
  let end = repaired.length
  while (end > start) {
    const idx = repaired.lastIndexOf('}', end - 1)
    if (idx < start) break
    const seg = repaired.slice(start, idx + 1)
    const t = tryParseJson(seg)
    if (t.ok) return t.value
    end = idx
  }

  throw new Error(
    `JSON 解析失败：${direct.error ?? repairedTry.error}（已尝试自动修复仍无效，可能是输出被截断，请重试）`,
  )
}

/** 从任意 JSON 中安全提取字符串字段（容忍缺字段/类型不符） */
function pickStr(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** 从任意 JSON 中安全提取字符串数组（容忍单条字符串/数组） */
function pickStrList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((s) => pickStr(s)).filter(Boolean)
  const s = pickStr(v)
  return s ? s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean) : []
}

/** 归一化 LLM 输出为完整的 CharacterPersona（缺失字段置空） */
function normalizeGeneratedPersona(data: unknown): CharacterPersona {
  const d = (data ?? {}) as Record<string, unknown>
  const inner = (d.inner ?? {}) as Record<string, unknown>
  const perception = (d.perception ?? {}) as Record<string, unknown>
  const relation = (d.relation ?? {}) as Record<string, unknown>
  const you = (d.you ?? {}) as Record<string, unknown>
  const language = (d.language ?? {}) as Record<string, unknown>
  const state = (d.state ?? {}) as Record<string, unknown>
  return {
    anchor: pickStr(d.anchor),
    inner: {
      desire: pickStr(inner.desire),
      fear: pickStr(inner.fear),
      conflict: pickStr(inner.conflict),
      selfView: pickStr(inner.selfView),
    },
    perception: {
      attention: pickStr(perception.attention),
      emotion: pickStr(perception.emotion),
      worldview: pickStr(perception.worldview),
    },
    relation: {
      approach: pickStr(relation.approach),
      intimacy: pickStr(relation.intimacy),
      boundary: pickStr(relation.boundary),
      need: pickStr(relation.need),
    },
    you: {
      identity: pickStr(you.identity),
      // bond / memories 由用户手填（AI 不生成，见提示词第 9 条）
      bond: '',
      stance: pickStr(you.stance),
      memories: [],
    },
    language: {
      rhythm: pickStr(language.rhythm),
      words: pickStr(language.words),
      neverSay: pickStrList(language.neverSay),
      habits: pickStr(language.habits),
    },
    state: {
      daily: pickStr(state.daily),
      triggers: pickStr(state.triggers),
      situations: pickStr(state.situations),
    },
    worldview: pickStrList(d.worldview),
    prohibitions: pickStrList(d.prohibitions),
    extra: pickStr(d.extra),
  }
}

/**
 * 调用大模型生成角色人设草稿。
 * @throws 未配置 API Key / baseURL / model 或生成失败时抛用户可读错误
 */
export async function generatePersona(input: PersonaGenerateInput): Promise<CharacterPersona> {
  const settings = await getSettings()
  const apiKey = await readApiKey()
  if (!apiKey) throw new Error('未配置 API Key，请先在「设置 → AI API 配置」中填写')
  if (!settings.baseURL.trim()) throw new Error('未配置 API 地址（baseURL）')
  if (!settings.model.trim()) throw new Error('未配置模型名（model）')

  const source = input.source.trim()
  if (!source) throw new Error('角色来源描述不能为空')
  const userMessage = `角色名：${input.name.trim() || '（未指定）'}\n\n角色来源描述：\n${source}`

  const content = await sendChatCompletion(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    {
      model: settings.model,
      baseURL: settings.baseURL,
      apiKey,
      // 生成人设是结构化 JSON：用固定低温提高格式稳定性，并强制较大 maxTokens 防止输出被截断
      temperature: 0.7,
      maxTokens: settings.maxTokens,
      maxTokensOverride: 4096,
      stream: false,
    },
  )

  let parsed: unknown
  try {
    parsed = parseJsonTolerant(content)
  } catch (err) {
    throw new Error(`AI 返回无法解析的人设 JSON：${err instanceof Error ? err.message : String(err)}`)
  }
  return normalizeGeneratedPersona(parsed)
}
