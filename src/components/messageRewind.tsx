/**
 * 消息重答共享件：
 * - useRewind：右键菜单状态机——任意 user 气泡「编辑并重发」、最后一轮 assistant「重新回答」；
 *   中间消息的编辑在确认发送前弹二次确认（显示删除条数）。
 * - rewindTargetFor：判定某条消息是否可重答，返回 kind/下标/删除条数/是否最后一轮。
 * - RewindEditBox：气泡原位编辑框（textarea 替换气泡内容），确认 = 编辑并重发。
 *
 * 仅轮次空闲（!streaming && !rewinding）时可发起；主进程另有 busy/重答占位兜底。
 * 剧情系统不接此功能（剧情轮次不经 sessionStore 消息列表）。
 */
import { useCallback, useEffect, useState } from 'react'
import { useSessionStore } from '../store/sessionStore'

export type RewindKind = 'edit' | 'regen'

export interface RewindMenuState {
  x: number
  y: number
  kind: RewindKind
  targetIndex: number
}

export interface RewindTarget {
  kind: RewindKind
  index: number
  /** 从目标消息起到末尾的删除条数（含目标） */
  deletedCount: number
  /** 是否最后一轮：最后一轮保留一键重发，中间消息需要二次确认 */
  lastTurn: boolean
}

export interface RewindEditState {
  sessionId: string
  targetIndex: number
  timestamp?: number
  content: string
}

export interface RewindPendingConfirm {
  text: string
  targetIndex: number
  deletedCount: number
  /** 弹窗时的消息条数：期间有新消息落盘则取消失效，避免按过期条数确认 */
  expectedLength: number
}

export function useRewind() {
  const messages = useSessionStore((s) => s.messages)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const streaming = useSessionStore((s) => s.streaming)
  const rewinding = useSessionStore((s) => s.rewinding)
  const [menu, setMenu] = useState<RewindMenuState | null>(null)
  const [editing, setEditing] = useState<RewindEditState | null>(null)
  const [pendingConfirm, setPendingConfirm] = useState<RewindPendingConfirm | null>(null)

  const busy = streaming || rewinding

  const openMenu = useCallback((kind: RewindKind, x: number, y: number, targetIndex: number) => {
    const st = useSessionStore.getState()
    if (st.streaming || st.rewinding) return
    setMenu({ x, y, kind, targetIndex })
  }, [])
  const closeMenu = useCallback(() => setMenu(null), [])

  const startEditing = useCallback((targetIndex: number) => {
    const st = useSessionStore.getState()
    if (st.streaming || st.rewinding) return
    const msg = st.messages[targetIndex]
    if (!msg || msg.role !== 'user' || msg.meta?.proactive || !st.currentSessionId) return
    setEditing({
      sessionId: st.currentSessionId,
      targetIndex,
      timestamp: msg.timestamp,
      content: msg.content,
    })
  }, [])

  /** 菜单确认：编辑 → 进入原位编辑态；重新回答 → 直接重跑 */
  const confirmMenu = useCallback(() => {
    const current = menu
    setMenu(null)
    if (!current) return
    if (current.kind === 'edit') startEditing(current.targetIndex)
    else void useSessionStore.getState().regenerate()
  }, [menu, startEditing])

  const cancelEdit = useCallback(() => {
    setEditing(null)
    setPendingConfirm(null)
  }, [])

  const submitEdit = useCallback(
    (text: string) => {
      const target = editing
      if (!target) return
      setEditing(null)
      setPendingConfirm(null)
      void useSessionStore.getState().rewindEdit(target.targetIndex, text)
    },
    [editing],
  )

  /** 原位编辑确认：最后一轮直接重发，中间消息先弹二次确认 */
  const confirmEdit = useCallback(
    (text: string) => {
      const target = editing
      if (!target) return
      const trimmed = text.trim()
      if (!trimmed) return
      const info = rewindTargetFor(target.targetIndex, useSessionStore.getState().messages, busy)
      if (!info || info.kind !== 'edit') {
        cancelEdit()
        return
      }
      if (!info.lastTurn) {
        setPendingConfirm({
          text: trimmed,
          targetIndex: target.targetIndex,
          deletedCount: info.deletedCount,
          expectedLength: useSessionStore.getState().messages.length,
        })
        return
      }
      submitEdit(trimmed)
    },
    [editing, busy, cancelEdit, submitEdit],
  )

  const confirmPending = useCallback(() => {
    const pending = pendingConfirm
    if (!pending) return
    setEditing(null)
    setPendingConfirm(null)
    // 用 pending 自带的 targetIndex，不依赖 editing——确认框打开期间编辑态理论上不会变，
    // 但这样能保证"确认的就是弹窗时那条消息"
    void useSessionStore.getState().rewindEdit(pending.targetIndex, pending.text)
  }, [pendingConfirm])

  const cancelPending = useCallback(() => setPendingConfirm(null), [])

  // 菜单是瞬态 UI：消息列表/会话/忙态一变就关掉，避免点了"重新回答"却作用到新到的末轮
  useEffect(() => {
    setMenu(null)
  }, [messages, streaming, rewinding, currentSessionId])

  // 编辑态绑定 (sessionId, 下标, 内容/时间戳)：切会话、另一窗重答、新消息流式开始都会让目标失效。
  // 不能只用下标——截断/追加后同一个下标可能已是另一条消息，直接复用 textarea 会编辑错气泡。
  useEffect(() => {
    if (!editing) return
    const st = useSessionStore.getState()
    const msg = st.messages[editing.targetIndex]
    const invalid =
      st.currentSessionId !== editing.sessionId ||
      st.streaming ||
      st.rewinding ||
      !msg ||
      msg.role !== 'user' ||
      msg.content !== editing.content ||
      (editing.timestamp !== undefined && msg.timestamp !== editing.timestamp)
    if (invalid) {
      setEditing(null)
      setPendingConfirm(null)
      setMenu(null)
    }
  }, [editing, messages, currentSessionId, streaming, rewinding])

  // 确认框打开期间有新消息落盘/切会话：删除条数已过期，直接关掉让用户重新操作
  useEffect(() => {
    if (!pendingConfirm) return
    const st = useSessionStore.getState()
    if (st.messages.length !== pendingConfirm.expectedLength || st.currentSessionId !== editing?.sessionId) {
      setPendingConfirm(null)
    }
  }, [pendingConfirm, messages, currentSessionId, editing])

  return {
    menu,
    openMenu,
    closeMenu,
    confirmMenu,
    editing,
    startEditing,
    cancelEdit,
    confirmEdit,
    pendingConfirm,
    confirmPending,
    cancelPending,
    streaming,
    rewinding,
    busy,
  }
}

