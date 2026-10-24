/**
 * 记忆检索器：决定「本次请求注入哪些记忆」。
 *
 * - 向量模式（memoryRetrievalEnabled + 嵌入模型已配置 + 嵌入可用）：三类记忆分层注入——
 *   约定类无条件注入（时效关键，显式 createdAt 降序取额）+ 画像压缩稿常驻
 *   + user_info / long_term **分池独立检索**（同一 queryVector，两次向量查询零嵌入开销）：
 *   混合打分 score = 0.8·cos + 0.2·recency（30 天半衰期）。
 *   分池理由：短事实文本与叙事 query 的 cos 分布不同源，混池排序会让叙事文本
 *   系统性挤占事实名额；user_info（事实底座）不做 MIN_COSINE 硬过滤（同约定类逻辑），
 *   long_term（叙事噪声多）保持阈值滤噪。
 * - 降级模式（开关关闭 / 未配置 / 嵌入失败）：与向量模式同构的「分层最近注入」——
 *   约定 10 + 事实 5 + 经历 8，各层按 createdAt 降序（不再依赖存储顺序写入习惯）。
 *
 * 注入的文本格式仍由 buildSystemPrompt 的三分段结构保证，本模块只负责"选哪些条"。
 */
import type { MemoryItem } from '../../../src/types'
import { getSettings, listConfirmedMemories, listMemories } from '../repository'
import { embedQuery } from './embeddingService'
import { searchVectors } from './vectorIndex'
import { resolveEmbeddingConfig } from './memoryVectors'
import { getActiveProfile } from './profile'

/** 向量模式下 user_info（事实底座）的注入上限 */
export const USER_INFO_TOP_K = 5
/** 向量模式下 long_term（经历素材）的注入上限（与旧 MAX_MEMORIES 同量级） */
export const LONG_TERM_TOP_K = 8
/** 相似度下限（仅 long_term）：低于该分的结果视为噪声（嵌入模型分布差异较大，M3 实测定标） */
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

/** 混合打分：语义相关为主、时间新近为辅 */
function hybridScore(cos: number, item: MemoryItem): number {
  return cos * (1 - RECENCY_WEIGHT) + recencyFactor(item.createdAt) * RECENCY_WEIGHT
}

/**
 * 降级模式的分层最近注入（与向量模式同构：约定保底 + 事实底座 + 经历补足）。
 * 各层显式 createdAt 降序——recency 是功能语义（过期约定最没用），不依赖存储写入顺序。
 */
async function listRecentLayered(cardId: string): Promise<MemoryItem[]> {
  const items = await listConfirmedMemories(cardId)
  const byCat = (c: MemoryItem['category']) => items.filter((m) => m.category === c).sort((a, b) => b.createdAt - a.createdAt)
  return [
    ...byCat('promises').slice(0, PROMISES_LIMIT),
    ...byCat('user_info').slice(0, USER_INFO_TOP_K),
    ...byCat('long_term').slice(0, LONG_TERM_TOP_K),
  ]
}

/**
 * 检索记忆（永不 throw：任何异常都降级为「分层最近注入」）。
 * @param cardId 角色卡 id（空串 = 仅全局背景）
 * @param query 当前用户消息文本（≤2000 字符，超出截断）
 */
