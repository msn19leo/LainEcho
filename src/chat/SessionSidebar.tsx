/**
 * 会话侧边栏（Drawer 覆盖层）。
 * 顶部「＋ 新建会话」，列表项点击切换当前会话。
 */
import { useCharacterStore } from '../store/characterStore'
import { useSessionStore } from '../store/sessionStore'
import { cn, formatRelativeTime, truncate } from '../lib/utils'

interface SessionSidebarProps {
  open: boolean
  onClose: () => void
}

export function SessionSidebar({ open, onClose }: SessionSidebarProps) {
  const sessions = useSessionStore((s) => s.sessions)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const streaming = useSessionStore((s) => s.streaming)
  const loadSession = useSessionStore((s) => s.loadSession)
  const createSession = useSessionStore((s) => s.createSession)
  const characterCards = useCharacterStore((s) => s.cards)

  const handleNew = async () => {
    const cardId = useCharacterStore.getState().currentCardId
    if (!cardId) return
    await createSession(cardId)
    onClose()
  }

  return (
    <>
      {open && <div className="fixed inset-0 z-30 bg-black/40" onClick={onClose} />}
      <aside
        className={cn(
          'fixed left-0 top-0 z-40 flex h-full w-72 flex-col border-r border-border bg-panel transition-transform duration-200',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex items-center justify-between border-b border-border p-3">
          <span className="text-sm font-semibold text-text">全部会话</span>
          <button
            onClick={handleNew}
            disabled={streaming}
            className="inline-flex items-center gap-1 rounded-lg bg-gradient-to-r from-accent to-accent-2 px-2.5 py-1 text-xs font-medium text-white transition hover:brightness-110 disabled:opacity-40"
          >
            ＋ 新建会话
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {sessions.length === 0 && (
            <div className="py-10 text-center text-sm text-text-muted">暂无会话</div>
          )}
          {sessions.map((s) => (
            <button
              key={s.id}
              onClick={() => {
                if (streaming) return // 流式中禁止切换会话，防止串台
                if (s.id !== currentSessionId) void loadSession(s.id)
                onClose()
              }}
              disabled={streaming}
              className={cn(
                'mb-1 block w-full rounded-lg px-3 py-2.5 text-left transition',
                s.id === currentSessionId
                  ? 'bg-accent/15 ring-1 ring-accent/40'
                  : 'hover:bg-card-hover',
                streaming && 'cursor-not-allowed opacity-60',
              )}
            >
              <div className="truncate text-sm font-medium text-text">
                {truncate(s.title, 20)}
              </div>
              <div className="mt-0.5 flex items-center justify-between text-xs text-text-muted">
                <span className="truncate max-w-[60%]">{s.characterCardName}</span>
                <span>{formatRelativeTime(s.updatedAt)}</span>
              </div>
            </button>
          ))}
        </div>

        <div className="border-t border-border p-3 text-xs text-text-muted">
          共 {sessions.length} 个会话 · 角色卡 {characterCards.length} 张
        </div>
      </aside>
    </>
  )
}
