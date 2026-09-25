/**
 * 屏幕感知分析器：截图 → 变化检测（dhash）→ 视觉模型转述。
 *
 * - 隐私红线：截图只在内存流转（NativeImage → base64 → VLM → 丢弃），不落盘、不进日志；
 * - 成本控制：9x8 灰度 dhash + 汉明距离变化检测，画面没变且缓存未过期时直接复用上次转述，
 *   避免重复调用视觉模型；
 * - 任一步失败返回 null（策略层降级为普通话题搭话），绝不阻塞、绝不抛出到调度循环。
 */
import { desktopCapturer, screen } from 'electron'
import { readSecret } from '../crypto'
import { getSettings } from '../repository'
import { paths } from '../storage'
import { normalizeBaseURL } from '../aiClient'

/** 转述缓存有效期（毫秒）：画面未变时直接复用，避免重复调用视觉模型 */
const CACHE_TTL_MS = 5 * 60 * 1000
/** dhash 汉明距离阈值：≥ 该值视为画面发生了变化 */
const DHASH_CHANGED_THRESHOLD = 6
/** 截图缩放目标宽度（降低分辨率 = 降低敏感信息泄露面 + 缩小请求体） */
const CAPTURE_WIDTH = 1024
/** 转述输出 token 上限 */
const VLM_MAX_TOKENS = 512
/** 截图 JPEG 质量 */
const JPEG_QUALITY = 80

/** 视觉模型配置（独立于主 LLM：visionBaseURL + 独立 Key + visionModel） */
interface VisionConfig {
  baseURL: string
  apiKey: string
  model: string
}

/** 转述缓存：上次转述文本 + 当时画面的 dhash + 时间 */
let cache: { text: string; hash: boolean[]; at: number } | null = null

/** 读取视觉模型配置；任一项缺失返回 null */
async function resolveVisionConfig(): Promise<VisionConfig | null> {
  const settings = await getSettings()
  const apiKey = await readSecret(paths.visionApiKeyFile).catch(() => null)
  if (!settings.visionBaseURL.trim() || !settings.visionModel.trim() || !apiKey) return null
  return { baseURL: settings.visionBaseURL, apiKey, model: settings.visionModel }
}

/**
 * 感知主流程：截图主屏 → dhash 变化检测 →（变化或无缓存时）视觉模型转述。
 * @returns ≤200 字的桌面转述文本；任一步失败返回 null
 */
export async function analyzeScreen(): Promise<string | null> {
  const cfg = await resolveVisionConfig()
  if (!cfg) return null
  try {
    // 1. 截取主屏（按主屏分辨率等比缩放到目标宽度）
    const primary = screen.getPrimaryDisplay()
    const scale = CAPTURE_WIDTH / Math.max(1, primary.size.width)
    const thumbnailSize = { width: CAPTURE_WIDTH, height: Math.max(1, Math.round(primary.size.height * scale)) }
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize })
    if (sources.length === 0) return null
    // 优先匹配主屏的 display_id，匹配不到退第一个
    const source = sources.find((s) => s.display_id === String(primary.id)) ?? sources[0]!
    const image = source.thumbnail
    if (image.isEmpty()) return null

    // 2. dhash 变化检测：画面没变且缓存未过期 → 直接复用上次转述
    const hash = computeDHash(image)
    if (cache && hash && Date.now() - cache.at < CACHE_TTL_MS && hammingDistance(hash, cache.hash) < DHASH_CHANGED_THRESHOLD) {
      return cache.text
    }

    // 3. 视觉模型转述（截图只在内存流转，转述完成即释放）
    const jpegBase64 = image.toJPEG(JPEG_QUALITY).toString('base64')
    const text = await describeWithVLM(jpegBase64, cfg)
    if (!text) return null
    cache = { text, hash: hash ?? [], at: Date.now() }
    return text
  } catch (err) {
    console.warn('[proactive] 屏幕感知失败（降级为普通话题）：', err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * 计算 9x8 灰度 dhash（64 位梯度指纹）：缩放到 9x8 后逐行比较相邻像素灰度。
 * 位序稳定，仅用于同实现的汉明距离比较。
 */
function computeDHash(image: Electron.NativeImage): boolean[] | null {
  try {
    const small = image.resize({ width: 9, height: 8 })
    const bitmap = small.toBitmap()
    if (bitmap.length < 9 * 8 * 4) return null
    const bits: boolean[] = []
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const idx = (y * 9 + x) * 4
        const idxNext = (y * 9 + x + 1) * 4
        // BGRA 布局：灰度 = 0.299R + 0.587G + 0.114B
        const gray = (b: number) => 0.299 * bitmap[b + 2]! + 0.587 * bitmap[b + 1]! + 0.114 * bitmap[b]!
        bits.push(gray(idxNext) > gray(idx))
      }
    }
    return bits
  } catch {
    return null
  }
}

/** 汉明距离：两个等长位串中不同位的个数 */
function hammingDistance(a: boolean[], b: boolean[]): number {
  const n = Math.min(a.length, b.length)
  let d = Math.abs(a.length - b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) d++
  return d
}

/**
 * 视觉模型转述：OpenAI 兼容 chat/completions + image_url（data URL）。
 * prompt 明确忽略我们自己的窗口并禁止罗列隐私细节；输出 ≤200 字。
 */
async function describeWithVLM(jpegBase64: string, cfg: VisionConfig): Promise<string | null> {
  const systemPrompt =
    '你是一个图像信息转述者。请用不超过200字描述这张桌面截图：\n' +
    '- 描述主体内容、正在使用的应用/网页、画面氛围\n' +
    '- 不要罗列具体文字内容，不要猜测隐私信息（账号、密码、聊天记录细节）\n' +
    '- 忽略任何属于"宠物窗/聊天窗"样式的小窗内容\n' +
    '- 只输出转述文本'
  const url = `${normalizeBaseURL(cfg.baseURL)}/chat/completions`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: systemPrompt },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpegBase64}` } },
          ],
        },
      ],
      max_tokens: VLM_MAX_TOKENS,
      temperature: 0.4,
      stream: false,
    }),
  })
  if (!res.ok) {
    // 响应体含 error.message（模型无权限/不支持图像/参数不兼容等具体原因），截断打印便于定位配置问题
    const body = await res.text().catch(() => '')
    console.warn('[proactive] 视觉模型请求失败（HTTP %d）：%s', res.status, body.slice(0, 300))
    return null
  }
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const text = json.choices?.[0]?.message?.content?.trim()
  return text || null
}
