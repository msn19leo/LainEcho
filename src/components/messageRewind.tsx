/**
 * 消息重答共享件（桌宠迷你会话框 PetContentList 与聊天窗 MessageList 共用）：
 * - useRewindMenu：右键菜单状态机——「编辑并重发」（最后一轮 user 气泡）/「重新回答」
 *   （最后一轮 assistant 气泡）。"截断最后一轮 → 重走正常链路"。
 * - RewindEditBox：气泡原位编辑框（textarea 替换气泡内容），确认 = 编辑并重发。
 *
 * 仅轮次空闲（!streaming）时可发起；进行中由主进程 busy 标志兜底拒绝（ai:regenerate）。
 * 剧情系统不接此功能（剧情轮次不经 sessionStore 消息列表）。
 */
import { useCallback, useState } from 'react'
import { useSessionStore } from '../store/sessionStore'

export type RewindKind = 'edit' | 'regen'

export interface RewindMenuState {
  x: number
  y: number
  kind: RewindKind
}

export function useRewind() {
  const [menu, setMenu] = useState<RewindMenuState | null>(null)
  const [editing, setEditing] = useState(false)
  const streaming = useSessionStore((s) => s.streaming)

  const openMenu = useCallback((kind: RewindKind, x: number, y: number) => {
    if (useSessionStore.getState().streaming) return
    setMenu({ x, y, kind })
  }, [])
  const closeMenu = useCallback(() => setMenu(null), [])

  /** 菜单确认：编辑 → 进入原位编辑态；重新回答 → 直接重跑 */
  const confirmMenu = useCallback(() => {
    const kind = menu?.kind
    setMenu(null)
    if (kind === 'edit') setEditing(true)
    else if (kind === 'regen') void useSessionStore.getState().regenerate()
  }, [menu])

  const cancelEdit = useCallback(() => setEditing(false), [])
  /** 原位编辑确认 = 编辑并重发 */
  const confirmEdit = useCallback((text: string) => {
    setEditing(false)
    void useSessionStore.getState().regenerate(text)
  }, [])

  return { menu, openMenu, closeMenu, confirmMenu, editing, startEditing: () => setEditing(true), cancelEdit, confirmEdit, streaming }
}

/** 判定该消息是否可右键重答（仅最后一轮；轮次空闲时才可）。
 * 两种形态：完整轮（末尾 assistant → 重新回答；其前 user → 编辑并重发）、
 * 孤立 user（上一轮发送失败落盘的"未收到回复"消息 → 右键它 = 编辑并重发，2026-10-17 实锤场景）。 */
export function rewindTargetFor(
  index: number,
  messages: Array<{ role: string; meta?: { proactive?: boolean } }>,
  streaming: boolean,
): RewindKind | null {
  if (streaming || messages.length === 0) return null
  const last = messages[messages.length - 1]
  if (last?.role === 'assistant') {
    if (messages.length < 2) return null
    if (index === messages.length - 1) return 'regen'
    if (index === messages.length - 2) {
      const msg = messages[index]
      // 主动搭话旁白不是用户消息（居中斜体行），不提供编辑
      return msg?.role === 'user' && !msg.meta?.proactive ? 'edit' : null
    }
    return null
  }
  // 孤立 user：右键它 = 编辑并重发（主动搭话旁白不是用户输入，排除）
  if (last?.role === 'user' && !last.meta?.proactive && index === messages.length - 1) return 'edit'
  return null
}

/** 气泡原位编辑框：textarea 替换气泡内容，Enter 确认 / Esc 取消 */
export function RewindEditBox({
  initial,
  compact,
  onConfirm,
  onCancel,
}: {
  initial: string
  /** 紧凑布局（桌宠迷你会话框小气泡） */
  compact?: boolean
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
        <span className="mr-auto text-[10px] text-text-muted">确认后将删除本轮回复并重新生成</span>
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
