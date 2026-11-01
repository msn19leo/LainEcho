/**
 * OpenAI 兼容 API 客户端。
 * 请求由主进程发起（fetch / SSE），API Key 不暴露给渲染进程。
 */
import type { ChatMessage } from '../../src/types'

/** 多模态内容片段（OpenAI 兼容协议）：带图轮次的 content 用数组承载 */
export type ApiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

/**
 * 请求消息形状：content 为纯文本（绝大多数场景）或内容片段数组（带图轮次）。
 * 比 ChatMessage 更宽，便于 chatTurn 在发送前把图片拼成多模态 parts。
 */
export interface ApiMessage {
  role: ChatMessage['role']
  content: string | ApiContentPart[]
}

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
  /** 思考通道回调（思考型模型的 reasoning_content / reasoning 字段，OpenAI 兼容网关常见）。
   *  content 通道为空时，调用方可从思考文本中抢救正文。 */
  onReasoning?: (chunk: string) => void
  /** 尝试关闭思考模式（结构化生成任务用）：GLM 系列走 body.thinking={type:'disabled'}。
   *  思考型模型的 reasoning 计入 max_tokens 预算，任务不需要思考时关闭可避免预算被吃光。
   *  仅在调用方显式传 true 时附加该参数（部分网关不认识会忽略，OpenAI 官方端点不接受此参数）。 */
  /**
   * 档案级思考模式：undefined = 不注入（沿用服务商默认）；false = 显式关闭；true = 显式开启。
   * 与 disableThinking 的区别是它来自用户配置，优先级更高。
   */
  enableThinking?: boolean
  /** 额外请求参数：最后合并，同名覆盖（model / messages / stream 受保护，不允许覆盖） */
  extraBody?: Record<string, unknown> | null
  /**
   * 被截断/空输出时是否自动翻倍预算重试（默认 true）。
   * 连通性探测这类"只看能不能通、不看内容"的调用应传 false：
   * 否则思考型模型必然触顶 → 白跑第二遍（慢一倍）并刷出 WARN。
   */
  retryOnIncomplete?: boolean
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
 * 生成 `thinking` 字段（OpenAI 兼容协议的公共约定，非某一家方言）。
 *
 * 为什么"缺失即危险"：DeepSeek Reasoner / GLM 4.5+ 在字段缺失时**默认开启思考**，
 * 而思考 token 往往计入 max_tokens —— 预算小的任务（摘要 300、翻译短句）会被思考吃光，
 * content 返回空，表现为"什么都没生成"。所以只要用户显式选过开/关，就始终注入。
 *
 * MiniMax 例外：只接受 adaptive / disabled，传 enabled 会 400。
 * `undefined` = 不注入，交给服务商默认（用户选「自动」时）。
 */
export function thinkingPatch(model: string, enableThinking?: boolean): { thinking: { type: string } } | null {
  if (enableThinking === undefined) return null
  const isMinimax = /minimax/i.test(model)
  return { thinking: { type: enableThinking ? (isMinimax ? 'adaptive' : 'enabled') : 'disabled' } }
}

/**
 * 发起 chat/completions 请求。
 * - stream=true：SSE 逐 token 回调 onChunk，resolve 完整回复文本
 * - stream=false：一次返回完整回复文本
 * 出错时抛出用户可读的错误信息。
 */
