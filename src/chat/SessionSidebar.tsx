/**
 * 会话侧边栏（覆盖模式：absolute 定位覆盖在 FloatingDock 面板主内容上面）。
 *
 * 定位：父容器（FloatingDock 面板，absolute 定位上下文）内 absolute left-0 top-0，
 * 宽度 288px（w-72），高度填满面板（h-full），z-40 覆盖在主内容上面（不挤压）。
 * 当 open=false 时不渲染，主内容正常显示。
 *
 * framer-motion 滑入滑出；当前会话左侧品牌渐变竖条标识。
 */
import { AnimatePresence, motion } from 'framer-motion'
import { MessageSquareText, Plus, X } from 'lucide-react'
import { useCharacterStore } from '../store/characterStore'
import { useSessionStore } from '../store/sessionStore'
import { cn, formatRelativeTime, truncate } from '../lib/utils'
import { drawerSlide } from '../lib/motion'

interface SessionSidebarProps {
  open: boolean
  onClose: () => void
}

export function SessionSidebar({ open, onClose }: SessionSidebarProps) {
  const sessions = useSessionStore((s) => s.sessions)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const streaming = useSessionStore((s) => s.streaming)
  const loadSession = useSessionStore((s) => s.loadSession)
  const resetCurrentSession = useSessionStore((s) => s.resetCurrentSession)
  const characterCards = useCharacterStore((s) => s.cards)

  const handleNew = () => {
    const cardId = useCharacterStore.getState().currentCardId
    if (!cardId) return
    // 首条消息发送时才真正持久化会话，避免空会话堆积
    resetCurrentSession()
    onClose()
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          {...drawerSlide}
          className="glass-strong app-no-drag absolute left-0 top-0 z-40 flex h-full w-72 flex-col"
        >
            <div className="flex items-center justify-between border-b border-border p-3">
              <span className="flex items-center gap-2 text-sm font-semibold text-text">
                <MessageSquareText size={16} className="text-primary-400" />
                全部会话
              </span>
              <div className="flex items-center gap-1">
                <button
                  onClick={handleNew}
                  disabled={streaming}
                  className="bg-brand-gradient glow-primary inline-flex items-center gap-1 rounded-[var(--radius-md)] px-2.5 py-1.5 text-xs font-medium text-[var(--on-brand)] transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Plus size={13} strokeWidth={2.25} />
                  新建会话
                </button>
                <button
                  onClick={onClose}
                  aria-label="关闭"
                  className="rounded-[var(--radius-md)] p-1.5 text-text-muted transition-colors hover:bg-card-hover hover:text-text"
                >
                  <X size={15} strokeWidth={1.75} />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-2">
              {sessions.length === 0 && (
                <div className="py-10 text-center text-sm text-text-muted">暂无会话</div>
              )}
              {sessions.map((s) => {
                const active = s.id === currentSessionId
                return (
                  <button
                    key={s.id}
                    onClick={() => {
                      if (streaming) return // 流式中禁止切换会话，防止串台
                      if (!active) void loadSession(s.id)
                      onClose()
                    }}
                    disabled={streaming}
                    className={cn(
                      'relative mb-1 block w-full rounded-[var(--radius-md)] px-3 py-2.5 text-left transition-colors',
                      active ? 'bg-primary-500/10' : 'hover:bg-card-hover',
                      streaming && 'cursor-not-allowed opacity-60',
                    )}
                  >
                    {active && (
                      <span
                        className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full"
                        style={{ background: 'var(--gradient-brand)', boxShadow: '0 0 8px var(--primary-glow)' }}
                      />
                    )}
                    <div className={cn('truncate pl-1 text-sm font-medium', active ? 'text-text' : 'text-text-2')}>
                      {truncate(s.title, 20)}
                    </div>
                    <div className="mt-0.5 flex items-center justify-between pl-1 text-xs text-text-muted">
                      <span className="max-w-[60%] truncate">{s.characterCardName}</span>
                      <span>{formatRelativeTime(s.updatedAt)}</span>
                    </div>
                  </button>
                )
              })}
            </div>

            <div className="border-t border-border p-3 text-xs text-text-muted">
              共 {sessions.length} 个会话 · 角色卡 {characterCards.length} 张
            </div>
        </motion.aside>
      )}
    </AnimatePresence>
  )
}
