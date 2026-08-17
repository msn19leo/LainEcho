/**
 * 会话侧边栏（覆盖模式：absolute 定位覆盖在 FloatingDock 面板主内容上面）。
 *
 * 定位：父容器（FloatingDock 面板，absolute 定位上下文）内 absolute left-0 top-0，
 * 宽度 288px（w-72），高度填满面板（h-full），z-40 覆盖在主内容上面（不挤压）。
 * 当 open=false 时不渲染，主内容正常显示。
 *
 * framer-motion 滑入滑出；当前会话左侧品牌渐变竖条标识。
 */
import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, MessageSquareText, Pencil, Plus, Trash2, X } from 'lucide-react'
import { api } from '../api'
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
  const deleteSession = useSessionStore((s) => s.deleteSession)
  const characterCards = useCharacterStore((s) => s.cards)

  /** 正在重命名的会话 id；null = 无重命名进行中 */
  const [renamingId, setRenamingId] = useState<string | null>(null)
  /** 重命名输入框当前值 */
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)

  // 进入重命名态时自动聚焦并全选原标题，方便直接覆盖输入
  useEffect(() => {
    if (renamingId) renameInputRef.current?.select()
  }, [renamingId])

  const handleNew = () => {
    const cardId = useCharacterStore.getState().currentCardId
    if (!cardId) return
    // 首条消息发送时才真正持久化会话，避免空会话堆积
    resetCurrentSession()
    onClose()
  }

  /** 进入行内重命名：记录目标会话并载入原标题 */
  const startRename = (s: { id: string; title: string }) => {
    setRenamingId(s.id)
    setRenameValue(s.title)
  }

  /** 提交重命名：空标题则放弃；成功后刷新列表（主进程会广播通知其他窗口） */
  const commitRename = async () => {
    const id = renamingId
    setRenamingId(null)
    const title = renameValue.trim()
    if (!id || !title) return
    try {
      await api.session.rename(id, title)
      await useSessionStore.getState().onSessionsChanged()
    } catch (err) {
      console.error('重命名会话失败', err)
    }
  }

  /** 取消重命名 */
  const cancelRename = () => setRenamingId(null)

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
                  className="bg-brand-gradient glow-primary inline-flex items-center gap-1 rounded-[var(--radius-md)] px-3 py-2 text-xs font-medium text-[var(--on-brand)] transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Plus size={13} strokeWidth={2.25} />
                  新建会话
                </button>
                <button
                  onClick={onClose}
                  aria-label="关闭"
                  className="rounded-[var(--radius-md)] p-2 text-text-muted transition-colors hover:bg-card-hover hover:text-text"
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
                const renaming = renamingId === s.id
                return (
                  <div
                    key={s.id}
                    className={cn(
                      'group relative mb-1 flex w-full items-center rounded-[var(--radius-md)] transition-colors',
                      active ? 'bg-primary-500/10' : 'hover:bg-card-hover',
                      (streaming || renaming) && 'cursor-not-allowed opacity-60',
                    )}
                  >
                    {active && (
                      <span
                        className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full"
                        style={{ background: 'var(--gradient-brand)', boxShadow: '0 0 8px var(--primary-glow)' }}
                      />
                    )}
                    {renaming ? (
                      /* 行内重命名编辑态：输入框 + 确认按钮 */
                      <div className="relative min-w-0 flex-1 px-3 py-3">
                        <input
                          ref={renameInputRef}
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void commitRename()
                            if (e.key === 'Escape') cancelRename()
                          }}
                          autoFocus
                          placeholder="会话标题"
                          className="w-full rounded-[var(--radius)] border border-[var(--primary-400)] bg-transparent px-2 py-1 text-sm font-medium text-text outline-none"
                        />
                      </div>
                    ) : (
                      <button
                        onClick={() => {
                          if (streaming) return // 流式中禁止切换会话，防止串台
                          if (!active) void loadSession(s.id)
                          onClose()
                        }}
                        disabled={streaming}
                        className="relative min-w-0 flex-1 px-3 py-3 text-left"
                      >
                        <div className={cn('truncate pl-1 text-sm font-medium', active ? 'text-text' : 'text-text-2')}>
                          {truncate(s.title, 20)}
                        </div>
                        <div className="mt-1 flex items-center justify-between pl-1 text-xs text-text-muted">
                          <span className="max-w-[60%] truncate">{s.characterCardName}</span>
                          <span>{formatRelativeTime(s.updatedAt)}</span>
                        </div>
                      </button>
                    )}
                    {renaming ? (
                      <button
                        onClick={(e) => {
                          e.stopPropagation() // 阻止冒泡触发切换会话
                          void commitRename()
                        }}
                        aria-label="确认重命名"
                        title="确认"
                        className="mr-2 rounded-[var(--radius)] p-1.5 text-[var(--success)] hover:bg-success/10"
                      >
                        <Check size={14} strokeWidth={2.5} />
                      </button>
                    ) : (
                      <>
                        <button
                          onClick={(e) => {
                            e.stopPropagation() // 阻止冒泡触发切换会话
                            startRename(s)
                          }}
                          disabled={streaming}
                          aria-label={`重命名会话「${s.title}」`}
                          title="重命名"
                          className="rounded-[var(--radius)] p-1.5 text-text-muted opacity-45 transition-all hover:bg-card-hover hover:text-text focus:opacity-100 disabled:cursor-not-allowed disabled:opacity-30 group-hover:opacity-100"
                        >
                          <Pencil size={14} strokeWidth={2} />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation() // 阻止冒泡触发切换会话
                            void deleteSession(s.id)
                          }}
                          disabled={streaming}
                          aria-label={`删除会话「${s.title}」`}
                          title="删除会话"
                          className="mr-2 rounded-[var(--radius)] p-1.5 text-text-muted opacity-45 transition-all hover:bg-danger/10 hover:text-danger focus:opacity-100 disabled:cursor-not-allowed disabled:opacity-30 group-hover:opacity-100"
                        >
                          <Trash2 size={14} strokeWidth={2} />
                        </button>
                      </>
                    )}
                  </div>
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
