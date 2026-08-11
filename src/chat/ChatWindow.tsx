/**
 * 聊天窗口（重构后：纯状态管理容器 + FloatingDock 浮动面板）。
 *
 * 重构要点：
 *   - UI 层交由 FloatingDock 承载（非对称浮动、折叠/展开态、JS 拖拽）。
 *   - 本组件只负责状态管理：角色卡加载、会话列表、跨窗口同步、流式状态。
 *   - Dock 内部组合：顶栏（角色卡选择/新建/主题切换/设置）+ MessageList + InputArea。
 *   - SessionSidebar 作为抽屉覆盖层保留。
 *
 * 业务逻辑与旧版完全一致（初始化、focus 刷新、session.onChanged 同步、切卡清会话等），
 * 仅 UI 结构按「反套路设计规范」重组。
 */
import { useEffect, useState } from 'react'
import { ChevronDown, Drama, PanelLeft, Plus, Settings as SettingsIcon } from 'lucide-react'
import { api } from '../api'
import { DropdownMenu, type MenuItem } from '../components/DropdownMenu'
import { IconTile } from '../components/IconTile'
import { FloatingDock } from '../components/FloatingDock'
import { useCharacterStore } from '../store/characterStore'
import { useSessionStore } from '../store/sessionStore'
import { MessageList } from './MessageList'
import { InputArea } from './InputArea'
import { SessionSidebar } from './SessionSidebar'
import { toast } from '../components/toast'

export function ChatWindow() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const cards = useCharacterStore((s) => s.cards)
  const currentCardId = useCharacterStore((s) => s.currentCardId)
  const setCurrentCard = useCharacterStore((s) => s.setCurrentCard)
  const loadCards = useCharacterStore((s) => s.load)
  const sessions = useSessionStore((s) => s.sessions)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const loadSessions = useSessionStore((s) => s.loadSessions)
  const loadSession = useSessionStore((s) => s.loadSession)
  const resetCurrentSession = useSessionStore((s) => s.resetCurrentSession)
  const streaming = useSessionStore((s) => s.streaming)

  const currentCard = cards.find((c) => c.id === currentCardId)
  const currentSession = sessions.find((s) => s.id === currentSessionId)

  // 初始化：加载角色卡与会话列表；不预创建会话，保持空会话状态，发送首条消息时才持久化
  useEffect(() => {
    void (async () => {
      await loadCards()
      await loadSessions()
      const state = useSessionStore.getState()
      if (state.currentSessionId) void loadSession(state.currentSessionId)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 窗口重新聚焦时刷新（设置窗口可能改了角色卡/会话）
  useEffect(() => {
    const onFocus = () => {
      void loadCards()
      void loadSessions()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [loadCards, loadSessions])

  // 其他窗口（Data 面板）新建/删除会话时的跨窗口同步
  useEffect(() => {
    const unsub = api.session.onChanged(() => {
      void useSessionStore.getState().onSessionsChanged()
    })
    return unsub
  }, [])

  // 切换角色卡：同步桌宠模型 + 清空当前会话（首条消息时才新建持久化会话）
  const handleCardChange = async (cardId: string) => {
    setCurrentCard(cardId)
    const card = cards.find((c) => c.id === cardId)
    api.app.setPetModel(card?.modelId ?? null)
    resetCurrentSession()
  }

  // 新建会话：清空当前会话（首条消息时才新建持久化会话，避免空会话堆积）
  const handleNewSession = () => {
    if (!currentCardId) {
      toast('请先选择角色卡', 'info')
      return
    }
    resetCurrentSession()
  }

  const cardItems: MenuItem[] = cards.map((c) => ({
    key: c.id,
    label: c.name,
    icon: Drama,
    onSelect: () => void handleCardChange(c.id),
  }))

  return (
    <div className="relative h-full w-full overflow-hidden">
      {/* 浮动 Dock：折叠态头像小球，展开态完整聊天面板 */}
      <FloatingDock
        avatarName={currentCard?.name}
        width={560}
        height={600}
        defaultExpanded
        overlay={<SessionSidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />}
      >
        {/* Dock 内顶栏 —— relative z-20 确保顶栏层叠上下文高于消息流，
            角色卡下拉菜单（z-50）不会被 AI 消息的 glass 层叠上下文覆盖 */}
        <div className="glass relative z-20 flex h-12 shrink-0 items-center gap-2 border-b border-t-0 px-4">
          <button
            onClick={() => setSidebarOpen(true)}
            className="inline-flex shrink-0 items-center gap-2 rounded-[var(--radius-md)] border border-border px-3 py-2 text-xs text-text-2 transition-colors hover:border-border-strong hover:text-text"
          >
            <PanelLeft size={15} strokeWidth={1.75} />
            <span>会话</span>
          </button>

          <div className="min-w-0 flex-1 text-center">
            <span className="truncate text-sm font-medium text-text">
              {currentSession?.title ?? '新会话'}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <DropdownMenu
              align="end"
              disabled={streaming}
              buttonClassName="inline-flex h-8 max-w-[120px] items-center gap-2 rounded-[var(--radius-md)] border border-border bg-surface-2/70 px-2 text-xs text-text transition-colors hover:border-border-strong"
              panelClassName="w-56"
              trigger={
                <>
                  <IconTile icon={Drama} size="xs" />
                  <span className="truncate font-medium">{currentCard?.name ?? '选角色'}</span>
                  <ChevronDown size={13} className="shrink-0 text-text-muted" />
                </>
              }
              items={cardItems}
            />
            <button
              onClick={() => void handleNewSession()}
              disabled={streaming}
              title="新建会话"
              className="bg-brand-gradient glow-primary inline-flex h-8 items-center gap-1 rounded-[var(--radius-md)] px-3 text-xs font-medium text-[var(--on-brand)] transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Plus size={14} strokeWidth={2.25} />
            </button>
            <button
              onClick={() => api.app.openSettings()}
              title="设置"
              className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-md)] border border-border text-text-2 transition-colors hover:border-border-strong hover:text-text"
            >
              <SettingsIcon size={15} strokeWidth={1.75} />
            </button>
          </div>
        </div>

        {/* 消息流 */}
        <MessageList />

        {/* 输入区 */}
        <InputArea />
      </FloatingDock>
    </div>
  )
}
