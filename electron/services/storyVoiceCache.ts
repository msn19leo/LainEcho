/**
 * 剧情语音缓存：合成结果落盘 + 索引 + LRU 淘汰。
 *
 * 为什么落盘（而不是只放渲染端内存）：
 * 1. MiMo 是云端按量计费接口，同一句台词反复合成是纯浪费；
 * 2. 重看 / 重开剧情窗要复用同一份音频，否则重看一章得重新合成十几分钟；
 * 3. 剧情窗的 backlog 需要回头重听某一句。
 *
 * key = sha1(engine | ttsModelId | language | text)：同一句台词跨章节、跨 run 复用同一份文件；
 * 换声库 / 换语言会自然分开（因为参与 hash）。
 *
 * 布局：data/voice-cache/index.json + data/voice-cache/<前两位>/<hash>.wav
 *      分片目录避免单目录堆几万个文件。
 */
import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'
import { paths } from './storage'
import { getGenieConfig, synthesizeGenie } from './genieTts'
import { synthesizeSbv2FromCard } from './sbv2Tts'
import { getTTSModel } from './repository'

/** 缓存总量上限：超出后按 lastUsedAt 淘汰最旧的 */
const MAX_BYTES = 500 * 1024 * 1024
/** 默认清理阈值（天） */
export const DEFAULT_MAX_AGE_DAYS = 30

export interface VoiceCacheEntry {
  /** 相对 voice-cache 的文件路径 */
  file: string
  bytes: number
  createdAt: number
  lastUsedAt: number
}

interface VoiceCacheIndex {
  version: 1
  entries: Record<string, VoiceCacheEntry>
}

export interface SynthesizeParams {
  ttsModelId: string
  language: 'zh' | 'ja'
  text: string
  engine?: 'genie' | 'sbv2'
}

export interface VoiceCacheStats {
  count: number
  bytes: number
  maxBytes: number
  dir: string
}

let indexCache: VoiceCacheIndex | null = null
/** 索引写入串行化：并发合成会同时改 index，必须排队落盘 */
let indexWriteChain: Promise<void> = Promise.resolve()
/** 同 key 的并发合成去重（预读与正式播放可能同时请求同一句） */
const inflight = new Map<string, Promise<Buffer | null>>()

function cacheKey(p: SynthesizeParams): string {
  const engine = p.engine ?? 'genie'
  return createHash('sha1').update(`${engine}|${p.ttsModelId}|${p.language}|${p.text}`).digest('hex')
}

async function loadIndex(): Promise<VoiceCacheIndex> {
  if (indexCache) return indexCache
  try {
    const raw = await fs.readFile(path.join(paths.storyVoiceCacheDir, 'index.json'), 'utf8')
    const parsed = JSON.parse(raw) as VoiceCacheIndex
    if (parsed && parsed.version === 1 && parsed.entries) {
      indexCache = parsed
      return parsed
    }
  } catch {
    // 首次运行 / 索引损坏：重建为空（文件残留会在清理时按索引之外处理）
  }
  indexCache = { version: 1, entries: {} }
  return indexCache
}

/** 落盘索引（串行）；失败只告警，不影响本次合成结果返回 */
function persistIndex(): void {
  const snapshot = indexCache
  if (!snapshot) return
  indexWriteChain = indexWriteChain
    .then(async () => {
      await fs.mkdir(paths.storyVoiceCacheDir, { recursive: true })
      const target = path.join(paths.storyVoiceCacheDir, 'index.json')
      const tmp = `${target}.tmp`
      await fs.writeFile(tmp, JSON.stringify(snapshot), 'utf8')
      await fs.rename(tmp, target)
    })
    .catch((err) => {
      console.warn('[story-voice-cache] 索引写入失败：', err instanceof Error ? err.message : err)
    })
}

/** 清掉不再有文件的分片目录（兼容早期按 hash 前两位分片的布局） */
async function pruneEmptyDirs(): Promise<void> {
  const root = paths.storyVoiceCacheDir
  const items = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  for (const item of items) {
    if (!item.isDirectory()) continue
    const dir = path.join(root, item.name)
    const left = await fs.readdir(dir).catch(() => [])
    if (left.length === 0) await fs.rmdir(dir).catch(() => {})
  }
}

/** 淘汰：按 lastUsedAt 从旧到新删，直到总量回到上限的 90% 以下 */
async function evictIfNeeded(): Promise<void> {
  const idx = await loadIndex()
  const entries = Object.entries(idx.entries)
  let total = entries.reduce((sum, [, e]) => sum + e.bytes, 0)
  if (total <= MAX_BYTES) return

  const target = Math.floor(MAX_BYTES * 0.9)
  entries.sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)
  for (const [key, entry] of entries) {
    if (total <= target) break
    await fs.unlink(path.join(paths.storyVoiceCacheDir, entry.file)).catch(() => {})
    delete idx.entries[key]
    total -= entry.bytes
  }
  persistIndex()
}

