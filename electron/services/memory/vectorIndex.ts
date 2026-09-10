/**
 * 记忆向量索引：data/memory-vectors.json，记忆 id → 嵌入向量（含模型标识）。
 *
 * - 桌面级数据量（数千条）下暴力余弦扫描即可（数千维 × 数千条毫秒级），不引入向量数据库；
 * - 向量在写入时已 L2 归一化，余弦相似度 = 点积；
 * - 每条向量记录嵌入时的模型名，换模型后旧向量自动视为过期（由补偿/重嵌流程刷新）；
 * - 读写复用 storage.mutateJson 的每文件串行队列与原子写。
 */
import { paths, readJson, mutateJson } from '../storage'

/** 单条向量记录（vector 已归一化） */
interface VectorEntry {
  model: string
  vector: number[]
}

/** 索引文件结构 */
interface VectorFile {
  vectors: Record<string, VectorEntry>
}

const EMPTY_INDEX: VectorFile = { vectors: {} }

/** 读取整份索引（内存中转成 Record 便于扫描；桌面量级下解析耗时可忽略） */
async function loadIndex(): Promise<VectorFile> {
  return readJson<VectorFile>(paths.memoryVectorsFile, EMPTY_INDEX)
}

/** 写入/更新一批向量（按当前嵌入模型标记） */
export async function upsertVectors(entries: Array<{ id: string; vector: Float32Array }>, model: string): Promise<void> {
  if (entries.length === 0) return
  await mutateJson<VectorFile>(paths.memoryVectorsFile, EMPTY_INDEX, (cur) => {
    const vectors = { ...cur.vectors }
    for (const { id, vector } of entries) {
      vectors[id] = { model, vector: Array.from(vector) }
    }
    return { vectors }
  })
}

/** 删除一批向量（记忆被删除时同步清理） */
export async function removeVectors(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await mutateJson<VectorFile>(paths.memoryVectorsFile, EMPTY_INDEX, (cur) => {
    const vectors = { ...cur.vectors }
    let changed = false
    for (const id of ids) {
      if (vectors[id] !== undefined) {
        delete vectors[id]
        changed = true
      }
    }
    return changed ? { vectors } : cur
  })
}

/** 读取指定记忆的向量（不存在/过期时返回 null）；currentModel 用于过期判断 */
export async function getVector(id: string, currentModel?: string): Promise<Float32Array | null> {
  const index = await loadIndex()
  const entry = index.vectors[id]
  if (!entry) return null
  if (currentModel && entry.model !== currentModel) return null
  return new Float32Array(entry.vector)
}

/** 列出全部向量记录（补偿/状态统计用） */
export async function listVectors(): Promise<Record<string, VectorEntry>> {
  const index = await loadIndex()
  return index.vectors
}

/**
 * 在给定候选 id 范围内做暴力余弦检索（向量已归一化，点积即余弦）。
 * @param query 已归一化的查询向量
 * @param ids 候选记忆 id（调用方先按角色/分类过滤好）
 * @param topK 返回条数上限
 * @param currentModel 只匹配该模型的向量（模型不一致视为缺失）
 * @returns 按 score 降序的 {id, score} 列表
 */
export async function searchVectors(
  query: Float32Array,
  ids: string[],
  topK: number,
  currentModel?: string,
): Promise<Array<{ id: string; score: number }>> {
  const index = await loadIndex()
  const hits: Array<{ id: string; score: number }> = []
  for (const id of ids) {
    const entry = index.vectors[id]
    if (!entry) continue
    if (currentModel && entry.model !== currentModel) continue
    if (entry.vector.length !== query.length) continue // 维度不一致（换模型）直接跳过
    let dot = 0
    for (let i = 0; i < query.length; i++) dot += query[i]! * entry.vector[i]!
    hits.push({ id, score: dot })
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, Math.max(0, topK))
}
