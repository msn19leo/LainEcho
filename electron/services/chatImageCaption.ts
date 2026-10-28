/**
 * 聊天图片转述（任务型读图）。
 *
 * 与屏幕感知的"氛围型"转述（screenAnalyzer.describeWithVLM）是**两套 prompt**：
 * - 氛围型：模糊描述、刻意回避文字与隐私，用于"角色偷看一眼"的搭话；
 * - 任务型（本模块）：要求抄录文字、保留结构、标出异常，用于用户主动发图求解读。
 * 两者不可合并——改任何一边都会破坏另一端的行为预期。
 *
 * 单独成文件是为了避免循环依赖：repository 会级联调用 chatImages 做删会话清理，
 * 若 chatImages 直接引档案解析，会形成 repository → chatImages → apiProfiles → repository。
 */
import { resolveProfile } from './apiProfiles'
import { normalizeBaseURL } from './aiClient'

/** 转述输出 token 上限（思考型模型的 reasoning 也会占用，留足余量） */
const CAPTION_MAX_TOKENS = 800
/** 转述文本字符上限（落盘与回填上下文都按此截断） */
const CAPTION_MAX_CHARS = 600
/** 单次转述超时：视觉模型卡住时不能拖住整轮对话 */
const CAPTION_TIMEOUT_MS = 60_000

/**
 * 生成图片转述文本。
 * @param jpegBase64 压缩后的 JPEG（base64，不含 data: 前缀）
 * @returns 转述文本；未配置视觉模型或调用失败返回空串（调用方用占位兜底）
 */
export async function describeChatImage(jpegBase64: string): Promise<string> {
  const cfg = await resolveProfile('vision')
  if (!cfg) return ''
  const system = [
    '你是图像信息提取助手。请完整准确地转述这张图片，供另一个看不到图片的对话模型使用。',
    '要求：',
    '1. 先用一句话说明这是什么（截图/照片/界面/图表/文档等）与主体内容',
    '2. 画面中有文字时必须如实抄录关键内容（代码、报错、文档段落、聊天记录、表格数据），保留原有结构与层级',
    '3. 是界面或图表时，说明布局、关键控件与数据、以及异常提示（如红色报错、警告）',
    '4. 只描述看得见的内容，不评价、不建议、不猜测；看不清的地方标注「不清晰」',
    '5. 不超过 500 字',
    '只输出转述文本，不要任何解释或前缀。',
  ].join('\n')
  try {
    const res = await fetch(`${normalizeBaseURL(cfg.baseURL)}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: system },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpegBase64}` } },
            ],
          },
        ],
        max_tokens: CAPTION_MAX_TOKENS,
        temperature: 0.2,
        stream: false,
      }),
      signal: AbortSignal.timeout(CAPTION_TIMEOUT_MS),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.warn('[chat-image] 转述失败（HTTP %d）：%s', res.status, body.slice(0, 200))
      return ''
    }
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    return (json.choices?.[0]?.message?.content ?? '').trim().slice(0, CAPTION_MAX_CHARS)
  } catch (err) {
    console.warn('[chat-image] 转述异常：', err instanceof Error ? err.message : err)
    return ''
  }
}
