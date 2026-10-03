/**
 * 剧情记忆沉淀：把剧情演出经历沉淀为陪伴长期记忆（戏内延续）。
 *
 * - 触发点：章节切换 / 剧情完结（引擎钩子 fire-and-forget，受「自动沉淀记忆」开关控制）+
 *   剧情窗完结屏手动兜底按钮（绕过开关，始终执行）；
 * - 素材：run.memoryCursor 游标起的 run.messages 切片（= 一章，或此前沉淀失败累积的切片），
 *   输入上限 8000 字符（保留开头场景铺垫 + 结尾重点）；
 * - 产出：单条章节摘要（long_term / promises）写入待确认候选——用户在记忆面板
 *   审核编辑并「保留」后才注入 system prompt，与对话沉淀的审核流一致；
 * - 口径：第三人称档案体（「用户」/「{角色名}」）+ 戏内延续（摘要写"真实共同经历的
 *   事件"，禁止 剧情/剧本/游戏/章节/演出 等元叙事词汇）；
 * - 游标只在沉淀成功后推进；失败游标原地（下次章节切换/完结/手动按钮重试，
 *   去重管线保证不产生重复条目）；
 * - 复用对话沉淀的去重与人称归一管线（memoryExtraction）；任何失败返回结果不 throw，
 *   绝不阻塞演出循环。
 */
import type { ChatMessage, MemoryCategory, StoryConsolidateResult } from '../../../src/types'
import { sendChatCompletion } from '../aiClient'
import { readApiKey } from '../crypto'
import { resolveEmbeddingConfig, syncMemoryVectors } from '../memory/memoryVectors'
import {
  addPendingMemory,
  getCharacterCard,
  getSettings,
  listMemories,
} from '../repository'
import { isDuplicate, normalizePerspective, semanticDedup } from '../memoryExtraction'
import { windowManager } from '../../windows/windowManager'
import { getRun, updateRunMemoryCursor } from './runs'
import { loadScript } from './loader'

/** 单次沉淀素材输入上限（字符）：超长时保留开头铺垫 + 结尾重点 */
const MAX_MATERIAL_CHARS = 8000
/** 超长截断时保留的开头字符数（场景铺垫） */
const MATERIAL_HEAD_CHARS = 1500
/** 沉淀请求输出 token 上限（独立请求，给思考型模型 reasoning 留空间） */
const CONSOLIDATE_MAX_TOKENS = 2048
/** 摘要最小有效长度：低于此视为模型输出无效（按失败处理，游标不动） */
const MIN_SUMMARY_LEN = 10

/** 沉淀进行中的 run 集合：同一 run 串行沉淀，重复触发直接忽略 */
const inFlight = new Set<string>()

/**
 * 沉淀 prompt：独立上下文，与对话抽取（memoryExtraction）及主对话的输出契约完全隔离。
 * 单条摘要产出（category 二选一 + content），戏内延续口径在此约束。
 */
function buildConsolidateSystemPrompt(cardName: string, scriptTitle: string): string {
  return (
    '你是一个严格的剧情经历整理者。下面是「用户」与「' +
    cardName +
    '」共同经历的一段旅程的记录，请从中提炼一条最值得长期记住的经历摘要。\n' +
    '只输出 JSON 本体（不要 markdown 代码块、不要任何解释）：{"category":"long_term","content":"..."}\n' +
    '- 表述视角必须统一为第三人称档案体：用户一律称「用户」；角色一律用「' +
    cardName +
    '」指代；严禁使用「我/你/对方/AI」等任何人称代词或标签词作主语。\n' +
    '- 戏内延续：这段经历在你们的世界里是真实发生过的事。严禁出现「剧情/剧本/游戏/章节/演出/玩家/选项」等元叙事词汇，' +
    '不要写「在剧情中」之类表述，直接陈述事件本身。例：写「用户与' +
    cardName +
    '在海堤上躲避追兵，' +
    cardName +
    '为用户挡下一击」，而非「在剧情中他们…」。\n' +
    '- 内容选择：重要事件、关键抉择及其后果、情感浓度高的时刻、达成的约定；忽略纯场景过渡、寒暄与琐碎对话。\n' +
    '- category 规则：若经历中存在"旅程结束后仍然有效"的明确约定（答应做的事/时间地点），category 用 "promises" 并把约定内容写清楚；否则用 "long_term"。\n' +
    '- 篇幅 80~200 字，可用「；」分隔多个要点，把每件事讲清楚。若确实没有任何值得长期记住的内容，输出 {"category":"long_term","content":""}。\n' +
    '（本段经历出自「' +
    scriptTitle +
    '」，仅作定位参考，严禁把该名称或任何出处信息写进摘要）'
  )
}