/**
 * 判定该消息是否可重答。
 * - 任意 user 消息（非 proactive 旁白）→ 编辑并重发；
 * - 最后一轮 assistant → 重新回答（其前最近的 user 为目标，主动搭话轮保留 proactive 标记）。
 * 轮次空闲（!streaming && !rewinding）时才可发起。
 */
export function rewindTargetFor(
  index: number,
  messages: Array<{ role: string; content?: string; timestamp?: number; meta?: { proactive?: boolean } }>,
  busy: boolean,
): RewindTarget | null {
  if (busy || messages.length === 0) return null
  const msg = messages[index]
  if (!msg) return null

  if (msg.role === 'user' && !msg.meta?.proactive) {
    const last = messages[messages.length - 1]
    const lastTurn =
      (last?.role === 'user' && index === messages.length - 1) ||
      (last?.role === 'assistant' && index === messages.length - 2)
    return { kind: 'edit', index, deletedCount: messages.length - index, lastTurn }
  }

  if (msg.role === 'assistant' && index === messages.length - 1) {
    let userIndex = index - 1
    while (userIndex >= 0 && messages[userIndex]?.role !== 'user') userIndex--
    if (userIndex < 0) return null
    return { kind: 'regen', index, deletedCount: messages.length - userIndex, lastTurn: true }
  }

  return null
}

/** 气泡原位编辑框：textarea 替换气泡内容，Enter 确认 / Esc 取消 */
export function RewindEditBox({
  initial,
  compact,
  hint,
  onConfirm,
  onCancel,
}: {
  initial: string
  /** 紧凑布局（桌宠迷你会话框小气泡） */
  compact?: boolean
  /** 底部提示（默认"删除本轮回复"） */
  hint?: string
  onConfirm: (text: string) => void
  onCancel: () => void
}) {
  const [text, setText] = useState(initial)
  const submit = () => {
    const t = text.trim()
    if (t) onConfirm(t)
  }
  return (
    <div
      className={compact ? 'w-full rounded-[var(--radius-md)] border border-primary/40 bg-surface-2 p-2' : 'w-full rounded-[var(--radius-lg)] border border-primary/40 bg-surface-2 p-2'}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            submit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
        rows={2}
        className="w-full resize-none bg-transparent text-[13px] leading-snug text-text outline-none selectable"
      />
      <div className="mt-1 flex items-center justify-end gap-2">
        <span className="mr-auto text-[10px] text-text-muted">{hint ?? '确认后将删除本轮回复并重新生成'}</span>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-[var(--radius-md)] px-2.5 py-1 text-[11px] text-text-2 transition-colors hover:bg-surface-3"
        >
          取消
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!text.trim()}
          className="rounded-[var(--radius-md)] bg-primary-gradient px-2.5 py-1 text-[11px] font-medium text-[var(--on-brand)] shadow-[var(--shadow-glow-primary)] transition-opacity disabled:opacity-40"
        >
          重新发送
        </button>
      </div>
    </div>
  )
}