async function sendChatCompletionOnce(
  messages: ApiMessage[],
  options: ChatRequestOptions,
  budgetOverride?: number,
): Promise<{ content: string; finishReason?: string }> {
  const {
    model,
    baseURL,
    apiKey,
    temperature,
    maxTokens,
    stream = true,
    onChunk,
    onReasoning,
    enableThinking,
    extraBody,
    signal,
    maxTokensOverride,
  } = options

  if (!baseURL.trim()) throw new Error('未配置 API 地址（baseURL）')
  if (!model.trim()) throw new Error('未配置模型名（model）')
  if (!apiKey) throw new Error('未配置 API Key')

  const url = `${normalizeBaseURL(baseURL)}/chat/completions`
  // 预算优先级：本次重试给定 > 调用方指定 > 设置里的全局 maxTokens
  const budget = budgetOverride ?? maxTokensOverride ?? maxTokens
  const body: Record<string, unknown> = {
    model,
    messages,
    stream,
    max_tokens: budget,
  }
  if (temperature !== undefined && temperature !== null) body.temperature = temperature

  /**
   * 档案级思考开关（优先级高于上面的内部 disableThinking）。
   *
   * 为什么"缺失即危险"：DeepSeek Reasoner 这类模型在 thinking 字段缺失时**默认开启思考**，
   * 表现为首字延迟 3–20 秒。所以用户一旦显式选过开/关，就始终注入该字段。
   * 对不认识该字段的服务商通常被忽略（无害）；MiniMax 例外：只接受 adaptive / disabled，
   * 传 enabled 会 400，故开启时映射为 adaptive。
   */
  const think = thinkingPatch(model, enableThinking)
  if (think) body.thinking = think.thinking

  /**
   * 额外请求参数：最后合并，让用户手填的覆盖上面所有默认。
   * 保护 model / messages / stream —— 被覆盖会让整个请求失效且报错对不上原因。
   */
  if (extraBody) {
    for (const [key, value] of Object.entries(extraBody)) {
      if (key === 'model' || key === 'messages' || key === 'stream') continue
      body[key] = value
    }
  }

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
      choices?: Array<{
        message?: { content?: string; reasoning_content?: string; reasoning?: string }
        finish_reason?: string | null
      }>
    }
    const choice = json.choices?.[0]
    const msg = choice?.message
    const reasoning = msg?.reasoning_content ?? msg?.reasoning
    if (reasoning) onReasoning?.(reasoning)
    return { content: msg?.content ?? '', finishReason: choice?.finish_reason ?? undefined }
  }

  // --- SSE 流式解析 ---
  if (!res.body) throw new Error('API 未返回可读的流式响应')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let full = ''
  let done = false

  /** 处理单条 SSE data JSON：思考通道 → onReasoning，正文通道 → onChunk 累积 */
  let finishReason: string | undefined
  const handleChunkJson = (json: {
    choices?: Array<{
      delta?: { content?: string; reasoning_content?: string; reasoning?: string }
      finish_reason?: string | null
    }>
    error?: { message?: string }
  }): void => {
    // OpenAI 兼容网关可能在 200 流中下发 error 事件（如上游模型报错）
    if (json.error?.message) {
      throw new Error(`模型返回错误：${json.error.message}`)
    }
    const choice = json.choices?.[0]
    if (choice?.finish_reason) finishReason = choice.finish_reason
    const delta = choice?.delta
    const reasoning = delta?.reasoning_content ?? delta?.reasoning
    if (reasoning) onReasoning?.(reasoning)
    if (delta?.content) {
      full += delta.content
      onChunk?.(delta.content)
    }
  }

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
          handleChunkJson(JSON.parse(data))
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
          handleChunkJson(JSON.parse(data))
        } catch (err) {
          if (err instanceof Error) throw err
        }
      }
    }
  }

  if (signal?.aborted) throw new Error('请求已取消')
  return { content: full, finishReason }
}

/** 重试时的预算硬上限：再大就是模型跑偏了，不是预算问题 */
const RETRY_BUDGET_CAP = 8192

/**
 * 发起 chat/completions 请求（对外入口）。
 *
 * 在 `sendChatCompletionOnce` 之上加一层**截断兜底**：非流式调用若被 max_tokens 截断
 * （`finish_reason === 'length'`）或输出为空（且不是模型明确说 stop），自动把预算翻倍重试一次。
 *
 * 为什么需要：思考型模型（GLM 4.5+ / DeepSeek Reasoner / o 系列）的 reasoning 常计入
 * max_tokens，而思考长度不可预测（同一模型同一任务可能 200 也可能 1500）。靠"把预算猜够"
 * 迟早翻车，索性在被截断时补一次 —— 只在真出问题时多一次请求，平时零成本。
 *
 * 流式不重试：正文已经边出边推给渲染层，重来一遍会让同一段文字出现两次。
 */
export async function sendChatCompletion(
  messages: ApiMessage[],
  options: ChatRequestOptions,
): Promise<string> {
  const first = await sendChatCompletionOnce(messages, options)
  // 注意用 !== false：stream 缺省即流式（sendChatCompletionOnce 里默认 true），
  // 若按 falsy 判断，漏传 stream 的流式调用会被当成非流式重试 → 同一段文字推两遍
  if (options.stream !== false || options.retryOnIncomplete === false) return first.content

  const empty = !first.content.trim()
  const truncated = first.finishReason === 'length'
  // 模型明确 stop 且内容为空 = 它确实没话说，不是预算问题
  if (!truncated && !(empty && first.finishReason !== 'stop')) return first.content

  const base = options.maxTokensOverride ?? options.maxTokens
  const next = Math.min(RETRY_BUDGET_CAP, Math.max((base ?? 512) * 2, 1024))
  if (base !== undefined && next <= base) return first.content

  console.warn(
    '[llm] 输出不完整（finish=%s 预算=%s 空=%s），预算提到 %d 重试一次：model=%s',
    first.finishReason ?? '-',
    base ?? 'default',
    empty,
    next,
    options.model,
  )
  const second = await sendChatCompletionOnce(messages, options, next)
  return second.content || first.content
}

async function safeErrorBody(res: Response): Promise<string> {
  try {
    const json = (await res.json()) as { error?: { message?: string } }
    return json.error?.message ? `：${json.error.message}` : ''
  } catch {
    return ''
  }
}