/**
 * 把消息切片整理为沉淀素材文本：旁白行标「旁白」、玩家台词/选项标「用户」、角色台词标「{角色名}」。
 * 过滤引擎内部导演指令（「（剧情演出：…）」包装的 user 消息）与空文本。
 */
function formatMaterial(messages: ChatMessage[], cardName: string): string {
  const lines: string[] = []
  for (const m of messages) {
    const text = (m.content ?? '').trim()
    if (!text || text.startsWith('（剧情演出：')) continue
    if (m.meta?.storyKind === 'narration') lines.push(`旁白: ${text}`)
    else if (m.role === 'user') lines.push(`用户: ${text}`)
    else lines.push(`${cardName}: ${text}`)
  }
  return lines.join('\n')
}

/** 素材超上限时截断：保留开头（场景铺垫）+ 结尾（重点/结局），中段以省略标记代替 */
function truncateMaterial(text: string): string {
  if (text.length <= MAX_MATERIAL_CHARS) return text
  const head = text.slice(0, MATERIAL_HEAD_CHARS)
  const tail = text.slice(-(MAX_MATERIAL_CHARS - MATERIAL_HEAD_CHARS))
  return `${head}\n……（中段较长内容省略）……\n${tail}`
}

/**
 * 解析沉淀结果 JSON（容忍 markdown 围栏与前后杂文本）。
 * @returns content 非空 → 摘要；content 为空串 → 模型判定无值得记住的内容；解析失败 → null
 */
function parseConsolidation(raw: string): { category: MemoryCategory; content: string } | { empty: true } | null {
  const block = raw.replace(/```json\s*/gi, '').replace(/```/g, '')
  const start = block.indexOf('{')
  const end = block.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(block.slice(start, end + 1)) as { category?: string; content?: string }
    if (typeof parsed?.content !== 'string') return null
    const content = parsed.content.trim()
    if (!content) return { empty: true }
    if (content.length < MIN_SUMMARY_LEN) return null
    return { category: parsed.category === 'promises' ? 'promises' : 'long_term', content }
  } catch {
    return null
  }
}

/**
 * 沉淀剧情记忆：从 run.memoryCursor 起的消息切片提取一条记忆摘要写入待确认候选，
 * 成功后推进游标。引擎钩子可 fire-and-forget（void 调用），手动按钮可 await 结果做提示。
 * @param opts.manual 手动触发（剧情窗完结屏按钮）：绕过「自动沉淀记忆」开关——
 *                    自动钩子在开关关闭时跳过且游标不推进（重新打开后下次触发可补沉淀），
 *                    手动是明确意图，始终执行
 * @returns 沉淀结果（永不 throw；错误信息在 error 字段）
 */
