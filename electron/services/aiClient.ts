/**
 * OpenAI 兼容 API 客户端。
 * 请求由主进程发起（fetch / SSE），API Key 不暴露给渲染进程。
 */
import type { ChatMessage } from '../../src/types'

export interface ChatRequestOptions {
  model: string
  baseURL: string
  apiKey: string
  temperature?: number
  maxTokens?: number
  /** 默认 true；为 false 时使用非流式请求 */
  stream?: boolean
  /** 流式时的 token 回调 */
  onChunk?: (chunk: string) => void
  signal?: AbortSignal
  /** 测试连接时覆盖 max_tokens（默认 5） */
  maxTokensOverride?: number
}

/** 规范化 baseURL：去首尾空白与末尾斜杠（chat 与 embeddings 请求共用） */
export function normalizeBaseURL(baseURL: string): string {
  return baseURL.trim().replace(/\/+$/, '')
}

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message
    if (/fetch failed/i.test(msg)) return '无法连接到 API 服务器，请检查 baseURL 与网络'
    return msg
  }
  return String(err)
}

/**
 * 发起 chat/completions 请求。
 * - stream=true：SSE 逐 token 回调 onChunk，resolve 完整回复文本
 * - stream=false：一次返回完整回复文本
 * 出错时抛出用户可读的错误信息。
 */
export async function sendChatCompletion(
  messages: ChatMessage[],
  options: ChatRequestOptions,
): Promise<string> {
  const { model, baseURL, apiKey, temperature, maxTokens, stream = true, onChunk, signal, maxTokensOverride } = options

  if (!baseURL.trim()) throw new Error('未配置 API 地址（baseURL）')
  if (!model.trim()) throw new Error('未配置模型名（model）')
  if (!apiKey) throw new Error('未配置 API Key')

  const url = `${normalizeBaseURL(baseURL)}/chat/completions`
  const body: Record<string, unknown> = {
    model,
    messages,
    stream,
    max_tokens: maxTokensOverride ?? maxTokens,
  }
  if (temperature !== undefined && temperature !== null) body.temperature = temperature

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    })
  } catch (err) {
    if (signal?.aborted) throw new Error('请求已取消')
    throw new Error(extractErrorMessage(err))
  }

  if (!res.ok) {
    const detail = await safeErrorBody(res)
    throw new Error(`API 请求失败（HTTP ${res.status}）${detail}`)
  }

  if (!stream) {
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    return json.choices?.[0]?.message?.content ?? ''
  }

  // --- SSE 流式解析 ---
  if (!res.body) throw new Error('API 未返回可读的流式响应')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let full = ''
  let done = false

  while (!done) {
    let chunk: ReadableStreamReadResult<Uint8Array>
    try {
      chunk = await reader.read()
    } catch (err) {
      if (signal?.aborted) throw new Error('请求已取消')
      throw new Error(extractErrorMessage(err))
    }
    done = chunk.done
    if (chunk.value) buffer += decoder.decode(chunk.value, { stream: !done })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      if (data === '[DONE]') continue
      if (data) {
        try {
          const json = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string } }>
            error?: { message?: string }
          }
          // OpenAI 兼容网关可能在 200 流中下发 error 事件（如上游模型报错）
          if (json.error?.message) {
            throw new Error(`模型返回错误：${json.error.message}`)
          }
          const delta = json.choices?.[0]?.delta?.content
          if (delta) {
            full += delta
            onChunk?.(delta)
          }
        } catch (err) {
          if (err instanceof Error) throw err
          // 忽略无法解析的行（如 keep-alive 心跳）
        }
      }
    }
  }

  // 流结束且末尾 data 行没有换行时，解析缓冲区残留
  if (buffer.trim()) {
    const trimmed = buffer.trim()
    if (trimmed.startsWith('data:')) {
      const data = trimmed.slice(5).trim()
      if (data && data !== '[DONE]') {
        try {
          const json = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string } }>
            error?: { message?: string }
          }
          if (json.error?.message) throw new Error(`模型返回错误：${json.error.message}`)
          const delta = json.choices?.[0]?.delta?.content
          if (delta) {
            full += delta
            onChunk?.(delta)
          }
        } catch (err) {
          if (err instanceof Error) throw err
        }
      }
    }
  }

  if (signal?.aborted) throw new Error('请求已取消')
  return full
}

async function safeErrorBody(res: Response): Promise<string> {
  try {
    const json = (await res.json()) as { error?: { message?: string } }
    return json.error?.message ? `：${json.error.message}` : ''
  } catch {
    return ''
  }
}
