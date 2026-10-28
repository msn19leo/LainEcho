/**
 * 屏幕感知分析器：截图 → 变化检测（dhash）→ 视觉模型转述。
 *
 * 隐私红线：截图只在内存流转（NativeImage → base64 → VLM → 丢弃），不落盘、不进日志。
 *
 * 四条工程约束（P2 治理）：
 * 1. **超时**：VLM 请求带 45s 超时。调用方是调度循环，请求挂住会把整条 setTimeout 链拖死；
 * 2. **单飞**：同一时刻只允许一次感知，并发调用共享同一个 Promise（眼睛按钮连点不会打出多份请求）；
 * 3. **缓存对象化**：缓存带作用域（整屏/窗口）、应用标题与时间戳，换窗口不会被旧转述顶替；
 * 4. **不拿错屏**：整屏模式下 display_id 匹配不到就返回 null，绝不退到 sources[0]。
 *
 * 取景：默认只截**当前活动窗口**（长边 ≤1568，不放大只缩小）。窗口截图天然不含桌宠与聊天窗，
 * 且同样宽度下字比全屏清晰得多。整屏模式仅作兜底。
 */
import { desktopCapturer, screen } from 'electron'
import { resolveProfile } from '../apiProfiles'
import { normalizeBaseURL } from '../aiClient'
import { getSettings } from '../repository'
import { resolveTargetWindow } from '../perception/foreground'
import type { ScreenRange } from '../../../src/types'

/** 截图长边上限（与聊天图片压缩上限一致：再大只是烧 token） */
const MAX_EDGE = 1568
/** 转述缓存有效期（毫秒）：画面未变时直接复用，避免重复调用视觉模型 */
const CACHE_TTL_MS = 5 * 60 * 1000
/** dhash 汉明距离阈值：≥ 该值视为画面发生了变化 */
const DHASH_CHANGED_THRESHOLD = 6
/** 转述输出 token 上限（截图变清晰后篇幅需要放宽） */
const VLM_MAX_TOKENS = 700
/** 单次转述超时（必须存在：调度循环在等这个 Promise） */
const VLM_TIMEOUT_MS = 45_000
/** 截图 JPEG 质量（质量不影响 token，只影响体积） */
const JPEG_QUALITY = 85

/**
 * 转述风格：
 * - ambient：速览。只说氛围与大概，不读画面文字（主动搭话用，也是点眼睛的默认值）；
 * - detail：详述。如实转述主要内容与异常，但不逐字抄整屏文字（点眼睛选「详述」时用）。
 */
export type ScreenReadStyle = 'ambient' | 'detail'

/** 各风格的输出字数上限（提示词里同样会声明，这里只做兜底截断） */
const STYLE_MAX_CHARS: Record<ScreenReadStyle, number> = { ambient: 300, detail: 400 }

/** 视觉模型配置（档案制：激活档案的 地址 + Key + 模型 三元组） */
export interface VisionConfig {
  baseURL: string
  apiKey: string
  model: string
}

/** 一次感知的结果 */
export interface ScreenPerception {
  /** 转述文本（≤300 字） */
  text: string
  /** 截到的窗口标题（整屏模式恒为 null） */
  appTitle: string | null
  /** 感知时刻（毫秒）；命中缓存时是**当时**的时刻，调用方可据此判断新鲜度 */
  at: number
  /** 画面指纹（拿不到为 null） */
  hash: boolean[] | null
}

/** 转述缓存：作用域 + 风格 + 应用标题 + 指纹 + 时间 */
interface PerceptionCache {
  at: number
  scope: ScreenRange
  style: ScreenReadStyle
  appTitle: string | null
  hash: boolean[]
  text: string
}

let cache: PerceptionCache | null = null
/**
 * 单飞：并发的感知请求共享同一个 Promise。
 * 带 style：速览与详述不能共用同一个 in-flight（否则点了眼睛可能拿到主动搭话的速览结果）。
 */
let inFlight: { style: ScreenReadStyle; promise: Promise<ScreenPerception | null> } | null = null

/** 读取视觉模型配置；未启用/配置不完整返回 null（导出供立绘打标复用同一独立配置） */
export async function resolveVisionConfig(): Promise<VisionConfig | null> {
  return resolveProfile('vision')
}

/**
 * 感知主流程（单飞 + 缓存）。
 * @param force 跳过缓存（用户主动点眼睛时必须看到"现在"，不能拿 5 分钟前的转述）
 * @param style 转述风格（默认 ambient；detail 用于点眼睛的「详述」）
 */
export async function perceiveScreen(opts: { force?: boolean; style?: ScreenReadStyle } = {}): Promise<ScreenPerception | null> {
  const style: ScreenReadStyle = opts.style ?? 'ambient'
  if (inFlight) {
    if (inFlight.style === style) return inFlight.promise
    // 风格不同：等这次跑完再按新风格重来，避免把速览结果当成详述返回
    await inFlight.promise.catch(() => null)
    return perceiveScreen(opts)
  }
  const promise = perceiveInner({ ...opts, style }).catch((err) => {
    console.warn('[perception] 感知失败：', err instanceof Error ? err.message : err)
    return null
  })
  inFlight = { style, promise }
  try {
    return await promise
  } finally {
    if (inFlight?.promise === promise) inFlight = null
  }
}

