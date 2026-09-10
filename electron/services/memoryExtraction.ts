/**
 * 记忆自动沉淀：会话流式完成后后台调用 LLM 从对话中抽取值得长期记住的信息，
 * 生成「待确认候选」（confirmed=false）写入记忆库，由用户在设置窗确认/删除。
 *
 * - 独立 prompt + 非流式，与主对话的 JSON 输出契约完全隔离；
 * - 同会话 5 分钟冷却，避免连续重试同一批对话；
 * - 与现有记忆做简单内容去重（完全相同或互相包含即跳过）；
 * - 任何失败静默，不阻塞聊天。
 */
import type { ChatMessage, MemoryCategory, MemoryItem } from '../../src/types'
import { sendChatCompletion } from './aiClient'
import { embedTexts, type EmbeddingConfig } from './memory/embeddingService'
import { resolveEmbeddingConfig, syncMemoryVectors } from './memory/memoryVectors'
import { addPendingMemory, getSettings, listMemories } from './repository'
import { windowManager } from '../windows/windowManager'

/** 每次沉淀抽取的最近对话条数 */
const EXTRACT_RECENT_MESSAGES = 20
/** 触发沉淀的最小消息条数（低于该值对话太短，几乎无长期信息，跳过避免浪费调用） */
const EXTRACT_MIN_MESSAGES = 6
/** 同会话重复沉淀的最小间隔（毫秒） */
const EXTRACT_COOLDOWN_MS = 5 * 60 * 1000
/** 单次最多转入的候选记忆条数（宁缺毋滥） */
const MAX_PER_BATCH = 6
/** 记忆候选最小有效长度（过滤过于琐碎/纯语气词） */
const MIN_CONTENT_LEN = 6
/**
 * 抽取请求输出 token 上限：需比主对话更大，给思考型模型（如 mimo-v2.5-pro）
 * 的 reasoning 留出空间，否则 content 可能为空字符串
 */
const EXTRACT_MAX_TOKENS = 2048

/** 记录每个会话最近一次沉淀时间（内存态，重启即失效） */
const lastExtractAt = new Map<string, number>()

/** 抽取 prompt：独立上下文，绝不混入 EMOTION_PROMPT 的 JSON dialogue 约束 */
const EXTRACT_SYSTEM_PROMPT =
  '你是一个严格的对话记忆提取助手。从「对方(用户)」与「你(角色)」的对话中，' +
  '只提取「真正长期重要」的新信息，忽略寒暄、日常随口一说、能从上下文自然获得的临时信息、以及明显重复的内容。' +
  '只输出 JSON 本体（不要 markdown 代码块、不要任何解释）：{"memories":[{"category":"user_info","content":"..."}]}\n' +
  '- category 只能是：\n' +
  '  user_info = 对方个人信息（姓名/年龄/职业/喜好/雷点/习惯/身份等）\n' +
  '  long_term = 长期经历（重要事件、剧情进展、值得记住的时刻）\n' +
  '  promises = 约定与承诺（明确达成的约定、时间地点、答应做的事）\n' +
  '- 重要性门槛（满足任一才提取）：明确给出的个人信息；具体且有长期价值的约定；会影响后续互动的重要事件。\n' +
  '  不提取：客套话、单纯的情绪宣泄、正在被当前对话解决的一次性事项、过于琐碎的日常。\n' +
  '- 表述视角必须统一：用户一律称「对方」，角色一律称「你」；严禁出现「用户/角色」等标签词作主语。\n' +
  '  例：写「对方喜欢喝椰奶」而非「用户喜欢喝椰奶」；写「你答应明天陪对方去书店」而非「角色答应...」。\n' +
  '  每条尽量只包含一个主语视角、一句话讲清，不超过 40 字。\n' +
  '- 最多返回 6 条；优先保留最具体、最重要者。仅当确实无任何价值时返回 {"memories":[]}。'

/** 抽取结果中的单条记忆 */
interface ExtractedMemory {
  category: MemoryCategory
  content: string
}

