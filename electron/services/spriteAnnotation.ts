/**
 * 立绘视觉打标：对立绘集逐张图片调用视觉模型，生成一条**状态标签**（多词用「，」拼接）。
 *
 * - 配置复用屏幕感知的视觉模型档案（档案制：激活档案提供地址/模型/Key），不回退主 LLM；
 * - 产物不落库（与 personaGenerator 同一口径）：建议返回给渲染端，由词表编辑器确认后经 sprite:update 保存；
 * - 容错：单张失败跳过计数（failed），不阻塞整批；未配置视觉模型直接返回 ok:false；
 * - 可跳过已标注的图（skipImages）：打标通常只补缺口，没必要把已配好的图再跑一遍；
 * - **失败必留痕**：区分 不支持格式 / 超大 / HTTP / 超时 / 空内容 / 解析失败，并带 finish_reason 与正文片段。
 *   此前只 `failed++` 不打印任何东西，出现"失败 15 张"时完全无法判断是网络、预算还是格式。
 */
import { promises as fs } from 'fs'
import path from 'path'
import { normalizeBaseURL, thinkingPatch } from './aiClient'
import { normalizeLabel, splitLabel } from '../../src/types'
import type { ResolvedLlmConfig } from './apiProfiles'
import { resolveVisionConfig } from './proactive/screenAnalyzer'
import { listSprites } from './repository'
import { paths } from './storage'

/** 支持的立绘图片扩展名 → MIME（与 sprites.ipc 的导入白名单保持一致） */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
}

/** 并发请求数：视觉模型并发太高容易触发限流，2 路串行批次 */
const CONCURRENCY = 2
/**
 * 单张打标输出 token 上限。
 *
 * 输出本身只有 30~60 token（一行 JSON），但**思考型视觉模型（GLM-4.6V 等）的 reasoning
 * 计入 max_tokens**：预算给 200 时会被思考吃光，content 返回空，表现为"打标失败"。
 * 抬高预算只影响截断，不按上限计费，所以留足余量。
 */
const MAX_TOKENS = 1024
/** 被截断时的重试预算（只重试一次，避免思考型模型无限翻倍） */
const RETRY_MAX_TOKENS = 2048
/** 单张请求超时（毫秒） */
const REQUEST_TIMEOUT_MS = 60_000
/** 单个词长度上限（视觉模型偶发输出长句，截断保护） */
const WORD_MAX = 6
/** 每张图最多保留几个词（多则拼成一条标签，编号不变） */
const WORDS_MAX = 4

/** 单张打标建议 */
export interface SpriteAnnotationSuggestion {
  /** 图片文件名（相对 sprites/{id}/） */
  filePath: string
  /** 建议标签串（2-4 个词用「，」拼接，如「害羞，心动」；首个词最具代表性） */
  name: string
}

/** 打标结果：suggestions 成功项 + failed 失败张数 + skipped 跳过张数 */
export interface SpriteAnnotationResult {
  ok: boolean
  suggestions?: SpriteAnnotationSuggestion[]
  failed?: number
  /** 因"已有状态词"而跳过的张数（仅在传入 skipImages 时非 0） */
  skipped?: number
  /** 因标签与本批其它图重复而丢弃的张数（重复编号在 prompt 里无法区分，只保留第一张） */
  duplicated?: number
  error?: string
}

/** 失败原因（只用于日志，便于一眼定位是配置问题还是解析问题） */
type FailReason = 'unsupported-ext' | 'too-large' | 'http' | 'timeout' | 'empty' | 'parse'

/**
 * 打标 prompt：一次给一张图 2~4 个词，拼成**一条标签**（对应一个编号）。
 *
 * 为什么多词：一个编号 = 一张图，标签里的多个词是同一张图的不同说法/近义情绪，
 * 词越多越容易命中（"心动"可以挂在害羞那张图上），而编号数量不变。
 * 首个词必须是最具代表性的那个，它决定 prompt 里该行的第一印象。
 */
