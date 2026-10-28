/**
 * 编辑并重发 / 重新回答的统一服务（截断 + 情景摘要重建）。
 *
 * 设计要点：
 * - 所有重答都走"从目标 user 消息截断 → 用原文或编辑文本重跑 runChatTurn"，没有独立重答管线；
 * - 截断不可撤销（产品决定）：不保留快照、不做撤销窗口，删除即最终生效；
 * - 截断后按需重建情景摘要：旧摘要 + 截断后最近 12 条 + 当前时间，2.5s 超时则清空后继续；
 * - rewindState 在截断→摘要重建→重跑启动期间占位，阻止同会话的发送/二次重答/主动搭话。
 */
import type { ChatMessageMeta, RewindReceipt, SessionDetail } from '../../src/types'
import {
  getCharacterCard,
  getSession,
  getSettings,
  setSessionSceneDigest,
  truncateSessionFromMessage,
  updateSessionSceneDigest,
} from './repository'
import { buildCharacterBrief, rebuildSceneDigestAfterRewind } from './sceneContext'
import { isTurnBusy, runChatTurn } from './chatTurn'
import { resolveProfile } from './apiProfiles'
import { noteUserMessage } from './proactive/scheduler'
import { windowManager } from '../windows/windowManager'
import * as turnCoordinator from './turnCoordinator'
import { addRewindBusy, isRewindBusy, removeRewindBusy } from './rewindState'

export { isRewindBusy } from './rewindState'

type RewindMode = 'edit' | 'regen'

/** 重答前校验目标消息：下标 + role + 内容/时间戳指纹，防另一窗口追加后按旧下标误删 */
function resolveTargetIndex(session: SessionDetail, mode: RewindMode, targetIndex?: number): number {
  const msgs = session.messages ?? []
  if (msgs.length === 0) throw new Error('会话为空，没有可重发的消息')

  if (mode === 'regen' && targetIndex == null) {
    const last = msgs[msgs.length - 1]
    if (!last) throw new Error('没有可重新回答的轮次')
    if (last.role === 'assistant') {
      let i = msgs.length - 2
      while (i >= 0 && msgs[i]?.role !== 'user') i--
      if (i < 0) throw new Error('没有可重新回答的轮次')
      return i
    }
    if (last.role === 'user') return msgs.length - 1
    throw new Error('没有可重新回答的轮次')
  }

  // 兼容旧 ai:regenerate(editText) 调用：未传 targetIndex 时编辑最后一轮的 user
  if (mode === 'edit' && targetIndex == null) {
    const last = msgs[msgs.length - 1]
    if (last?.role === 'user') return msgs.length - 1
    if (last?.role === 'assistant') {
      let i = msgs.length - 2
      while (i >= 0 && msgs[i]?.role !== 'user') i--
      if (i >= 0) return i
    }
    throw new Error('没有可编辑的消息')
  }

  if (targetIndex == null || !Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= msgs.length) {
    throw new Error('目标消息不存在')
  }
  return targetIndex
}

export interface RewindParams {
  sessionId: string
  mode: RewindMode
  targetIndex?: number
  /** edit 模式的新文本；regen 模式忽略 */
  editText?: string
  expectedRevision?: number
  expectedTimestamp?: number
  expectedContent?: string
}

/**
 * 执行一次重答：校验 → 截断 → 广播 → 按需重建摘要 → 重跑正常聊天链路。
 * 轮次失败由 stream-error 广播驱动（本轮不 rethrow）；前置拒绝（busy / 目标不存在 /
 * 版本已更新）直接 throw，渲染端 toast。
 */
