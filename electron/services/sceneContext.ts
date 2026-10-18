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
import { updateSessionSceneDigest } from './repository'
import type { AppSettings } from '../../src/types'

/** 摘要长度上限（防御性截断）：正常输出 ≤120 字，超长说明模型跑偏 */
const DIGEST_MAX_CHARS = 400

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
  settings: AppSettings
  apiKey: string
}): Promise<void> {
  const { sessionId, prevDigest, userText, assistantText, settings, apiKey } = params
  if (!settings.enableSceneDigest) return
  const prev = prevDigest?.trim() ?? ''
  try {
    // 辅助模型（未配置回落主对话模型）：机械型小任务，快速小模型足够
    const aux = await resolveAuxLlmConfig()
    const model = (aux?.model ?? settings.model).trim()
    const baseURL = (aux?.baseURL ?? settings.baseURL).trim()
    const key = aux?.apiKey || apiKey
    if (!baseURL || !model || !key) return
    const system = [
      '你是场景状态记录员。根据"旧摘要"和"本轮对话"，输出更新后的当前情景摘要。',
      '规则：',
      '- 只保留此刻仍然有效的状态；已被新动作取代的旧状态必须更新',
      '- 只描述对话中明确支持的内容，不确定的不要编造',
      '- 不超过 120 字，逐行输出（每行一条）：用户状态/活动：…｜角色状态/动作：…｜场景与氛围：…（场景与氛围必须包含当前时段与光线环境，如"夜晚·室内暖灯·窗外全黑"）',
      prev ? '- "旧摘要"中仍然有效的行可以保留' : '',
      '- 若场景没有任何变化，只输出 UNCHANGED',
    ]
      .filter(Boolean)
      .join('\n')
    const user = [
      prev ? `【旧摘要】\n${prev}` : '【旧摘要】\n（无，这是第一条摘要）',
      `【本轮对话】\n用户：${userText}\n角色：${assistantText}`,
    ].join('\n\n')
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
