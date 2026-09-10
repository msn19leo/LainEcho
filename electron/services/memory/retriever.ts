/**
 * 记忆检索器：决定「本次请求注入哪些记忆」。
 *
 * - 向量模式（memoryRetrievalEnabled + 嵌入模型已配置 + 嵌入可用）：
 *   约定类全量注入（时效关键）+ 画像压缩稿常驻 + user_info/long_term 按语义相似度 top-k；
 *   混合打分 score = 0.8·cos + 0.2·recency（30 天半衰期），过滤低分段噪声；
 * - 降级模式（开关关闭 / 未配置 / 嵌入失败）：回退旧行为「最近 N 条」，行为与历史版本一致。
 *
 * 注入的文本格式仍由 buildSystemPrompt 的三分段结构保证，本模块只负责"选哪些条"。
 */
import type { MemoryItem } from '../../../src/types'
import { getSettings, listConfirmedMemories, listMemories } from '../repository'
import { embedQuery } from './embeddingService'
import { searchVectors } from './vectorIndex'
import { resolveEmbeddingConfig } from './memoryVectors'
import { getActiveProfile, getRecentChronicleItems } from './profile'

/** 向量模式下 user_info/long_term 的注入上限（与旧 MAX_MEMORIES 同量级，防 prompt 膨胀） */
export const RETRIEVAL_TOP_K = 8
/** 相似度下限：低于该分的结果视为噪声（嵌入模型分布差异较大，M3 实测定标） */
const MIN_COSINE = 0.35
/** recency 混合权重与半衰期（天）：score = 0.8·cos + 0.2·0.5^(ageDays/30) */
const RECENCY_WEIGHT = 0.2
const RECENCY_HALF_LIFE_DAYS = 30
/** 约定类无条件注入的条数上限 */
const PROMISES_LIMIT = 10

/** 检索结果：参与注入的记忆 + 画像压缩稿 + 实际使用的模式 */
export interface RetrievedMemories {
  items: MemoryItem[]
  profileDigest: string | null
  mode: 'vector' | 'recent'
}

/** recency 因子：30 天半衰期指数衰减 */
function recencyFactor(createdAt: number): number {
  const ageDays = Math.max(0, (Date.now() - createdAt) / 86_400_000)
  return Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS)
}

/**
 * 检索记忆（永不 throw：任何异常都降级为「最近 N 条」）。
 * @param cardId 角色卡 id（空串 = 仅全局背景）
 * @param query 当前用户消息文本（≤2000 字符，超出截断）
 * @param fallbackLimit 降级模式的注入条数（沿用 MAX_MEMORIES）
 */
export async function retrieveMemories(cardId: string, query: string, fallbackLimit: number): Promise<RetrievedMemories> {
  try {
    const settings = await getSettings()
    // 嵌入配置：独立于主 LLM（embeddingBaseURL + 独立 Key + embeddingModel），任一缺失即降级
    const cfg = await resolveEmbeddingConfig()
    const configured = settings.memoryRetrievalEnabled && cfg !== null

    // 画像压缩稿：两种模式下只要存在即注入（分层压缩的常驻层）
    const profile = await getActiveProfile(cardId)

    if (!configured) {
      const items = await listConfirmedMemories(cardId, fallbackLimit)
      return { items: await withChronicleFallback(items, cardId), profileDigest: profile?.personaDigest ?? null, mode: 'recent' }
    }
    // configured 已保证 cfg 非空；类型收窄 + 兜底防御
    if (!cfg) throw new Error('嵌入配置不完整')

    // 候选池：已确认 + 本角色/全局背景
    const all = await listMemories()
    const owned = all.filter((m) => m.confirmed && (m.characterCardId === cardId || m.characterCardId === null))

    // 约定类：数量少且时效关键，无条件全量注入
    const promises = owned.filter((m) => m.category === 'promises').slice(0, PROMISES_LIMIT)

    // user_info / long_term：语义检索 top-k（向量缺失/检索失败时该类回退最近条）
    const pool = owned.filter((m) => m.category === 'user_info' || m.category === 'long_term')
    let selected: MemoryItem[] = []
    if (pool.length > 0 && query.trim()) {
      const queryVector = await embedQuery(query.slice(0, 2000), cfg)
      const hits = await searchVectors(queryVector, pool.map((m) => m.id), RETRIEVAL_TOP_K * 2, cfg.model)
      const byId = new Map(pool.map((m) => [m.id, m]))
      const scored = hits
        .filter((h) => h.score >= MIN_COSINE)
        .map((h) => {
          const item = byId.get(h.id)
          if (!item) return null
          return { item, score: h.score * (1 - RECENCY_WEIGHT) + recencyFactor(item.createdAt) * RECENCY_WEIGHT }
        })
        .filter((x): x is { item: MemoryItem; score: number } => x !== null)
      scored.sort((a, b) => b.score - a.score)
      selected = scored.slice(0, RETRIEVAL_TOP_K).map((s) => s.item)
    } else if (pool.length > 0) {
      // 无有效 query（如首次打开预览）：回退最近条
      selected = pool.slice(0, RETRIEVAL_TOP_K)
    }

    // 空结果兜底：语义过滤后一无所剩时回退最近条，避免"明明有记忆却注入为空"
    if (selected.length === 0 && promises.length === 0) {
      const items = await listConfirmedMemories(cardId, fallbackLimit)
      return { items: await withChronicleFallback(items, cardId), profileDigest: profile?.personaDigest ?? null, mode: 'recent' }
    }

    // 编年史条目（分层压缩产物）在两种模式下都补入最近几条，让被摘要的历史可见
    return {
      items: await withChronicleFallback([...promises, ...selected], cardId),
      profileDigest: profile?.personaDigest ?? null,
      mode: 'vector',
    }
  } catch (err) {
    // 检索链路任何异常都不阻塞聊天
    console.warn('[memory-retrieval] 检索失败，回退最近条注入：', err instanceof Error ? err.message : err)
    const items = await listConfirmedMemories(cardId, fallbackLimit).catch(() => [] as MemoryItem[])
    return { items, profileDigest: null, mode: 'recent' }
  }
}

/**
 * 兜底注入时补上最近的编年史条目（分层压缩产物）：让降级模式也能看到被摘要的历史。
 * @param count 补入的编年史条数（最新优先）
 */
async function withChronicleFallback(items: MemoryItem[], cardId: string, count = 3): Promise<MemoryItem[]> {
  try {
    const chronicle = await getRecentChronicleItems(cardId, count)
    if (chronicle.length === 0) return items
    const existing = new Set(items.map((m) => m.id))
    return [...chronicle.filter((c) => !existing.has(c.id)), ...items]
  } catch {
    return items
  }
}