export async function performRewind(params: RewindParams): Promise<RewindReceipt> {
  const { sessionId, mode } = params
  if (!sessionId) throw new Error('缺少会话 id')
  if (isTurnBusy()) throw new Error('上一轮回复还在生成中，请稍候')
  if (isRewindBusy(sessionId)) throw new Error('正在处理上一条消息的重发，请稍候')

  const session = await getSession(sessionId)
  const targetIndex = resolveTargetIndex(session, mode, params.targetIndex)
  const target = session.messages[targetIndex]
  if (!target || target.role !== 'user') throw new Error('只能编辑用户消息')
  if (mode === 'edit' && target.meta?.proactive) throw new Error('主动搭话旁白不支持编辑')
  if (params.expectedTimestamp !== undefined && target.timestamp !== params.expectedTimestamp) {
    throw new Error('消息已变化，请刷新后重试')
  }
  if (params.expectedContent !== undefined && target.content !== params.expectedContent) {
    throw new Error('消息已变化，请刷新后重试')
  }

  const content = mode === 'edit' ? (params.editText ?? '').trim() : (target.content ?? '').trim()
  if (!content) throw new Error('编辑后的消息内容为空')
  // 重新回答主动搭话轮时保留 proactive 标记；编辑/失败重发不携带 error/cancelled 旧标记
  const meta: ChatMessageMeta | undefined = mode === 'regen' && target.meta?.proactive ? { proactive: true } : undefined

  addRewindBusy(sessionId)

  let truncated: Awaited<ReturnType<typeof truncateSessionFromMessage>>
  try {
    truncated = await truncateSessionFromMessage(sessionId, targetIndex, {
      expectedRevision: params.expectedRevision,
      allowProactive: mode === 'regen',
    })
    if (!truncated || truncated.removed.length === 0) throw new Error('没有可重新发送的轮次')
  } catch (err) {
    removeRewindBusy(sessionId)
    throw err
  }

  // 摘要是否过期以截断瞬间的磁盘值为准：上一轮的异步摘要更新可能在 getSession 之后、
  // truncate 之前排队落盘，用旧 marker 会误判"不需要重建"而保留覆盖被删未来的摘要。
  const previousDigest = truncated.session.sceneDigest?.trim() || undefined
  const previousDigestAt = truncated.session.sceneDigestAt
  const shouldRebuild = !!previousDigest && (previousDigestAt === undefined || previousDigestAt > targetIndex)

  console.log(
    '[rewind] 截断完成 sid=%s mode=%s target=%d deleted=%d rebuild=%s',
    sessionId,
    mode,
    targetIndex,
    truncated.removed.length,
    shouldRebuild,
  )

  // 旧回合文档（已落定的跟读/直播）必须清掉：否则两窗会继续渲染被删回复的直播气泡
  turnCoordinator.clearTurn(sessionId)

  windowManager.broadcastAI('ai:session-rewound', {
    sessionId,
    messages: truncated.session.messages,
    revision: truncated.session.revision ?? 0,
    deletedCount: truncated.removed.length,
    targetIndex,
  })
  // 首条消息被编辑时标题已重置；刷新索引让聊天窗顶栏/会话列表立即跟随
  windowManager.notifySessionsChanged()
  void noteUserMessage(sessionId)

  try {
    await rebuildDigestAndRun({
      session: truncated.session,
      targetIndex,
      content,
      meta,
      shouldRebuild,
      previousDigest,
    })
  } finally {
    removeRewindBusy(sessionId)
  }

  return { ok: true, deletedCount: truncated.removed.length, targetIndex }
}

/**
 * 截断后：按需重建情景摘要 → 校验会话未被并发追加 → 启动 runChatTurn。
 * 摘要重建是缓存语义，任何异常都不阻断重跑。
 */
async function rebuildDigestAndRun(params: {
  session: SessionDetail
  targetIndex: number
  content: string
  meta?: ChatMessageMeta
  shouldRebuild: boolean
  previousDigest?: string
}): Promise<void> {
  const { session, targetIndex, shouldRebuild, previousDigest } = params
  const sessionId = session.id

  if (shouldRebuild) {
    try {
      const settings = await getSettings()
      if (settings.enableSceneDigest) {
        const mainCfg = await resolveProfile('main')
        const card = await getCharacterCard(session.characterCardId)
        if (mainCfg) {
          const rebuilt = await rebuildSceneDigestAfterRewind({
            sessionId,
            survivingMessages: session.messages,
            previousDigest,
            characterBrief: buildCharacterBrief(card),
            settings,
            mainCfg,
          })
          if (rebuilt) {
            const written = await updateSessionSceneDigest(sessionId, rebuilt, {
              expectedSceneEpoch: session.sceneEpoch,
              atMessageCount: targetIndex,
            })
            if (written) console.log('[rewind] 情景摘要已按截断点重建 sid=%s', sessionId)
            else console.warn('[rewind] 摘要已过期代际，放弃写入 session=%s', sessionId)
          } else {
            // 重建失败/超时：清空，避免把"被删未来"的摘要带进新一轮
            await setSessionSceneDigest(sessionId, '', {
              expectedSceneEpoch: session.sceneEpoch,
              atMessageCount: targetIndex,
            })
          }
        } else {
          await setSessionSceneDigest(sessionId, '', {
            expectedSceneEpoch: session.sceneEpoch,
            atMessageCount: targetIndex,
          })
        }
      } else {
        // 功能关闭时也把已失效的缓存清掉：避免用户之后重新开启时把"被删未来"注入
        await setSessionSceneDigest(sessionId, '', {
          expectedSceneEpoch: session.sceneEpoch,
          atMessageCount: targetIndex,
        })
      }
    } catch (err) {
      console.warn('[rewind] 情景摘要重建准备失败：', err instanceof Error ? err.message : String(err))
      await setSessionSceneDigest(sessionId, '', {
        expectedSceneEpoch: session.sceneEpoch,
        atMessageCount: targetIndex,
      }).catch(() => {})
    }
  }

  // 摘要重建期间可能有别的入口（宠物输入/主动搭话竞态）抢先开了轮次：
  // 绝不能再并发开第二轮，明确拒绝
  if (isTurnBusy()) throw new Error('上一轮回复还在生成中，请稍候')

  // 摘要重建期间若有消息落盘（极端竞态），当前会话已不是"截断后"的状态：
  // 不能再把重跑的用户消息叠到别人后面
  const current = await getSession(sessionId)
  if ((current.revision ?? 0) !== (session.revision ?? 0)) {
    throw new Error('会话已更新，请刷新后重试')
  }

  // runChatTurn 在同步段置 busy：先释放重答占位，避免占用窗口被动搭话误判
  removeRewindBusy(sessionId)
  try {
    await runChatTurn({ sessionId, content: params.content, meta: params.meta })
  } catch {
    // 失败态（stream-error + 失败轮落盘）已由 chatTurn 广播驱动，调用方无需处理
  }
}