/** 按设置解析取景范围：未开启「读取前台窗口」时只能整屏（选窗口本身就是读前台信息） */
function resolveRange(settings: { vision: { readForeground: boolean; screenRange: ScreenRange } }): ScreenRange {
  return settings.vision.readForeground && settings.vision.screenRange === 'window' ? 'window' : 'screen'
}

async function perceiveInner(opts: { force?: boolean; style?: ScreenReadStyle }): Promise<ScreenPerception | null> {
  const cfg = await resolveVisionConfig()
  if (!cfg) return null

  const settings = await getSettings()
  const range = resolveRange(settings)
  const style: ScreenReadStyle = opts.style ?? 'ambient'

  const captureStart = Date.now()
  const captured = await capture(range)
  if (!captured) return null
  const captureMs = Date.now() - captureStart
  const size = captured.image.getSize()

  const hash = computeDHash(captured.image)

  // 缓存判定：同作用域 + 同风格 + 同应用 + 画面没变 + 未过期 → 直接复用（force 时跳过）
  // 风格必须进 key：切换速览/详述后不能拿旧风格的转述顶替
  if (
    !opts.force &&
    cache &&
    cache.scope === range &&
    cache.style === style &&
    cache.appTitle === captured.appTitle &&
    hash &&
    Date.now() - cache.at < CACHE_TTL_MS &&
    hammingDistance(hash, cache.hash) < DHASH_CHANGED_THRESHOLD
  ) {
    console.log(
      '[perception] 命中缓存（%ds 前，range=%s style=%s）：%s',
      Math.round((Date.now() - cache.at) / 1000),
      range,
      style,
      cache.text.slice(0, 40),
    )
    return { text: cache.text, appTitle: cache.appTitle, at: cache.at, hash }
  }

  const jpeg = captured.image.toJPEG(JPEG_QUALITY)
  const vlmStart = Date.now()
  const text = await describeWithVLM(jpeg.toString('base64'), cfg, style)
  if (!text) {
    console.warn('[perception] 转述失败（range=%s 尺寸=%dx%d 截图=%dms）', range, size.width, size.height, captureMs)
    return null
  }

  console.log(
    '[perception] 感知完成：range=%s style=%s 尺寸=%dx%d 截图=%dms 转述=%dms 图片=%dKB 文本=%d字%s',
    range,
    style,
    size.width,
    size.height,
    captureMs,
    Date.now() - vlmStart,
    Math.round(jpeg.byteLength / 1024),
    text.length,
    captured.appTitle ? ` 窗口=${captured.appTitle}` : '',
  )

  const at = Date.now()
  cache = { at, scope: range, style, appTitle: captured.appTitle, hash: hash ?? [], text }
  return { text, appTitle: captured.appTitle, at, hash }
}

/**
 * 兼容包装：只取转述文本（主动搭话策略层用）。
 * @returns ≤300 字转述；任一步失败返回 null（调用方降级为普通话题）
 */
export async function analyzeScreen(opts: { force?: boolean; style?: ScreenReadStyle } = {}): Promise<string | null> {
  const p = await perceiveScreen(opts)
  return p?.text ?? null
}

/**
 * 取一张截图并以 base64 返回（不调视觉模型、不落盘、不缓存）。
 * 供「直读」模式：把截图作为当轮临时图片直接发给主模型。
 * @returns null = 截不到（无可用窗口 / 主屏匹配失败 / 空图）
 */
export async function captureScreenImage(): Promise<{ base64: string; appTitle: string | null } | null> {
  try {
    const settings = await getSettings()
    const captured = await capture(resolveRange(settings))
    if (!captured) return null
    return {
      base64: captured.image.toJPEG(JPEG_QUALITY).toString('base64'),
      appTitle: captured.appTitle,
    }
  } catch (err) {
    console.warn('[perception] 取图失败：', err instanceof Error ? err.message : err)
    return null
  }
}

/** 归一化：空图返回 null；长边超过上限才缩小（绝不放大——放大没有信息增量，只烧 token） */
function normalize(image: Electron.NativeImage, appTitle: string | null): { image: Electron.NativeImage; appTitle: string | null } | null {
  if (image.isEmpty()) return null
  const { width, height } = image.getSize()
  if (width <= 0 || height <= 0) return null
  const longEdge = Math.max(width, height)
  if (longEdge <= MAX_EDGE) return { image, appTitle }
  const resized =
    width >= height
      ? image.resize({ width: MAX_EDGE, height: Math.max(1, Math.round((height * MAX_EDGE) / width)) })
      : image.resize({ width: Math.max(1, Math.round((width * MAX_EDGE) / height)), height: MAX_EDGE })
  return { image: resized, appTitle }
}

