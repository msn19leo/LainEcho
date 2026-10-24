/**
 * 立绘视觉打标：对立绘集逐张图片调用视觉模型，生成"状态词 + 描述"建议。
 *
 * - 配置复用屏幕感知的视觉模型档案（档案制：激活档案提供地址/模型/Key），不回退主 LLM；
 * - 产物不落库（与 personaGenerator 同一口径）：建议返回给渲染端，由词表编辑器确认后经 sprite:update 保存；
 * - 容错：单张失败跳过计数（failed），不阻塞整批；未配置视觉模型直接返回 ok:false。
 */
import { promises as fs } from 'fs'
import path from 'path'
import { normalizeBaseURL } from './aiClient'
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
/** 单张打标输出 token 上限（一行 JSON） */
const MAX_TOKENS = 200
/** 单张请求超时（毫秒） */
const REQUEST_TIMEOUT_MS = 60_000
/** 状态词长度上限（视觉模型偶发输出长句，截断保护） */
const WORD_MAX = 6
/** 描述长度上限 */
const DESC_MAX = 40

/** 单张打标建议 */
export interface SpriteAnnotationSuggestion {
  /** 图片文件名（相对 sprites/{id}/） */
  filePath: string
  /** 建议状态词（2-6 字中文为宜） */
  name: string
  /** 一句描述（表情/姿态/氛围，注入 prompt 释义用） */
  desc: string
}

/** 打标结果：suggestions 成功项 + failed 失败张数（任一失败不阻塞整批） */
export interface SpriteAnnotationResult {
  ok: boolean
  suggestions?: SpriteAnnotationSuggestion[]
  failed?: number
  error?: string
}

/** 打标 prompt：要求只输出一行 JSON，词面向"演出状态"而非画面内容（状态词或姿态/行为词均可）；
 *  释义必须剥离画面环境（背景/地点/道具是拍摄场景不代表使用条件），落到通用对话时机 */
const ANNOTATE_PROMPT =
  '你是 galgame 立绘标注助手。请看这张角色立绘，输出一行 JSON（不要任何其他文字、不要 markdown 代码块）：\n' +
  '{"word":"<2到4个中文字的演出关键词：情绪词如 得意/委屈/傲娇/平静，或姿态/行为词如 解释/警告/沉思>","desc":"<10到25字，描述这张立绘适合的对话场面（何时会做出这个表情/动作），如 听到意外消息时的震惊；不要罗列外观细节>"}\n' +
  '要求：\n' +
  '1. word 面向演出状态（什么时候用这张图），情绪与姿态/行为均可；\n' +
  '2. 忽略画面中的背景/地点/道具/其他人物——那是拍摄场景，不代表这张立绘的使用条件；\n' +
  '3. desc 格式："<表情/肢体动作传达的状态>，<通用对话时机>时"；对话时机必须是通用情境（被夸奖时/要解释什么时/困得睁不开眼时），禁止出现具体地点（餐厅/教室/房间）、具体物品（菜品/游戏机）、具体事件（迎接客人）。\n' +
  '示例：✗ 错误"双手摊开迎接客人，在餐厅里热情介绍新菜品时使用"（绑定了画面场景）；✓ 正确"张开双臂热情洋溢，介绍或展示什么的时候"；✓ 正确"鼓起脸颊闹别扭似的生气，被惹毛时"。'

/**
 * 提取模型回复中的 JSON 对象（首个 { 到末个 }），宽松解析 word/desc 字段。
 * @returns 解析出的建议；无法解析时返回 null（由调用方跳过该张）
 */
function parseAnnotationReply(text: string, filePath: string): SpriteAnnotationSuggestion | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as { word?: unknown; desc?: unknown }
    const word = String(obj.word ?? '').trim().replace(/["'"]/g, '').slice(0, WORD_MAX)
    const desc = String(obj.desc ?? '').trim().slice(0, DESC_MAX)
    if (!word) return null
    return { filePath, name: word, desc }
  } catch {
    return null
  }
}

/**
 * 单张打标：读图 → base64 data URL → OpenAI 兼容 chat/completions（image_url）。
 * @returns 建议；配置缺失/网络失败/解析失败返回 null
 */
async function annotateOne(absPath: string, filePath: string, cfg: { baseURL: string; apiKey: string; model: string }): Promise<SpriteAnnotationSuggestion | null> {
  try {
    const ext = path.extname(absPath).toLowerCase()
    const mime = MIME_BY_EXT[ext]
    if (!mime) return null
    const buf = await fs.readFile(absPath)
    // 体积保护：>6MB 的图跳过（罕见，通常是误导入的非立绘大图）
    if (buf.byteLength > 6 * 1024 * 1024) return null
    const url = `${normalizeBaseURL(cfg.baseURL)}/chat/completions`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: ANNOTATE_PROMPT },
              { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } },
            ],
          },
        ],
        max_tokens: MAX_TOKENS,
        temperature: 0.3,
        stream: false,
      }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.warn('[sprite-annotate] 视觉模型请求失败（HTTP %d）：%s', res.status, body.slice(0, 300))
      return null
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const content = data.choices?.[0]?.message?.content ?? ''
    return parseAnnotationReply(String(content), filePath)
  } catch (err) {
    console.warn('[sprite-annotate] 单张打标失败（跳过）：%s', err instanceof Error ? err.message : String(err))
    return null
  }
}

/**
 * 对整个立绘集打标：逐张（并发 2）调用视觉模型，收集建议。
 * @param spriteId 立绘集 id（校验存在性；图片列表以索引记录为准）
 */
export async function annotateSpriteSet(spriteId: string): Promise<SpriteAnnotationResult> {
  const cfg = await resolveVisionConfig()
  if (!cfg) {
    return { ok: false, error: '未配置视觉模型（设置 → 屏幕感知 视觉模型），无法自动打标；可在词表编辑器手动添加状态词' }
  }
  const spr = (await listSprites()).find((s) => s.id === spriteId)
  if (!spr) return { ok: false, error: '立绘集不存在' }
  if (spr.images.length === 0) return { ok: false, error: '立绘集内没有图片' }

  const dir = paths.spriteDir(spriteId)
  const suggestions: SpriteAnnotationSuggestion[] = []
  let failed = 0
  // 并发 2 的分批串行：平衡耗时与限流风险
  for (let i = 0; i < spr.images.length; i += CONCURRENCY) {
    const batch = spr.images.slice(i, i + CONCURRENCY)
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
    return { ok: false, failed, error: '所有图片打标均失败，请检查视觉模型配置或网络' }
  }
  console.log('[sprite-annotate] 完成：%s（成功 %d 张 / 失败 %d 张）', spriteId, suggestions.length, failed)
  return { ok: true, suggestions, failed }
}
