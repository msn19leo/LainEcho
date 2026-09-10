/**
 * 嵌入服务：调用 OpenAI 兼容 /embeddings 端点把文本转为向量。
 *
 * - 使用独立配置（embeddingBaseURL + 独立 Key + embeddingModel），与主 LLM 服务完全解耦；
 * - 不下载任何本地模型，零磁盘占用；
 * - 批量输入分批（MAX_BATCH）+ 429/5xx 有限重试退避；
 * - 输出向量做 L2 归一化，检索时余弦相似度退化为点积。
 */
import { normalizeBaseURL } from '../aiClient'

/** 单次 /embeddings 请求的最大输入条数（超出自动分批） */
const MAX_BATCH = 16
/** 429/5xx 重试次数 */
const MAX_RETRIES = 2
/** 重试基础退避（毫秒），按次数指数增长 */
const RETRY_BACKOFF_MS = 1200

/** 嵌入请求所需配置（由调用方从 settings + readApiKey 组装） */
export interface EmbeddingConfig {
  baseURL: string
  apiKey: string
  model: string
}

/** 判断嵌入配置是否可用（设置开关之外的基础条件） */
export function isEmbeddingConfigUsable(cfg: Partial<EmbeddingConfig> | null | undefined): cfg is EmbeddingConfig {
  return !!(cfg && cfg.baseURL?.trim() && cfg.apiKey && cfg.model?.trim())
}

/** 延时工具（重试退避用） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** L2 归一化：除以模长，零向量原样返回 */
function normalize(vec: number[]): number[] {
  let sum = 0
  for (const v of vec) sum += v * v
  const norm = Math.sqrt(sum)
  if (norm === 0) return vec
  return vec.map((v) => v / norm)
}

/**
 * 批量嵌入文本。
 * @returns 与输入顺序一一对应的归一化向量数组
 * @throws 未配置 / HTTP 错误 / 响应格式异常时抛出用户可读错误
 */
export async function embedTexts(texts: string[], cfg: EmbeddingConfig, signal?: AbortSignal): Promise<Float32Array[]> {
  const model = cfg.model.trim()
  if (!model) throw new Error('未配置嵌入模型（设置 → 记忆体 → 嵌入模型）')
  if (!cfg.baseURL.trim()) throw new Error('未配置 API 地址（baseURL）')
  if (!cfg.apiKey) throw new Error('未配置 API Key')

  const url = `${normalizeBaseURL(cfg.baseURL)}/embeddings`
  const results: Float32Array[] = new Array(texts.length)

  // 分批请求（OpenAI 兼容接口支持数组输入，data[i].index 对应输入下标）
  for (let start = 0; start < texts.length; start += MAX_BATCH) {
    const batch = texts.slice(start, start + MAX_BATCH)
    const embeddings = await requestWithRetry(url, model, batch, cfg.apiKey, signal)
    for (let i = 0; i < embeddings.length; i++) {
      const item = embeddings[i]
      if (!item || typeof item.index !== 'number' || !Array.isArray(item.embedding)) {
        throw new Error('嵌入接口响应格式异常（缺少 index/embedding）')
      }
      results[start + item.index] = new Float32Array(normalize(item.embedding))
    }
  }
  return results
}

/** 单条文本嵌入（检索 query 用） */
export async function embedQuery(text: string, cfg: EmbeddingConfig, signal?: AbortSignal): Promise<Float32Array> {
  const [vec] = await embedTexts([text], cfg, signal)
  if (!vec) throw new Error('嵌入接口返回为空')
  return vec
}

/** 带重试的 /embeddings 请求：429/5xx 指数退避重试，其余错误直接抛出 */
async function requestWithRetry(
  url: string,
  model: string,
  input: string[],
  apiKey: string,
  signal?: AbortSignal,
): Promise<Array<{ index: number; embedding: number[] }>> {
  let lastErr: unknown = null
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(RETRY_BACKOFF_MS * attempt)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, input }),
        signal,
      })
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`嵌入接口暂不可用（HTTP ${res.status}）`)
        continue
      }
      if (!res.ok) {
        let detail = ''
        try {
          const body = (await res.json()) as { error?: { message?: string } }
          detail = body?.error?.message ? `：${body.error.message}` : ''
        } catch {
          // 忽略响应体解析失败
        }
        throw new Error(`嵌入请求失败（HTTP ${res.status}）${detail}`)
      }
      const json = (await res.json()) as { data?: Array<{ index: number; embedding: number[] }> }
      if (!Array.isArray(json?.data)) throw new Error('嵌入接口响应格式异常（缺少 data 数组）')
      return json.data
    } catch (err) {
      if (signal?.aborted) throw new Error('请求已取消')
      lastErr = err
      // 已 throw 的用户可读错误（4xx/格式异常）不重试，直接向外传播
      if (err instanceof Error && !/暂不可用/.test(err.message)) throw err
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('嵌入请求失败')
}