const ANNOTATE_PROMPT =
  '你是 galgame 立绘标注助手。请看这张角色立绘，只输出一行 JSON（不要任何其他文字、不要 markdown 代码块）：\n' +
  '{"words":["<2到4个中文字的演出关键词>","<同义或近义说法>","<另一个常见说法>"]}\n' +
  '要求：\n' +
  '1. 给 2 到 4 个词，第一个最具代表性，其余是同义/近义/更口语的说法（如 害羞，脸红，心动）；\n' +
  '2. 词面向演出状态（什么时候用这张图），情绪词如 得意/委屈/傲娇，姿态/行为词如 解释/警告/沉思 均可；\n' +
  '3. 忽略画面中的背景/地点/道具/其他人物——那是拍摄场景，不代表这张立绘的使用条件；\n' +
  '4. 不要罗列外观细节（发色/服装/姿势描述），只写"这张图适合什么场面"。\n' +
  '示例：✓ ["害羞","脸红","心动"]  ✓ ["困倦","打哈欠","睁不开眼"]  ✗ ["双手摊开","迎接客人"]（这是画面内容，不是演出状态）。'

/** 清理单个词：去引号/括号/尾标点，截断到 WORD_MAX */
function cleanupWord(raw: unknown): string {
  return String(raw ?? '')
    .replace(/^[\s"'“”‘’「」『』【】[\]{}（）()]+/, '')
    .replace(/[\s"'“”‘’「」『』【】[\]{}（）()]+$/, '')
    .replace(/[，,。.；;：:！!？?、~～…]+$/g, '')
    .trim()
    .slice(0, WORD_MAX)
}

/**
 * 严格取词：只接受 2~6 个纯中文的词，**不做截断**。
 *
 * 用于"不是 JSON 时的兜底"：整句散文截前 6 个字也能凑出"无法判断这张"这种假词，
 * 所以兜底路径宁可放过（判失败）也不能造出垃圾标签。
 */
function asShortWord(raw: unknown): string {
  const t = String(raw ?? '')
    .replace(/^[\s"'“”‘’「」『』【】[\]{}（）()]+/, '')
    .replace(/[\s"'“”‘’「」『』【】[\]{}（）()]+$/, '')
    .replace(/[，,。.；;：:！!？?、~～…]+$/g, '')
    .trim()
  return /^[\u4e00-\u9fa5]{2,6}$/.test(t) ? t : ''
}

/** 把模型给的字段值统一成词数组：数组逐项清理，字符串按分隔符拆开 */
function toWords(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(cleanupWord).filter(Boolean)
  if (typeof value === 'string') return splitLabel(value).map(cleanupWord).filter(Boolean)
  return []
}

/** 从文本里截出 `{...}` 与 `[...]` 片段（取首个开符号到末个闭符号，容忍围栏与前后说明） */
function sliceCandidates(text: string): unknown[] {
  const out: unknown[] = []
  const trySlice = (open: string, close: string) => {
    const a = text.indexOf(open)
    const b = text.lastIndexOf(close)
    if (a === -1 || b <= a) return
    try {
      out.push(JSON.parse(text.slice(a, b + 1)))
    } catch {
      // 解析失败就交给下一种候选
    }
  }
  trySlice('{', '}')
  trySlice('[', ']')
  return out
}

/**
 * 解析模型回复，尽量把词捞出来。
 *
 * 兼容四种形态（实测视觉模型会漂移）：
 *  1. `{"words":["a","b"]}`（契约形态）
 *  2. `["a","b"]`（直接给数组）
 *  3. `{"words":"a，b"}` / `{"state":"a"}` / `{"tags":[...]}`（字段名或类型漂移）
 *  4. 完全不是 JSON：从引号里抓词，或按逗号顿号切分后过滤纯中文短词
 *
 * @returns 解析出的建议；确实捞不到时返回 null（由调用方按失败计数）
 */
export function parseAnnotationReply(text: string, filePath: string): SpriteAnnotationSuggestion | null {
  const raw = String(text ?? '').trim()
  if (!raw) return null

  const words: string[] = []
  const push = (list: string[]) => {
    for (const w of list) {
      if (w && !words.includes(w)) words.push(w)
      if (words.length >= WORDS_MAX) break
    }
  }

  for (const cand of sliceCandidates(raw)) {
    if (Array.isArray(cand)) {
      push(toWords(cand))
    } else if (cand && typeof cand === 'object') {
      const obj = cand as Record<string, unknown>
      // 常见字段名都试一遍：契约是 words，其余是模型漂移时的替身
      push(toWords(obj.words ?? obj.word ?? obj.tags ?? obj.labels ?? obj.state ?? obj.emotion))
    }
    if (words.length >= 2) break
  }

  // 兜底一：引号里的短词（"害羞"、"脸红"）
  if (words.length === 0) {
    for (const m of raw.matchAll(/["“「『]([^"”」』\n]{2,8})["”」』]/g)) {
      const w = asShortWord(m[1])
      if (w && !words.includes(w)) words.push(w)
      if (words.length >= WORDS_MAX) break
    }
  }
  // 兜底二：按分隔符切分（必须真的出现过分隔符，避免把一句散文截成词）
  if (words.length === 0) {
    const parts = splitLabel(raw)
    if (parts.length > 1) {
      for (const part of parts) {
        const w = asShortWord(part)
        if (w && !words.includes(w)) words.push(w)
        if (words.length >= WORDS_MAX) break
      }
    }
  }

  const name = normalizeLabel(words.slice(0, WORDS_MAX).join('，'))
  return name ? { filePath, name } : null
}

/** 单次请求结果（把 finish_reason 一并带出来，供重试与日志判断） */
interface VisionReply {
  content: string
  finishReason?: string
  reasoningLen: number
}

/**
 * 发起一次视觉请求。
 * @returns 成功返回回复内容；HTTP 失败/超时返回带 reason 的失败
 */
async function requestOnce(
  url: string,
  cfg: ResolvedLlmConfig,
  dataUrl: string,
  maxTokens: number,
): Promise<{ ok: true; reply: VisionReply } | { ok: false; reason: FailReason; detail: string }> {
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        model: cfg.model,
        // 思考开关跟随档案：「自动」不注入字段（交给服务商默认），只有显式关才注入 disabled
        ...(thinkingPatch(cfg.model, cfg.enableThinking) ?? {}),
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: ANNOTATE_PROMPT },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
        max_tokens: maxTokens,
        temperature: 0.3,
        stream: false,
      }),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const timeout = /abort|timeout/i.test(msg)
    return { ok: false, reason: timeout ? 'timeout' : 'http', detail: msg }
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    return { ok: false, reason: 'http', detail: `HTTP ${res.status} ${body.slice(0, 200)}` }
  }

  const data = (await res.json().catch(() => ({}))) as {
    choices?: Array<{
      message?: { content?: string; reasoning_content?: string }
      finish_reason?: string | null
    }>
  }
  const choice = data.choices?.[0]
  return {
    ok: true,
    reply: {
      content: String(choice?.message?.content ?? ''),
      finishReason: choice?.finish_reason ?? undefined,
      reasoningLen: String(choice?.message?.reasoning_content ?? '').length,
    },
  }
}

/** 日志用：把正文压成一行短片段（区分"空"与"格式不对"的关键信息） */
function snippet(text: string): string {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat ? flat.slice(0, 80) : '（空）'
}

/**
 * 单张打标：读图 → base64 data URL → OpenAI 兼容 chat/completions（image_url）。
 *
 * 被截断（finish_reason=length）或正文为空时**自动抬高预算重试一次**：
 * 思考型视觉模型会把 reasoning 计入 max_tokens，第一次 1024 不够时 2048 通常能写完。
 *
 * @returns 建议；任何失败都返回 null 并打印带原因的一行日志
 */
async function annotateOne(
  absPath: string,
  filePath: string,
  cfg: ResolvedLlmConfig,
): Promise<SpriteAnnotationSuggestion | null> {
  const fail = (reason: FailReason, detail: string) => {
    console.warn('[sprite-annotate] 失败 file=%s 原因=%s %s', filePath, reason, detail)
    return null
  }

  let buf: Buffer
  try {
    const ext = path.extname(absPath).toLowerCase()
    const mime = MIME_BY_EXT[ext]
    if (!mime) return fail('unsupported-ext', `ext=${ext}`)
    buf = await fs.readFile(absPath)
    // 体积保护：>6MB 的图跳过（罕见，通常是误导入的非立绘大图）
    if (buf.byteLength > 6 * 1024 * 1024) return fail('too-large', `${(buf.byteLength / 1024 / 1024).toFixed(1)}MB`)
    const url = `${normalizeBaseURL(cfg.baseURL)}/chat/completions`
    const dataUrl = `data:${mime};base64,${buf.toString('base64')}`

    let budget = MAX_TOKENS
    let lastReason: FailReason = 'parse'
    let lastDetail = ''
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await requestOnce(url, cfg, dataUrl, budget)
      if (!r.ok) return fail(r.reason, r.detail)

      const { content, finishReason, reasoningLen } = r.reply
      const parsed = parseAnnotationReply(content, filePath)
      if (parsed) return parsed

      // 空正文且被截断 = 思考吃光预算，最典型的形态
      lastReason = content.trim() ? 'parse' : 'empty'
      lastDetail = `finish=${finishReason ?? '-'} thinking=${reasoningLen}字 内容=${snippet(content)}`

      const truncated = finishReason === 'length'
      const empty = !content.trim()
      if (attempt === 0 && (truncated || empty) && budget < RETRY_MAX_TOKENS) {
        console.warn('[sprite-annotate] 预算不足，提到 %d 重试 file=%s（%s）', RETRY_MAX_TOKENS, filePath, lastDetail)
        budget = RETRY_MAX_TOKENS
        continue
      }
      return fail(lastReason, lastDetail)
    }
    return fail(lastReason, lastDetail)
  } catch (err) {
    return fail('http', err instanceof Error ? err.message : String(err))
  }
}

/**
 * 对整个立绘集打标：逐张（并发 2）调用视觉模型，收集建议。
 * @param spriteId 立绘集 id（校验存在性；图片列表以索引记录为准）
 * @param opts.skipImages 已有状态词的图片（渲染端按当前草稿传入），这些图不再请求模型
 */
export async function annotateSpriteSet(
  spriteId: string,
  opts: { skipImages?: string[] } = {},
): Promise<SpriteAnnotationResult> {
  const cfg = await resolveVisionConfig()
  if (!cfg) {
    return { ok: false, error: '未配置视觉模型（设置 → 屏幕感知 视觉模型），无法自动打标；可在词表编辑器手动添加状态词' }
  }
  const spr = (await listSprites()).find((s) => s.id === spriteId)
  if (!spr) return { ok: false, error: '立绘集不存在' }
  if (spr.images.length === 0) return { ok: false, error: '立绘集内没有图片' }

  const skip = new Set((opts.skipImages ?? []).filter(Boolean))
  const targets = spr.images.filter((img) => !skip.has(img.filePath))
  const skipped = spr.images.length - targets.length
  if (targets.length === 0) {
    return { ok: true, suggestions: [], failed: 0, skipped }
  }

  const dir = paths.spriteDir(spriteId)
  const suggestions: SpriteAnnotationSuggestion[] = []
  let failed = 0
  // 并发 2 的分批串行：平衡耗时与限流风险
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY)
    const results = await Promise.all(
      batch.map(async (img) => {
        const abs = path.join(dir, img.filePath)
        return annotateOne(abs, img.filePath, cfg)
      }),
    )
    for (let j = 0; j < batch.length; j++) {
      const r = results[j]
      if (r) suggestions.push(r)
      else failed++
    }
  }
  if (suggestions.length === 0) {
    return { ok: false, failed, skipped, error: `打标失败：${failed} 张全部失败，请检查视觉模型配置（日志里有每张的原因）` }
  }

  /**
   * 同批去重：视觉模型逐张看图、看不到别的图，会给相似的立绘相同的标签。
   * 两个编号文字完全一样时模型只能瞎猜（等于浪费编号），所以只保留第一张，
   * 其余留空由用户手填——比让用户面对一堆重复标签去手动清理省事。
   */
  const seen = new Set<string>()
  const unique: SpriteAnnotationSuggestion[] = []
  let duplicated = 0
  for (const item of suggestions) {
    if (seen.has(item.name)) {
      duplicated++
      continue
    }
    seen.add(item.name)
    unique.push(item)
  }

  console.log(
    '[sprite-annotate] 完成：%s（成功 %d 张 / 失败 %d 张 / 跳过 %d 张 / 重复 %d 张）',
    spriteId,
    unique.length,
    failed,
    skipped,
    duplicated,
  )
  return { ok: true, suggestions: unique, failed, skipped, duplicated }
}
