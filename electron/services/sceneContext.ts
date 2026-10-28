/**
 * 情境服务（Phase 1）：聚合"此刻"的多源信号 → 【当前情景】Section + 对话层场景摘要缓存。
 *
 * 解决的问题：上下文里只有"过去"（角色卡/记忆/历史），没有"此刻"——长会话（13k+ tokens）
 * 中模型对当前场景状态的注意力衰减，旁白/台词混入旧场景元素（位置/姿势/活动错位）。
 *
 * 数据源分层：
 * - 系统层（本模块实时计算）：powerMonitor.getSystemIdleTime()（Electron 内置零依赖）→
 *   用户活跃/空闲；前台应用名由 perception/foreground 提供（L0，仅窗口标题，不截图）
 * - 对话层（sceneDigest）：每会话缓存的场景状态摘要，turn done 后由辅助模型异步增量更新
 *   （UNCHANGED 短路；失败保留旧值；未配置辅助模型回落主对话模型）
 *
 * 注入点：repository.buildSystemPrompt 的【当前情景】Section（组装层拼接，金样零影响）。
 * 剧情轮次不参与（story run 有自己的 directive/场景管理）。
 * 后续扩展位：屏幕识别更新"活动"字段（Phase 3）、天气（环境层）——本模块是它们的宿主。
 */
import { powerMonitor } from 'electron'
import { sendChatCompletion } from './aiClient'
import { resolveAuxLlmConfig } from './auxModel'
import type { ResolvedLlmConfig } from './apiProfiles'
import { updateSessionSceneDigest } from './repository'
import type { AppSettings, CharacterPersona, ChatMessage } from '../../src/types'

/** 摘要长度上限（防御性截断）：正常输出 ≤120 字，超长说明模型跑偏 */
const DIGEST_MAX_CHARS = 400
/** 编辑重发重建时纳入的最近消息条数（约 6 轮）；更早的状态由旧摘要携带 */
const REWIND_RECENT_MESSAGES = 12
/** 重建输入字符上限（防御超长消息把辅助模型上下文打满） */
const REWIND_MAX_INPUT_CHARS = 6000
/** 重建硬超时：主进程最多等这么久，超时清空摘要继续重跑 */
const REWIND_TIMEOUT_MS = 2500

/** 按小时返回时段描述（摘要更新 prompt 的"当前时间"锚，防模型照抄示例/旧时间） */
function dayPart(hour: number): string {
  if (hour >= 5 && hour < 8) return '清晨'
  if (hour >= 8 && hour < 11) return '上午'
  if (hour >= 11 && hour < 13) return '中午'
  if (hour >= 13 && hour < 17) return '下午'
  if (hour >= 17 && hour < 19) return '傍晚'
  if (hour >= 19 && hour < 23) return '晚上'
  return '深夜'
}

