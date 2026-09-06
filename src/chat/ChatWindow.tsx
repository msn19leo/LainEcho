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
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Bot, PanelLeft, Plus, Settings as SettingsIcon, X } from 'lucide-react'
import { api } from '../api'
import { DropdownMenu, type MenuItem } from '../components/DropdownMenu'
import { IconTile } from '../components/IconTile'
import { FloatingDock } from '../components/FloatingDock'
import { PendingMemoryBadge } from '../components/PendingMemoryBadge'
import { useCharacterStore } from '../store/characterStore'
import { bindPersistentSessionSync, useSessionStore } from '../store/sessionStore'
import { MessageList } from './MessageList'
import { InputArea } from './InputArea'
import { SessionSidebar } from './SessionSidebar'
import { useChatReadingStore } from './readingStore'
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
  // 持久订阅 AI 流式/完成事件，驱动会话消息流式上屏与完成落定（与宠物窗同步）
  useEffect(() => {
    // 通知主进程 renderer 就绪：补发最近一次语音模式，避免广播早于订阅而丢失
    api.chat.reportRendererReady()
    return bindPersistentSessionSync()
  }, [])

  // 订阅宠物窗朗读文本与之语音模式：聊天窗与宠物窗采用一致的分段跟读展示
  useEffect(() => {
    const unsubText = api.chat.onReadingText((text) => {
      useChatReadingStore.getState().setText(text)
    })
    const unsubMode = api.chat.onVoiceMode(({ voiceEnabled, followText }) => {
      useChatReadingStore.getState().setFollowReading(!!voiceEnabled && !!followText)
      // 新一轮语音模式到达：清空上一轮朗读文本，避免先冒出上轮内容
      useChatReadingStore.getState().clear()
    })
    const unsubActive = api.chat.onReadingActive((active) => {
      useChatReadingStore.getState().setReadingActive(active)
    })
    return () => {
      unsubText()
      unsubMode()
      unsubActive()
    }
  }, [])

  // 主动终止 / 出错：结束本轮朗读态（chat 侧由宠物窗转发同步，这里再兜底清一次，避免残留"待输出"光标）
  useEffect(() => api.ai.onStreamError(() => {
    const r = useChatReadingStore.getState()
    r.setReadingActive(false)
    r.clear()
  }), [])

  // 新一轮流式开始：清空上一轮朗读文本，避免残留导致"先闪上轮内容"
  useEffect(() => {
    let prev = useSessionStore.getState().streaming
    return useSessionStore.subscribe((s) => {
      if (s.streaming && !prev) useChatReadingStore.getState().clear()
      prev = s.streaming
    })
  }, [])

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
    // 宠物窗点开聊天并指定会话时：加载该会话并切换当前卡
    const unsubOpen = api.chat.onOpenSession((sessionId) => {
      void loadSession(sessionId)
    })
    return unsubOpen
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

  // 其他窗口（设置面板）增删改角色卡时的跨窗口同步
  useEffect(() => {
    const unsub = api.characterCard.onChanged(() => {
      void loadCards()
    })
    return unsub
  }, [loadCards])

  // 切换角色卡：同步桌宠模型 + 表情/待机动作覆盖 + 清空当前会话（首条消息时才新建持久化会话）
  const handleCardChange = async (cardId: string) => {
    setCurrentCard(cardId)
    const card = cards.find((c) => c.id === cardId)
    api.app.setPetCard({
      cardId,
      modelId: card?.modelId ?? null,
      modelOverride: card?.modelOverride ?? null,
      renderMode: card?.renderMode ?? null,
      spriteId: card?.spriteId ?? null,
      emotionMap: card?.emotionMap ?? null,
      live2dExpressionMap: card?.live2dExpressionMap ?? null,
    })
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
    icon: Bot,
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
                  <IconTile icon={Bot} size="xs" />
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
              className="relative inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-md)] border border-border text-text-2 transition-colors hover:border-border-strong hover:text-text"
            >
              <SettingsIcon size={15} strokeWidth={1.75} />
              <PendingMemoryBadge />
            </button>
            <button
              onClick={() => api.win.close()}
              title="关闭"
              className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-md)] border border-border text-text-2 transition-colors hover:border-danger hover:text-danger"
            >
              <X size={15} strokeWidth={1.75} />
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