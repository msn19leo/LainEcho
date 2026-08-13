/**
 * 小米 MiMo TTS 客户端：仅支持 mimo-v2.5-tts-voiceclone 模型（声音克隆）。
 *
 * 协议要点（参考官方文档 https://mimo.mi.com/docs/zh-CN/api/audio/tts）：
 * - 端点：https://api.xiaomimimo.com/v1/chat/completions
 * - 采用 OpenAI Chat Completions 变种：合成文本放 assistant role，语言指令放 user role
 * - 参考音频 base64 必须放在 audio.voice 字段（不是 audio.data！）
 * - voice 字段需使用 Data URL 格式：data:{MIME_TYPE};base64,{BASE64_AUDIO}
 * - 返回 JSON 中 choices[0].message.audio.data 字段为 base64 编码的音频
 *
 * 语言切换：
 * - 中文：不附加额外指令，MiMo 默认按文本语言合成
 * - 日文：附加 user role 指令"日本語で話してください。"
 *
 * 注意：MiMo 是声音克隆 TTS 模型，不具备 LLM 式的上下文理解能力。
 * 早期方案 C 尝试把前文作为上下文注入 messages，但会导致：
 *  1) 参考文本被部分朗读（重复输出语音）
 *  2) 元指令干扰模型韵律判断（情感反而更乱）
 * 因此已移除 contextText 注入逻辑，messages 只保留语言指令 + 当前待合成文本。
 * 情感连贯性通过增大分句长度（MIN_FLUSH_LENGTH）和缓冲阈值（LONG_REPLY_THRESHOLD）来保证。
 */
import type { TTSConfig } from '../../src/types'

const MIMO_ENDPOINT = 'https://api.xiaomimimo.com/v1/chat/completions'

/** MiMo API 请求体（chat completions 变种） */
interface MiMoRequestBody {
  model: string
  messages: Array<{ role: string; content: string }>
  audio: {
    format: string
    /** voiceclone 模式下：参考音频的 Data URL（data:audio/wav;base64,xxx） */
    voice: string
  }
  /** 不启用流式：一次性返回完整 wav，简化播放逻辑 */
  stream: false
}

/** MiMo 响应体（仅声明关心的字段） */
interface MiMoResponseBody {
  choices?: Array<{
    message?: {
      audio?: {
        data?: string
      }
    }
  }>
  error?: {
    message?: string
    code?: string
  }
}

/** 文件扩展名 → MIME 类型映射表 */
const AUDIO_MIME: Record<string, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
}

/**
 * 调用 MiMo voiceclone 合成语音
 * @param params.apiKey MiMo API Key（sk-xxx）
 * @param params.text 要合成的文本
 * @param params.referenceAudioBase64 参考音频 base64（纯 base64，不带前缀）
 * @param params.referenceAudioExt 参考音频扩展名（wav/mp3），用于确定 MIME 类型
 * @param params.config TTS 配置（决定语言指令与模型名）
 * @returns wav 格式的 ArrayBuffer
 */
export async function synthesizeWithMiMo(params: {
  apiKey: string
  text: string
  referenceAudioBase64: string
  referenceAudioExt: string
  config: TTSConfig
}): Promise<ArrayBuffer> {
  const { apiKey, text, referenceAudioBase64, referenceAudioExt, config } = params

  // 构造 messages：user role 放语言指令（日文时），assistant role 只放当前要朗读的文本。
  // 不再注入上下文：MiMo 是声音克隆 TTS，不具备上下文理解能力，注入会导致重复朗读和情感干扰。
  const messages: Array<{ role: string; content: string }> = []
  if (config.language === 'ja') {
    messages.push({ role: 'user', content: '日本語で話してください。' })
  }
  messages.push({ role: 'assistant', content: text })

  // 构造 voice Data URL：data:{MIME};base64,{BASE64}
  // 官方要求 voiceclone 模式的 voice 字段必须是 Data URL 格式
  const mime = AUDIO_MIME[referenceAudioExt.toLowerCase()] ?? 'audio/wav'
  const voiceDataUrl = `data:${mime};base64,${referenceAudioBase64}`

  const body: MiMoRequestBody = {
    model: config.model,
    messages,
    audio: {
      format: 'wav',
      voice: voiceDataUrl,
    },
    stream: false,
  }

  const response = await fetch(MIMO_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    // 解析错误消息，便于上层显示给用户
    let errText = ''
    try {
      const errJson = (await response.json()) as MiMoResponseBody
      errText = errJson.error?.message ?? ''
    } catch {
      errText = await response.text().catch(() => '')
    }
    throw new Error(`MiMo TTS 请求失败 (${response.status}): ${errText || response.statusText}`)
  }

  const json = (await response.json()) as MiMoResponseBody
  const audioBase64 = json.choices?.[0]?.message?.audio?.data
  if (!audioBase64) {
    throw new Error('MiMo 返回数据缺少音频字段（choices[0].message.audio.data）')
  }

  return base64ToArrayBuffer(audioBase64)
}

/** Node.js Buffer 转 base64 字符串（不带 data: 前缀） */
export function bufferToBase64(buf: Buffer): string {
  return buf.toString('base64')
}

/** base64 字符串转 ArrayBuffer（主进程侧） */
function base64ToArrayBuffer(b64: string): ArrayBuffer {
  // Node.js 中通过 Buffer 解码，再复制到 ArrayBuffer 返回
  const buf = Buffer.from(b64, 'base64')
  // 注意：Buffer.from 返回的可能是 pool 内部切片，复制出独立 ArrayBuffer 更安全
  const ab = new ArrayBuffer(buf.byteLength)
  new Uint8Array(ab).set(buf)
  return ab
}