/** 判断新记忆是否与现有记忆重复（完全相同或互相包含即视为重复） */
function isDuplicate(content: string, existing: string[]): boolean {
  const c = content.trim()
  return existing.some((e) => {
    const et = e.trim()
    return et === c || (et.length > 8 && (et.includes(c) || c.includes(et)))
  })
}

/** 向量点积（embedTexts 输出已 L2 归一化，点积即余弦相似度） */
function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!
  return dot
}

/**
 * 语义去重：把字符串去重后的候选与同角色已有记忆（含待确认候选）批量嵌入比对，
 * cos ≥ 阈值（memoryDedupThreshold，默认 0.92）即视为语义重复剔除。
 * 嵌入不可用/失败时原样返回（保留字符串去重结果，不阻塞沉淀）。
 * @returns 通过语义去重的候选子集
 */
async function semanticDedup(
  fresh: Array<{ category: MemoryCategory; content: string }>,
  existingScoped: MemoryItem[],
  cfg: EmbeddingConfig,
  threshold: number,
): Promise<Array<{ category: MemoryCategory; content: string }>> {
  if (fresh.length === 0 || existingScoped.length === 0) return fresh
  try {
    const [candVecs, existVecs] = await Promise.all([
      embedTexts(fresh.map((f) => f.content), cfg),
      embedTexts(existingScoped.map((m) => m.content), cfg),
    ])
    return fresh.filter((_, i) => {
      const cv = candVecs[i]
      if (!cv) return false
      return !existVecs.some((ev) => ev !== undefined && cosine(cv, ev) >= threshold)
    })
  } catch (err) {
    console.warn('[memory] 语义去重不可用（跳过，仅保留字符串去重）：', err instanceof Error ? err.message : err)
    return fresh
  }
}

/**
 * 人称视角归一化：统一为「对方=用户、你=角色」，清除混入的「用户/角色/AI」标签。
 * 避免沉淀出的记忆一会"你"一会"对方"一会"角色"，读感混乱。
 */
function normalizePerspective(content: string): string {
  let c = content.replace(/\s+/g, ' ').trim()
  // 句中的孤立"角色/AI"→"你"（角色主语）；孤立"用户"→"对方"（用户主语）
  c = c.replace(/(角色|AI)(?=[，。！？；：、）\s]|$)/g, '你')
  c = c.replace(/(用户)(?=[，。！？；：、）\s]|$)/g, '对方')
  // 压缩多余空格与连续标点
  c = c.replace(/\s+([，。！？；：、])/g, '$1').replace(/,+/g, '，')
  return c.trim()
}

/**
 * 从一次会话的最近对话中抽取记忆候选并写入记忆库。
 * 触发前做同会话冷却、角色卡、API Key、无对话等轻量校验；失败静默。
 * @param params.sessionId 来源会话 id（写入 sourceSessionId 供追溯）
 * @param params.cardId 归属角色卡 id
 * @param params.messages 含本轮 user+assistant 的完整消息序列
 */