async function readCached(key: string): Promise<Buffer | null> {
  const idx = await loadIndex()
  const entry = idx.entries[key]
  if (!entry) return null
  try {
    const buf = await fs.readFile(path.join(paths.storyVoiceCacheDir, entry.file))
    entry.lastUsedAt = Date.now()
    persistIndex()
    return buf
  } catch {
    // 文件被手动删掉 / 目录迁移：索引失配，清掉这条记录当作未命中
    delete idx.entries[key]
    persistIndex()
    return null
  }
}

async function writeCached(key: string, wav: Buffer): Promise<void> {
  const idx = await loadIndex()
  // 不分片：实际规模是几百到几千条，早先按 hash 前两位分 256 个桶，
  // 结果每条语音各占一个文件夹、清空后还留一地空目录。直接平铺更好用。
  const rel = `${key}.wav`
  const abs = path.join(paths.storyVoiceCacheDir, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, wav)
  const now = Date.now()
  idx.entries[key] = { file: rel, bytes: wav.length, createdAt: now, lastUsedAt: now }
  persistIndex()
  void evictIfNeeded()
}

/** 真正调用合成引擎（不含缓存） */
async function synthesizeRaw(params: SynthesizeParams): Promise<Buffer> {
  const model = await getTTSModel(params.ttsModelId)
  if (!model) throw new Error('声库模型卡不存在')

  const engine = params.engine ?? (model.engine === 'sbv2' ? 'sbv2' : 'genie')
  if (engine === 'sbv2') {
    return Buffer.from(await synthesizeSbv2FromCard({ ttsModelId: params.ttsModelId, text: params.text }))
  }
  const config = await getGenieConfig()
  const wav = await synthesizeGenie({
    config,
    characterName: model.characterName,
    onnxModelDir: model.onnxModelDir,
    refAudioPath: model.refAudioPath || undefined,
    refAudioText: model.refAudioText || undefined,
    text: params.text,
    lang: params.language === 'ja' ? 'ja' : 'zh',
  })
  return Buffer.from(wav)
}

/**
 * 合成（命中缓存直接返回）。并发请求同一句会共享同一次合成。
 * @param allowSynthesize false = 只查缓存，不产生新音（重看时"允许补充合成"关闭时用）
 */
export async function synthesizeStoryVoice(
  params: SynthesizeParams,
  allowSynthesize = true,
): Promise<{ ok: true; wav: Buffer } | { ok: false; error: string; missing?: boolean }> {
  const text = params.text?.trim() ?? ''
  if (!text) return { ok: false, error: '合成文本为空' }
  const normalized: SynthesizeParams = { ...params, text }

  const key = cacheKey(normalized)
  const cached = await readCached(key)
  if (cached) return { ok: true, wav: cached }
  if (!allowSynthesize) return { ok: false, error: '语音未缓存', missing: true }

  const existing = inflight.get(key)
  if (existing) {
    const wav = await existing
    return wav ? { ok: true, wav } : { ok: false, error: '合成失败' }
  }

  const task = (async () => {
    try {
      const wav = await synthesizeRaw(normalized)
      await writeCached(key, wav)
      return wav
    } catch (err) {
      console.warn('[story-voice] 合成失败：', err instanceof Error ? err.message : err)
      return null
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, task)

  const wav = await task
  return wav ? { ok: true, wav } : { ok: false, error: '合成失败' }
}

/** 仅查缓存，不合成（预读命中判断 / 重看时静默跳过用） */
export async function peekStoryVoice(params: SynthesizeParams): Promise<Buffer | null> {
  return readCached(cacheKey({ ...params, text: params.text?.trim() ?? '' }))
}

export async function getVoiceCacheStats(): Promise<VoiceCacheStats> {
  const idx = await loadIndex()
  const entries = Object.values(idx.entries)
  return {
    count: entries.length,
    bytes: entries.reduce((sum, e) => sum + e.bytes, 0),
    maxBytes: MAX_BYTES,
    dir: paths.storyVoiceCacheDir,
  }
}

/** @param olderThanDays 传 0 或配合 all=true 表示全部清空 */
export async function cleanVoiceCache(opts: { olderThanDays?: number; all?: boolean } = {}): Promise<number> {
  const idx = await loadIndex()
  const now = Date.now()
  const cutoff = opts.all ? Number.POSITIVE_INFINITY : now - (opts.olderThanDays ?? DEFAULT_MAX_AGE_DAYS) * 86400_000
  let removed = 0
  for (const [key, entry] of Object.entries(idx.entries)) {
    if (opts.all || entry.lastUsedAt < cutoff) {
      await fs.unlink(path.join(paths.storyVoiceCacheDir, entry.file)).catch(() => {})
      delete idx.entries[key]
      removed++
    }
  }
  persistIndex()
  await pruneEmptyDirs()
  return removed
}
