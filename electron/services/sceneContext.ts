/**
 * 情境服务（Phase 1）：聚合"此刻"的多源信号 → 【当前情景】Section + 对话层场景摘要缓存。
 *
 * 解决的问题：上下文里只有"过去"（角色卡/记忆/历史），没有"此刻"——长会话（13k+ tokens）
 * 中模型对当前场景状态的注意力衰减，旁白/台词混入旧场景元素（位置/姿势/活动错位）。
 *
 * 数据源分层：
 * - 系统层（本模块实时计算）：powerMonitor.getSystemIdleTime()（Electron 内置零依赖）→
 *   用户活跃/空闲——前台应用名无内置 API，留待屏幕识别（Phase 3）
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
import type { AppSettings, CharacterPersona } from '../../src/types'

/** 摘要长度上限（防御性截断）：正常输出 ≤120 字，超长说明模型跑偏 */
const DIGEST_MAX_CHARS = 400

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
 * @returns Section 文本；无任何可注入内容时返回空串（调用方不注入）
 */
export function buildSceneSection(digest: string | null | undefined): string {
  const lines: string[] = []
  const device = deviceActivityLine()
  if (device) lines.push(`- ${device}。`)
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
}): Promise<void> {
  const { sessionId, prevDigest, userText, assistantText, characterBrief, settings, mainCfg } = params
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
    await updateSessionSceneDigest(sessionId, text.slice(0, DIGEST_MAX_CHARS))
  } catch (err) {
    // 摘要更新失败保留旧值（缓存语义），不影响对话链路
    console.warn('[scene] 情景摘要更新失败（保留旧值）：', err instanceof Error ? err.message : String(err))
  }
}