export async function extractMemoriesFromSession(params: {
  sessionId: string
  cardId: string
  messages: ChatMessage[]
  settings: { model: string; baseURL: string; apiKey: string }
}): Promise<void> {
  const { sessionId, cardId, messages, settings } = params
  if (!cardId || !settings.apiKey) return
  // 对话过短（不足 3 轮问答）时跳过，避免反复发起注定为空的抽取
  if (messages.length < EXTRACT_MIN_MESSAGES) return

  // 同会话冷却：5 分钟内不重复抽取
  const now = Date.now()
  const last = lastExtractAt.get(sessionId) ?? 0
  if (now - last < EXTRACT_COOLDOWN_MS) return
  lastExtractAt.set(sessionId, now)

  // 取最近一段对话的纯净文本（跳过 UI 元数据）；用「对方/你」标注，与 prompt 视角一致
  const recent = messages.slice(-EXTRACT_RECENT_MESSAGES)
  const dialogueText = recent
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `${m.role === 'user' ? '对方' : '你'}: ${m.content}`)
    .join('\n')
    .trim()
  if (!dialogueText) return

  try {
    const raw = await sendChatCompletion(
      [
        { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
        { role: 'user', content: `以下是对话：\n${dialogueText}\n\n请提取记忆：` },
      ],
      {
        model: settings.model,
        baseURL: settings.baseURL,
        apiKey: settings.apiKey,
        temperature: 0.2,
        stream: false,
        maxTokensOverride: EXTRACT_MAX_TOKENS,
      },
    )
    const parsed = parseExtractionJson(raw)
    if (!parsed || parsed.length === 0) {
      // 打印模型原始返回（截断）与模型名，便于区分「模型判定无信息」/「JSON 解析失败」/「content 为空（思考模型预算被占满）」
      console.log(
        '[memory] 抽取无结果 model=%s 输入对话 %d 字符，原始返回（前 300 字符）：%s',
        settings.model,
        dialogueText.length,
        (raw ?? '').trim().slice(0, 300),
      )
      return
    }

    // 去重 + 过滤 + 人称归一：与本角色（含全局背景）全部记忆、以及本次批次内都去重；
    // 太短/纯语气词的直接丢弃；限定每批最多 MAX_PER_BATCH 条
    const existing = (await listMemories()).map((m) => m.content)
    const seenInBatch: string[] = []
    let fresh: Array<{ category: MemoryCategory; content: string }> = []
    for (const m of parsed) {
      if (fresh.length >= MAX_PER_BATCH) break
      const content = normalizePerspective(m.content)
      if (content.length < MIN_CONTENT_LEN) continue
      if (isDuplicate(content, existing)) continue
      if (isDuplicate(content, seenInBatch)) continue
      seenInBatch.push(content)
      fresh.push({ category: m.category, content })
    }
    if (fresh.length === 0) return

    // 语义去重（可选）：嵌入配置完整时，与同角色已有记忆（含待确认候选）做向量比对，
    // cos ≥ memoryDedupThreshold 的候选剔除；嵌入不可用时静默跳过
    const embedCfg = await resolveEmbeddingConfig()
    if (embedCfg) {
      const appSettings = await getSettings()
      const scoped = (await listMemories()).filter(
        (m) => m.characterCardId === cardId || m.characterCardId === null,
      )
      fresh = await semanticDedup(fresh, scoped, embedCfg, appSettings.memoryDedupThreshold)
      if (fresh.length === 0) {
        console.log('[memory] 全部候选被语义去重拦截')
        return
      }
    }

    const written: MemoryItem[] = []
    for (const m of fresh) {
      written.push(
        await addPendingMemory({
          content: m.content,
          category: m.category,
          characterCardId: cardId,
          sourceSessionId: sessionId,
        }),
      )
    }
    if (written.length > 0) {
      // 广播记忆变更给设置窗刷新（待确认列表）
      windowManager.broadcast('memory:changed')
      console.log('[memory] 自动沉淀 %d 条候选记忆', written.length)
      // 候选即时嵌入向量（确认后无需重算；失败由启动补偿兜底）
      void syncMemoryVectors(written)
    }
  } catch (err) {
    // 沉淀失败静默：不阻塞聊天、不影响用户
    console.warn('[memory] 自动沉淀失败：', err)
  }
}

/** 解析抽取结果 JSON：容忍 markdown 围栏与前后杂文本；无有效记忆返回 null */
function parseExtractionJson(raw: string): ExtractedMemory[] | null {
  const block = raw.replace(/```json\s*/gi, '').replace(/```/g, '')
  const start = block.indexOf('{')
  const end = block.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(block.slice(start, end + 1)) as {
      memories?: Array<{ category?: string; content?: string }>
    }
    if (!Array.isArray(parsed?.memories)) return null
    const valid = parsed.memories
      .filter((m) => {
        const cat = m?.category
        return (
          (cat === 'user_info' || cat === 'long_term' || cat === 'promises') &&
          typeof m?.content === 'string' &&
          m.content.trim()
        )
      })
      .map((m) => ({ category: m!.category! as MemoryCategory, content: m!.content!.trim() }))
    return valid.length > 0 ? valid : null
  } catch {
    return null
  }
}