/** 当前本地时间的摘要用文本：`2026-10-19 14:30（下午）` */
function formatNow(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}（${dayPart(d.getHours())}）`
}

/**
 * 角色速写（摘要更新的"人设锚"）：抽取角色卡中与动作/情绪风格相关的字段
 * （存在锚点 / 情绪处理 / 日常状态 / 特殊语言行为），供辅助模型转述"角色状态/动作"时
 * 保持角色特有动作特征（种族特征/习惯性动作），不泛化为通用动作。空卡返回空串。
 */
export function buildCharacterBrief(card: { name: string; persona: CharacterPersona } | null | undefined): string {
  if (!card) return ''
  const p = card.persona
  const parts = [
    p.anchor?.trim(),
    p.perception?.emotion?.trim() && `情绪表达：${p.perception.emotion.trim()}`,
    p.state?.daily?.trim() && `日常状态：${p.state.daily.trim()}`,
    p.language?.habits?.trim() && `语言/动作习惯：${p.language.habits.trim()}`,
  ].filter((v): v is string => !!v)
  const brief = parts.join('；')
  return brief ? `${card.name}：${brief}`.slice(0, 240) : ''
}

/** 用户设备状态行（系统层）：空闲 <90s 视为正在使用 */
function deviceActivityLine(): string {
  try {
    const idleSec = powerMonitor.getSystemIdleTime()
    if (idleSec < 90) return '用户正在使用电脑'
    if (idleSec < 3600) return `用户已离开电脑约 ${Math.max(1, Math.round(idleSec / 60))} 分钟`
    const h = Math.floor(idleSec / 3600)
    const m = Math.round((idleSec % 3600) / 60)
    return `用户已离开电脑约 ${h} 小时${m > 0 ? ` ${m} 分钟` : ''}`
  } catch {
    // powerMonitor 不可用（极端环境）→ 系统层缺席，其余层照常
    return ''
  }
}

/**
 * 组装【当前情景】Section。
 * @param digest 会话的场景摘要缓存（对话层；空 = 尚未建立，跳过该层）
 * @param opts.activity 用户当前正在使用的应用（L0 前台窗口标题；null/空 = 不注入）
 * @param opts.isStory 剧情轮次：**函数内直接拒绝**
 * @returns Section 文本；无任何可注入内容时返回空串（调用方不注入）
 */
export function buildSceneSection(
  digest: string | null | undefined,
  opts: { activity?: string | null; isStory?: boolean } = {},
): string {
  // 剧情演出有自己的导演指令与场景管理。屏幕活动是"现实此刻"的信息，
  // 漏进剧情会出现"中世纪酒馆里角色点评你的 VS Code"这类破戏。
  // 这里做函数内拒绝而不是依赖调用方判断：调用侧的 !store 是隐式契约，重构时最容易丢。
  if (opts.isStory) return ''

  const lines: string[] = []
  const device = deviceActivityLine()
  if (device) lines.push(`- ${device}。`)
  const activity = opts.activity?.trim()
  if (activity) lines.push(`- 用户当前正在使用的应用窗口：${activity}。`)
  const d = digest?.trim()
  if (d) for (const line of d.split('\n')) if (line.trim()) lines.push(`- ${line.trim().replace(/^-\s*/, '')}。`)
  if (lines.length === 0) return ''
  return [
    '【当前情景】',
    '以下为此刻的真实情境，旁白与台词必须与它保持一致。',
    '历史对话中出现的天气/光线/时段等环境描写可能已过时，不得复用——环境意象必须与本节及当前真实时间一致：',
    ...lines,
  ].join('\n')
}

/**
 * turn done 后异步更新场景摘要（fire-and-forget）：
 * 辅助模型（未配置回落主对话模型）根据"旧摘要 + 本轮对话"产出新摘要并落盘；
 * 场景无变化（UNCHANGED）或更新失败时保留旧值。不阻塞、不影响首响。
 */
export async function updateSceneDigestAfterTurn(params: {
  sessionId: string
  prevDigest: string | null | undefined
  userText: string
  assistantText: string
  /** 角色速写（buildCharacterBrief 产物）：辅助模型转述"角色状态/动作"的人设锚，空串 = 无 */
  characterBrief?: string | null
  settings: AppSettings
  /** 主模型激活档案解析出的生效三元组（辅助未启用时回落使用） */
  mainCfg: ResolvedLlmConfig
  /** 本轮落盘后的情景代际与消息数：写入前校验，防止 rewind 后旧轮覆盖 */
  expectedSceneEpoch?: number
  atMessageCount?: number
}): Promise<void> {
  const { sessionId, prevDigest, userText, assistantText, characterBrief, settings, mainCfg, expectedSceneEpoch, atMessageCount } = params
  if (!settings.enableSceneDigest) return
  const prev = prevDigest?.trim() ?? ''
  try {
    // 辅助模型（未激活档案回落主模型档案）：机械型小任务，快速小模型足够
    const aux = await resolveAuxLlmConfig()
    const model = (aux?.model ?? mainCfg.model).trim()
    const baseURL = (aux?.baseURL ?? mainCfg.baseURL).trim()
    const key = aux?.apiKey || mainCfg.apiKey
    if (!baseURL || !model || !key) return
    const system = [
      '你是场景状态记录员。根据"旧摘要"和"本轮对话"，输出更新后的当前情景摘要。',
      '规则：',
      '- 只保留此刻仍然有效的状态；已被新动作取代的旧状态必须更新',
      '- 只描述对话中明确支持的内容，不确定的不要编造',
      '- 「角色状态/动作」必须符合"角色设定"与本轮对话中角色的实际表现，保留角色的特有动作特征（种族特征/习惯性动作），不得泛化为通用动作',
      '- 不超过 120 字，逐行输出（每行一条）：用户状态/活动：…｜角色状态/动作：…｜场景与氛围：…',
      '- 「场景与氛围」的时段与光线必须按【当前时间】推断（白天=自然光、夜晚=灯光等），禁止输出与当前时间不符的时段或光线；对话中提到的旧时间（如早些时候说过"下午"）不作为当前时段依据',
      prev ? '- "旧摘要"中仍然有效的行可以保留' : '',
      '- 若场景没有任何变化，只输出 UNCHANGED',
    ]
      .filter(Boolean)
      .join('\n')
    const user = [
      `【当前时间】${formatNow()}`,
      characterBrief?.trim() ? `【角色设定】\n${characterBrief.trim()}` : '',
      prev ? `【旧摘要】\n${prev}` : '【旧摘要】\n（无，这是第一条摘要）',
      `【本轮对话】\n用户：${userText}\n角色：${assistantText}`,
    ]
      .filter(Boolean)
      .join('\n\n')
    const out = await sendChatCompletion(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      {
        model,
        baseURL,
        apiKey: key,
        stream: false,
        maxTokensOverride: 300,
        temperature: 0.2,
        signal: AbortSignal.timeout(45000),
      },
    )
    const text = (out ?? '').trim()
    if (!text || text === prev) return
    if (/^UNCHANGED$/i.test(text)) return
    await updateSessionSceneDigest(sessionId, text.slice(0, DIGEST_MAX_CHARS), {
      expectedSceneEpoch,
      atMessageCount,
    })
  } catch (err) {
    // 摘要更新失败保留旧值（缓存语义），不影响对话链路
    console.warn('[scene] 情景摘要更新失败（保留旧值）：', err instanceof Error ? err.message : String(err))
  }
}

/** 重建输入用的消息时刻（M-D HH:mm，与 A2 摘要时间线同口径） */
function formatMessageTs(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 截断后最近 N 条消息拼成重建输入（从尾部取，超字符上限即停） */
function buildRewindDialogue(messages: ChatMessage[]): string {
  const lines: string[] = []
  let chars = 0
  const MAX_LINE_CHARS = 2000
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue
    const label = m.role === 'user' ? (m.meta?.proactive ? '旁白' : '用户') : '角色'
    const ts = typeof m.timestamp === 'number' && m.timestamp > 0 ? `[${formatMessageTs(m.timestamp)}] ` : ''
    const raw = m.content ?? ''
    // 单条超长消息取尾部（最近的内容更重要），避免把辅助模型上下文打满
    const body = raw.length > MAX_LINE_CHARS ? `…${raw.slice(-MAX_LINE_CHARS)}` : raw
    const line = `${ts}${label}：${body}`
    if (chars + line.length > REWIND_MAX_INPUT_CHARS) {
      if (lines.length === 0) lines.unshift(line.slice(-REWIND_MAX_INPUT_CHARS))
      break
    }
    lines.unshift(line)
    chars += line.length
    if (lines.length >= REWIND_RECENT_MESSAGES) break
  }
  return lines.join('\n')
}

/**
 * 编辑重发后的情景摘要重建：以"截断后仍存活的历史"为准，旧摘要只作长期场景的参考。
 *
 * 为什么不是回滚摘要快照：旧会话没有逐轮摘要历史，且恢复出来的旧摘要会带着旧时段/光线，
 * 与【当前真实时间】冲突。重建能用当前时间刷新场景，并兼容所有存量会话。
 *
 * 输入只取截断点之前的最近 12 条（不含被编辑的新文本——它还没有发送）；旧摘要负责携带
 * 更早的地点/关系状态，尾段负责纠正被删后续造成的变化。
 * 任何失败/超时返回 null，由调用方清空摘要后继续重跑（缓存语义，不阻塞对话）。
 */
export async function rebuildSceneDigestAfterRewind(params: {
  sessionId: string
  survivingMessages: ChatMessage[]
  previousDigest?: string | null
  characterBrief?: string | null
  settings: AppSettings
  mainCfg: ResolvedLlmConfig
  signal?: AbortSignal
}): Promise<string | null> {
  const { sessionId, survivingMessages, previousDigest, characterBrief, settings, mainCfg, signal } = params
  if (!settings.enableSceneDigest) return null
  const dialogue = buildRewindDialogue(survivingMessages)
  if (!dialogue.trim()) return null

  const prev = previousDigest?.trim() ?? ''
  const aux = await resolveAuxLlmConfig()
  const model = (aux?.model ?? mainCfg.model).trim()
  const baseURL = (aux?.baseURL ?? mainCfg.baseURL).trim()
  const key = aux?.apiKey || mainCfg.apiKey
  if (!baseURL || !model || !key) return null

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REWIND_TIMEOUT_MS)
  const onAbort = () => controller.abort()
  if (signal?.aborted) controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const system = [
      '你是场景状态记录员。用户编辑了较早的一条消息并重发，后续对话已被删除；请根据"截断后仍存在的最近对话"重建"此刻"的情景摘要。',
      '规则：',
      '- 以【截断后的最近对话】为准；【旧摘要】可能包含已被删除的后续对话，仅作参考，冲突时必须丢弃。',
      '- 只保留截断后对话明确支持的状态；只由已删除后续产生的动作、事件、约定不得保留。',
      '- 不要预测、引用或提及尚未发送的新消息。',
      '- 「场景与氛围」的时段与光线必须按【当前时间】推断（白天=自然光、夜晚=灯光等），禁止输出与当前时间不符的时段或光线；若截断后对话与当前时间间隔较大，不要强行延续旧地点/旧活动，按当前时间与常理重置。',
      '- 不超过 120 字，逐行输出（每行一条）：用户状态/活动：…｜角色状态/动作：…｜场景与氛围：…。',
      '- 信息不足时输出空字符串；不要输出 UNCHANGED。',
    ].join('\n')
    const user = [
      `【当前时间】${formatNow()}`,
      characterBrief?.trim() ? `【角色设定】\n${characterBrief.trim()}` : '',
      prev ? `【旧摘要】（可能包含已删除的后续，仅作参考）\n${prev}` : '【旧摘要】\n（无）',
      `【截断后的最近对话】\n${dialogue}`,
    ]
      .filter(Boolean)
      .join('\n\n')

    const out = await sendChatCompletion(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      {
        model,
        baseURL,
        apiKey: key,
        temperature: 0.2,
        stream: false,
        maxTokensOverride: 300,
        signal: controller.signal,
      },
    )
    const text = (out ?? '').trim()
    if (!text || /^UNCHANGED$/i.test(text)) {
      console.log('[scene] rewind 重建无有效输出，将清空摘要')
      return null
    }
    return text.slice(0, DIGEST_MAX_CHARS)
  } catch (err) {
    console.warn(
      '[scene] rewind 重建失败/超时（将清空摘要）：',
      err instanceof Error ? err.message : String(err),
      `session=${sessionId}`,
    )
    return null
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}
