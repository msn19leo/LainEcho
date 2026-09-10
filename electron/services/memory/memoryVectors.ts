/**
 * 记忆向量编排：把「记忆条目」与「向量索引」粘合起来的写入管线钩子。
 *
 * - syncMemoryVectors：批量嵌入记忆并写入索引（新增/确认/编辑后调用）；
 * - removeMemoryVectors：记忆删除后同步清理向量；
 * - compensateMissingVectors：启动补偿/手动重嵌——为缺失或模型过期的记忆补嵌；
 * - 全部失败静默（记忆本体已落盘，向量缺失只影响检索质量，不影响功能可用）。
 */
import type { MemoryItem } from '../../../src/types'
import { readSecret } from '../crypto'
import { getSettings, listMemories } from '../repository'
import { paths } from '../storage'
import { embedTexts, embedQuery, isEmbeddingConfigUsable, type EmbeddingConfig } from './embeddingService'
import { listVectors, removeVectors, searchVectors, upsertVectors } from './vectorIndex'

/** 补嵌/重嵌的并发批大小（一次 /embeddings 请求携带的文本数） */
const COMPENSATE_BATCH = 8

/**
 * 从当前设置组装嵌入配置（独立于主 LLM：embeddingBaseURL + 独立 Key + embeddingModel）。
 * 未配置完整（地址/模型/Key 任一缺失）返回 null；不校验检索开关，手动重嵌也走这里。
 */
export async function resolveEmbeddingConfig(): Promise<EmbeddingConfig | null> {
  const settings = await getSettings()
  const apiKey = await readSecret(paths.embeddingApiKeyFile).catch(() => null)
  const cfg = { baseURL: settings.embeddingBaseURL, apiKey: apiKey ?? '', model: settings.embeddingModel }
  return isEmbeddingConfigUsable(cfg) ? cfg : null
}

/** 检索开关是否打开且嵌入配置可用（自动写入/检索侧的统一门槛，避免关闭时白白消耗 API） */
async function isRetrievalActive(): Promise<boolean> {
  const settings = await getSettings()
  if (!settings.memoryRetrievalEnabled) return false
  return (await resolveEmbeddingConfig()) !== null
}

/**
 * 测试嵌入配置：发送一条样例文本验证 地址/模型/Key 连通性（设置面板「测试」按钮用）。
 * @returns 成功返回向量维度；失败返回可读错误
 */
export async function testEmbedding(): Promise<{ ok: boolean; dim?: number; error?: string }> {
  const cfg = await resolveEmbeddingConfig()
  if (!cfg) return { ok: false, error: '嵌入配置不完整：请填写 API 地址、模型名并保存 API Key' }
  try {
    const [vec] = await embedTexts(['连接测试'], cfg)
    return { ok: true, dim: vec?.length ?? 0 }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 批量嵌入记忆条目并写入索引（fire-and-forget 调用方自行 catch）。
 * @returns 成功嵌入的条数
 */
export async function syncMemoryVectors(items: MemoryItem[]): Promise<number> {
  if (items.length === 0) return 0
  if (!(await isRetrievalActive())) return 0
  const cfg = await resolveEmbeddingConfig()
  if (!cfg) return 0
  try {
    const vectors = await embedTexts(
      items.map((m) => m.content),
      cfg,
    )
    const entries = items
      .map((item, i) => ({ id: item.id, vector: vectors[i]! }))
      .filter((e) => e.vector !== undefined)
    await upsertVectors(entries, cfg.model)
    return entries.length
  } catch (err) {
    console.warn('[memory-vector] 嵌入失败（记忆本体不受影响）：', err instanceof Error ? err.message : err)
    return 0
  }
}

/** 记忆删除后清理对应向量（失败静默） */
export async function removeMemoryVectors(ids: string[]): Promise<void> {
  try {
    await removeVectors(ids)
  } catch (err) {
    console.warn('[memory-vector] 清理向量失败：', err)
  }
}

/**
 * 为「缺失向量」或「向量模型过期」的已确认记忆补嵌。
 * 应用启动时后台调用一次；也可由设置面板「重新嵌入全部」手动触发。
 * @returns null = 嵌入未配置或不可用；否则返回 {embedded, failed}
 */
export async function compensateMissingVectors(): Promise<{ embedded: number; failed: number } | null> {
  const cfg = await resolveEmbeddingConfig()
  if (!cfg) return null

  try {
    const all = await listMemories()
    // 仅补已确认记忆（待确认候选在确认时嵌入；pending 无向量不影响注入）
    const targets = all.filter((m) => m.confirmed)
    const vectors = await listVectors()
    const stale = targets.filter((m) => {
      const entry = vectors[m.id]
      return !entry || entry.model !== cfg.model
    })
    if (stale.length === 0) return { embedded: 0, failed: 0 }

    let embedded = 0
    let failed = 0
    // 分批串行：控制 API 压力，避免一次补嵌几百条触发限流
    for (let i = 0; i < stale.length; i += COMPENSATE_BATCH) {
      const batch = stale.slice(i, i + COMPENSATE_BATCH)
      try {
        const vecs = await embedTexts(
          batch.map((m) => m.content),
          cfg,
        )
        const entries = batch
          .map((item, j) => ({ id: item.id, vector: vecs[j]! }))
          .filter((e) => e.vector !== undefined)
        await upsertVectors(entries, cfg.model)
        embedded += entries.length
        failed += batch.length - entries.length
      } catch (err) {
        failed += batch.length
        console.warn('[memory-vector] 补嵌批次失败：', err instanceof Error ? err.message : err)
      }
    }
    if (embedded > 0 || failed > 0) {
      console.log('[memory-vector] 补偿完成 embedded=%d failed=%d（共 %d 条待补）', embedded, failed, stale.length)
    }
    return { embedded, failed }
  } catch (err) {
    console.warn('[memory-vector] 补偿流程异常：', err)
    return null
  }
}

/**
 * 语义检索指定记忆 id 集合（供检索器/语义搜索复用）。
 * @returns 按 score 降序的命中列表；嵌入不可用时返回空数组（调用方自行降级）
 */
export async function semanticSearchAmong(
  queryText: string,
  candidates: MemoryItem[],
  topK: number,
): Promise<Array<{ item: MemoryItem; score: number }>> {
  if (!(await isRetrievalActive())) return []
  const cfg = await resolveEmbeddingConfig()
  if (!cfg || candidates.length === 0) return []
  const query = await embedQuery(queryText, cfg)
  const hits = await searchVectors(query, candidates.map((m) => m.id), topK, cfg.model)
  const byId = new Map(candidates.map((m) => [m.id, m]))
  return hits
    .map((h) => {
      const item = byId.get(h.id)
      return item ? { item, score: h.score } : null
    })
    .filter((x): x is { item: MemoryItem; score: number } => x !== null)
}