/**
 * 按范围取景。
 * - window：启发式选出前台窗口（排除自家窗口），请求长边 1568 的缩略图，超限再缩；
 * - screen：主屏整屏，display_id 匹配不到直接放弃（不拿错屏）。
 */
async function capture(range: ScreenRange): Promise<{ image: Electron.NativeImage; appTitle: string | null } | null> {
  try {
    if (range === 'window') {
      const target = await resolveTargetWindow({ width: MAX_EDGE, height: MAX_EDGE }, { debug: true })
      if (!target) {
        console.log('[perception] 没有可用的前台窗口，跳过本次感知')
        return null
      }
      const normalized = normalize(target.thumbnail, target.name?.trim() || null)
      if (!normalized) {
        // 最小化的窗口截不到内容（黑图/空图），按感知失败处理
        console.log('[perception] 目标窗口缩略图为空（可能已最小化）')
      }
      return normalized
    }

    const primary = screen.getPrimaryDisplay()
    const scale = MAX_EDGE / Math.max(1, primary.size.width)
    const thumbnailSize = { width: MAX_EDGE, height: Math.max(1, Math.round(primary.size.height * scale)) }
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize })
    const source = sources.find((s) => s.display_id === String(primary.id))
    if (!source) {
      console.warn('[perception] 未找到主屏对应的截图源，放弃本次感知')
      return null
    }
    return normalize(source.thumbnail, null)
  } catch (err) {
    console.warn('[perception] 截图失败：', err instanceof Error ? err.message : err)
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
 * prompt 为**氛围型**（刻意回避罗列文字与隐私），与聊天图片的任务型转述是两套，不可合并。
 */
/** 速览提示词：只说氛围与大概，刻意不读画面文字（隐私面最小） */
const AMBIENT_PROMPT =
  '你是一个图像信息转述者。请用不超过300字描述这张桌面截图：\n' +
  '- 说明主体内容、正在使用的应用/网页/窗口、画面氛围\n' +
  '- 不要罗列具体文字内容，不要猜测隐私信息（账号、密码、聊天记录细节）\n' +
  // 桌宠窗口已由 setContentProtection 从截图中技术性排除，但聊天窗/剧情窗仍会被整屏截到
  // （刻意不保护它们：用户经常要截图设置页/聊天窗反馈问题），所以这条仍需保留。
  '- 画面中若出现本应用自己的聊天窗、剧情窗（或桌宠），一律忽略，只描述其他内容\n' +
  '- 只输出转述文本'

/** 详述提示词：如实转述主要内容与异常，但明确禁止逐字抄整屏文字 */
const DETAIL_PROMPT =
  '你是一个屏幕信息转述者。用户允许你仔细看这张屏幕截图，请把关键信息转述给另一个看不到图片的对话模型。\n' +
  '要求：\n' +
  '1. 先用一句话说明这是什么应用/页面、正在做什么\n' +
  '2. 画面里有文字时，只转述**主要**的内容（关键报错、核心结论、正在编辑的对象），不要逐字抄录整屏文字；文字很多时抓要点，按重要性取舍\n' +
  '3. 若画面是代码编辑器、终端或明显带异常的界面，指出关键报错与警告；不是这类画面就直接略过，不要写「暂无报错」之类的句子\n' +
  '4. 画面中若出现本应用自己的聊天窗、剧情窗（或桌宠），一律忽略\n' +
  '5. 只描述看得见的内容，不评价、不建议、不猜测；看不清的地方标注「不清晰」\n' +
  '6. 不超过 400 字\n' +
  '只输出转述文本。'

/**
 * 视觉模型转述：OpenAI 兼容 chat/completions + image_url（data URL）。
 * 两套提示词按 style 选择，**不可合并**：
 * - ambient 面向"角色瞥一眼找话由"，刻意回避具体文字；
 * - detail 面向"用户要求它认真看"，要读内容但禁止逐字抄屏。
 */
async function describeWithVLM(jpegBase64: string, cfg: VisionConfig, style: ScreenReadStyle = 'ambient'): Promise<string | null> {
  const systemPrompt = style === 'detail' ? DETAIL_PROMPT : AMBIENT_PROMPT
  const url = `${normalizeBaseURL(cfg.baseURL)}/chat/completions`
  try {
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
        temperature: style === 'detail' ? 0.2 : 0.4,
        stream: false,
      }),
      // 必须在场：调用方是调度循环，无超时的挂起会把整条定时器链拖死
      signal: AbortSignal.timeout(VLM_TIMEOUT_MS),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.warn('[perception] 视觉模型请求失败（HTTP %d）：%s', res.status, body.slice(0, 300))
      return null
    }
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const text = json.choices?.[0]?.message?.content?.trim()
    if (!text) return null
    // 兜底截断：提示词已经限制字数，这里只防模型超发；截断处补省略号，避免断在句中毫无提示
    const max = STYLE_MAX_CHARS[style]
    return text.length > max ? `${text.slice(0, max)}…` : text
  } catch (err) {
    console.warn('[perception] 视觉模型调用异常：', err instanceof Error ? err.message : err)
    return null
  }
}