export async function retrieveMemories(cardId: string, query: string): Promise<RetrievedMemories> {
  // 画像压缩稿：两种模式下只要存在即注入（分层压缩的常驻层）。
  // 提到 try 外：画像注入不依赖嵌入向量，检索链路失败（如嵌入服务未启动触发 fetch failed）
  // 也不应连带丢画像——此前 catch 路径硬编码 profileDigest: null 导致"画像生效却永不注入"。
  const profile = await getActiveProfile(cardId).catch(() => null)
  try {
    const settings = await getSettings()
    // 嵌入配置：来自激活的嵌入档案（档案制），未启用/配置不完整即降级
    const cfg = await resolveEmbeddingConfig()
    const configured = settings.memoryRetrievalEnabled && cfg !== null

    if (!configured) {
      const items = await listRecentLayered(cardId)
      return { items, profileDigest: profile?.personaDigest ?? null, mode: 'recent' }
    }
    // configured 已保证 cfg 非空；类型收窄 + 兜底防御
    if (!cfg) throw new Error('嵌入配置不完整')

    // 候选池：已确认 + 未停用（enabled=false 为用户暂停注入）+ 本角色/全局背景
    const all = await listMemories()
    const owned = all.filter(
      (m) => m.confirmed && m.enabled !== false && (m.characterCardId === cardId || m.characterCardId === null),
    )

    // 约定类：数量少且时效关键，无条件注入；显式 createdAt 降序取额——
    // 约定数 > 上限时优先保留最新约定（过期约定价值最低），不依赖存储顺序隐式保证
    const promises = owned
      .filter((m) => m.category === 'promises')
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, PROMISES_LIMIT)

    // 事实/经历分池独立检索：一次嵌入 + 两次向量查询（本地索引，零嵌入开销）。
    // user_info 不做 MIN_COSINE 过滤——事实底座性质（与约定类同逻辑）；
    // long_term 保持阈值滤噪（叙事噪声多，短 query 命中的低分经历多为噪声）。
    const factPool = owned.filter((m) => m.category === 'user_info')
    const storyPool = owned.filter((m) => m.category === 'long_term')
    let facts: MemoryItem[] = []
    let stories: MemoryItem[] = []
    if (query.trim() && (factPool.length > 0 || storyPool.length > 0)) {
      const queryVector = await embedQuery(query.slice(0, 2000), cfg)
      if (factPool.length > 0) {
        const byId = new Map(factPool.map((m) => [m.id, m]))
        const hits = await searchVectors(queryVector, factPool.map((m) => m.id), USER_INFO_TOP_K * 2, cfg.model)
        facts = hits
          .map((h) => {
            const item = byId.get(h.id)
            return item ? { item, score: hybridScore(h.score, item) } : null
          })
          .filter((x): x is { item: MemoryItem; score: number } => x !== null)
          .sort((a, b) => b.score - a.score)
          .slice(0, USER_INFO_TOP_K)
          .map((s) => s.item)
      }
      if (storyPool.length > 0) {
        const byId = new Map(storyPool.map((m) => [m.id, m]))
        const hits = await searchVectors(queryVector, storyPool.map((m) => m.id), LONG_TERM_TOP_K * 2, cfg.model)
        stories = hits
          .filter((h) => h.score >= MIN_COSINE)
          .map((h) => {
            const item = byId.get(h.id)
            return item ? { item, score: hybridScore(h.score, item) } : null
          })
          .filter((x): x is { item: MemoryItem; score: number } => x !== null)
          .sort((a, b) => b.score - a.score)
          .slice(0, LONG_TERM_TOP_K)
          .map((s) => s.item)
      }
    } else if (query.trim() === '') {
      // 无有效 query（如首次打开预览）：回退分层最近条
      facts = factPool.slice(0, USER_INFO_TOP_K)
      stories = storyPool.slice(0, LONG_TERM_TOP_K)
    }

    // 空结果兜底：三组一无所剩时回退旧"最近 N 条"，避免"明明有记忆却注入为空"
    if (promises.length === 0 && facts.length === 0 && stories.length === 0) {
      const items = await listRecentLayered(cardId)
      return { items, profileDigest: profile?.personaDigest ?? null, mode: 'recent' }
    }

    console.log('[memory-retrieval] 向量检索：约定=%d 事实=%d 经历=%d', promises.length, facts.length, stories.length)
    return {
      items: [...promises, ...facts, ...stories],
      profileDigest: profile?.personaDigest ?? null,
      mode: 'vector',
    }
  } catch (err) {
    // 检索链路任何异常都不阻塞聊天；降级注入仍带画像（画像不依赖嵌入向量）
    console.warn('[memory-retrieval] 检索失败，回退分层最近注入：', err instanceof Error ? err.message : err)
    const items = await listRecentLayered(cardId).catch(() => [] as MemoryItem[])
    return { items, profileDigest: profile?.personaDigest ?? null, mode: 'recent' }
  }
}
