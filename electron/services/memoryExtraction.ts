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
import { addPendingMemory, getCharacterCard, getSettings, listMemories, updateMemory } from './repository'
import { removeMemoryVectors } from './memory/memoryVectors'
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

/**
 * 抽取 prompt：独立上下文，绝不混入 EMOTION_PROMPT 的 JSON dialogue 约束。
 *
 * 表述视角（方案 A，第三人称档案体）：角色一律用其角色名，用户一律称「用户」。
 * 记录是「档案」而非角色日记，第三人称对人（记忆列表阅读）与模型（注入后归一化
 * 转回你/对方视角）都无歧义，避免出现 你/对方/角色 多种称呼混排。
 */
function buildExtractSystemPrompt(cardName: string): string {
  return (
    '你是一个严格的对话记忆提取助手。从「用户」与「' +
    cardName +
    '」的对话中，' +
    '只提取「真正长期重要」的新信息，忽略寒暄、日常随口一说、能从上下文自然获得的临时信息、以及明显重复的内容。' +
    '只输出 JSON 本体（不要 markdown 代码块、不要任何解释）：{"memories":[{"category":"user_info","content":"..."}]}\n' +
    '- category 只能是：\n' +
    '  user_info = 用户个人信息（姓名/年龄/职业/喜好/雷点/习惯/身份等）\n' +
    '  long_term = 长期经历（重要事件、剧情进展、值得记住的时刻）\n' +
    '  promises = 约定与承诺（明确达成的约定、时间地点、答应做的事）\n' +
    '- 重要性门槛（满足任一才提取）：明确给出的个人信息；具体且有长期价值的约定；会影响后续互动的重要事件。\n' +
    '  不提取：客套话、单纯的情绪宣泄、正在被当前对话解决的一次性事项、过于琐碎的日常。\n' +
    '- 表述视角必须统一为第三人称档案体：用户一律称「用户」；角色一律用「' +
    cardName +
    '」这个角色名指代；严禁使用「我/你/对方/角色/AI」等任何人称代词或标签词作主语。\n' +
    '  例：写「用户喜欢喝椰奶」而非「对方喜欢喝椰奶」；写「' +
    cardName +
    '答应陪用户去看流星雨」而非「你答应…」或「角色答应…」。\n' +
    '  每条尽量只包含一个主语视角、一句话讲清，不超过 40 字。\n' +
    '- 最多返回 6 条；优先保留最具体、最重要者。仅当确实无任何价值时返回 {"memories":[]}。'
  )
}

/** 抽取结果中的单条记忆 */
interface ExtractedMemory {
  category: MemoryCategory
  content: string
}

/** 判断新记忆是否与现有记忆重复（完全相同或互相包含即视为重复）。剧情沉淀管线（storyMemory）复用 */
export function isDuplicate(content: string, existing: string[]): boolean {
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
 * @returns 通过语义去重的候选子集。剧情沉淀管线（storyMemory）复用
 */
export async function semanticDedup(
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
 * 人称视角归一化（第三人称档案体）：统一为「用户=用户方、{角色名}=角色」，
 * 清除模型可能混入的「我/你/对方/角色/AI」。角色名缺失时退化为「角色」标签。
 * 避免沉淀出的记忆一会"你"一会"对方"一会"角色"，读感混乱。剧情沉淀管线（storyMemory）复用
 */
export function normalizePerspective(content: string, cardName: string): string {
  let c = content.replace(/\s+/g, ' ').trim()
  // 用户方称呼归一：对方 → 用户
  c = c.split('对方').join('用户')
  // 角色方称呼归一：角色/AI/你/我 → 角色名（无角色名时保留「角色」标签）
  const name = cardName.trim() || '角色'
  c = name === '角色' ? c : c.split('角色').join(name).split('AI').join(name)
  c = c.split('你').join(name).split('我').join(name)
  // 压缩多余空格与连续标点
  c = c.replace(/\s+([，。！？；：、])/g, '$1').replace(/,+/g, '，')
  return c.trim()
}

/**
 * 存量记忆一次性迁移到第三人称档案体（幂等，启动时执行一次）：
 * 旧约定是「你=角色、对方=用户」，且存在「角色」标签漏网，同一列表三种称呼混排。
 * 迁移把所有带归属角色的记忆统一为「{角色名}/用户」；全局记忆（无归属）角色侧退化为「角色」。
 * 归一化对已迁移文本是空操作（不再含人称代词），重复执行无副作用。
 */
export async function migrateMemoryPerspectives(): Promise<void> {
  try {
    const all = await listMemories()
    const nameCache = new Map<string, string>()
    let migrated = 0
    const rewrittenIds: string[] = []
    for (const m of all) {
      // 角色名本身含人称字的卡片跳过，避免替换后文本不稳定（非幂等）
      let name: string
      if (m.characterCardId) {
        const cached = nameCache.get(m.characterCardId)
        if (cached !== undefined) {
          name = cached
        } else {
          const card = await getCharacterCard(m.characterCardId)
          name = card?.name?.trim() || '角色'
          if (/你|我|角色|AI/.test(name)) {
            nameCache.set(m.characterCardId, '\u0000skip')
            continue
          }
          nameCache.set(m.characterCardId, name)
        }
        if (name === '\u0000skip') continue
      } else {
        name = '角色'
      }
      const next = normalizePerspective(m.content, name)
      if (next !== m.content.trim() && next.length >= MIN_CONTENT_LEN) {
        await updateMemory(m.id, { content: next })
        rewrittenIds.push(m.id)
        migrated++
      }
    }
    if (migrated > 0) {
      // 改写文本后旧向量失效：删除待补偿重嵌（嵌入未配置时删除后不再补，检索自动降级字符串匹配）
      await removeMemoryVectors(rewrittenIds).catch(() => {})
      console.log('[memory] 记忆人称迁移（第三人称档案体）：更新 %d 条', migrated)
      windowManager.broadcast('memory:changed')
    }
  } catch (err) {
    console.warn('[memory] 记忆人称迁移失败（跳过，不影响使用）：', err instanceof Error ? err.message : err)
  }
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

  // 角色卡名：第三人称档案体的角色侧称呼（卡片已删除则退化为「角色」标签）
  const card = await getCharacterCard(cardId)
  const cardName = card?.name?.trim() || '角色'

  // 同会话冷却：5 分钟内不重复抽取
  const now = Date.now()
  const last = lastExtractAt.get(sessionId) ?? 0
  if (now - last < EXTRACT_COOLDOWN_MS) return
  lastExtractAt.set(sessionId, now)

  // 取最近一段对话的纯净文本（跳过 UI 元数据）；用「用户/{角色名}」标注，与 prompt 第三人称视角一致
  const recent = messages.slice(-EXTRACT_RECENT_MESSAGES)
  const dialogueText = recent
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `${m.role === 'user' ? '用户' : cardName}: ${m.content}`)
    .join('\n')
    .trim()
  if (!dialogueText) return

  try {
    const raw = await sendChatCompletion(
      [
        { role: 'system', content: buildExtractSystemPrompt(cardName) },
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
      const content = normalizePerspective(m.content, cardName)
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