export async function consolidateStoryMemory(runId: string, opts?: { manual?: boolean }): Promise<StoryConsolidateResult> {
  if (inFlight.has(runId)) {
    return { ok: false, error: '该存档的上一次沉淀仍在进行中，请稍后再试' }
  }
  inFlight.add(runId)
  try {
    const settings = await getSettings()
    // 自动沉淀受「自动沉淀记忆」开关控制：关闭 → 跳过且游标不推进，不丢内容
    if (!opts?.manual && !settings.enableMemoryExtraction) {
      console.log('[story-memory] 自动沉淀记忆已关闭，跳过沉淀（run %s，游标未推进）', runId)
      return { ok: false, error: '自动沉淀记忆已关闭' }
    }

    const run = await getRun(runId)
    if (!run) return { ok: false, error: '剧情存档不存在' }
    const cursor = Math.max(0, run.memoryCursor ?? 0)
    const slice = run.messages.slice(cursor)
    if (slice.length === 0) return { ok: true, nothing: true }

    // API Key 加密存取（与主对话/画像整理同源；缺失时提示但不阻塞演出）
    const apiKey = await readApiKey()
    if (!apiKey) return { ok: false, error: '未配置 API Key，无法沉淀记忆' }
    const card = await getCharacterCard(run.cardId)
    const cardName = card?.name?.trim() || '角色'

    // 素材：过滤导演指令 → 视角格式化 → 上限截断；切片无有效内容时直接推进游标避免反复空跑
    const material = truncateMaterial(formatMaterial(slice, cardName))
    if (!material.trim()) {
      await updateRunMemoryCursor(runId, run.messages.length)
      return { ok: true, nothing: true }
    }

    // 剧本名仅作 prompt 定位参考（剧本已删除/加载失败时回退 scriptId，不阻塞）
    let scriptTitle = run.scriptId
    try {
      const bundle = await loadScript(run.scriptId)
      if (bundle.meta.title) scriptTitle = bundle.meta.title
    } catch {
      /* 回退 scriptId */
    }

    const raw = await sendChatCompletion(
      [
        { role: 'system', content: buildConsolidateSystemPrompt(cardName, scriptTitle) },
        { role: 'user', content: `以下是这段经历的记录：\n${material}\n\n请整理记忆：` },
      ],
      {
        model: settings.model,
        baseURL: settings.baseURL,
        apiKey,
        temperature: 0.2,
        stream: false,
        maxTokensOverride: CONSOLIDATE_MAX_TOKENS,
      },
    )
    const parsed = parseConsolidation(raw)
    if (!parsed) {
      // 模型无有效输出（JSON 解析失败/摘要过短/content 被思考预算占空）：游标不动，可重试
      console.log(
        '[story-memory] 沉淀无有效摘要 model=%s 素材 %d 字符，原始返回（前 300 字符）：%s',
        settings.model,
        material.length,
        (raw ?? '').trim().slice(0, 300),
      )
      return { ok: false, error: '模型没有返回有效摘要，可稍后重试' }
    }
    if ('empty' in parsed) {
      // 模型判定整段无值得长期记住的内容：推进游标，不再重跑
      await updateRunMemoryCursor(runId, run.messages.length)
      console.log('[story-memory] 切片无值得沉淀的内容（run %s，%d 条消息）', runId, slice.length)
      return { ok: true, nothing: true }
    }

    // 归一 + 去重：第三人称档案体 → 字符串去重（全部记忆）→ 语义去重（同角色/全局，嵌入可用时）
    const content = normalizePerspective(parsed.content, cardName)
    if (isDuplicate(content, (await listMemories()).map((m) => m.content))) {
      await updateRunMemoryCursor(runId, run.messages.length)
      return { ok: true, nothing: true }
    }
    let fresh: Array<{ category: MemoryCategory; content: string }> = [{ category: parsed.category, content }]
    const embedCfg = await resolveEmbeddingConfig()
    if (embedCfg) {
      const scoped = (await listMemories()).filter(
        (m) => m.characterCardId === run.cardId || m.characterCardId === null,
      )
      fresh = await semanticDedup(fresh, scoped, embedCfg, settings.memoryDedupThreshold)
      if (fresh.length === 0) {
        await updateRunMemoryCursor(runId, run.messages.length)
        console.log('[story-memory] 摘要被语义去重拦截（run %s）', runId)
        return { ok: true, nothing: true }
      }
    }

    // 写入待确认候选（origin='story' 标记来源；确认前不注入），成功后推进游标
    const written = await addPendingMemory({
      content: fresh[0]!.content,
      category: fresh[0]!.category,
      characterCardId: run.cardId,
      sourceSessionId: runId,
      origin: 'story',
    })
    await updateRunMemoryCursor(runId, run.messages.length)
    windowManager.broadcast('memory:changed')
    void syncMemoryVectors([written])
    console.log('[story-memory] 剧情记忆已沉淀（run %s，素材 %d 条消息）：%s', runId, slice.length, fresh[0]!.content.slice(0, 60))
    return { ok: true, written: 1 }
  } catch (err) {
    // 沉淀失败游标原地：下次章节切换/完结/手动按钮会带上本段重试（去重管线防重复）
    console.warn('[story-memory] 沉淀失败（游标未推进，可重试）：', err instanceof Error ? err.message : err)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    inFlight.delete(runId)
  }
}
