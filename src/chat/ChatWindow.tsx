/**
 * 聊天窗口：标题栏 + 顶栏（角色卡选择 / 会话标题 / 全部会话按钮）+ 消息流 + 输入框 + 侧边栏。
 */
import { useEffect, useState } from 'react'
import { api } from '../api'
import { WindowTitlebar } from '../components/WindowTitlebar'
import { useCharacterStore } from '../store/characterStore'
import { useSessionStore } from '../store/sessionStore'
import { MessageList } from './MessageList'
import { MessageInput } from './MessageInput'
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
  const ensureSession = useSessionStore((s) => s.ensureSession)
  const loadSession = useSessionStore((s) => s.loadSession)
  const createSession = useSessionStore((s) => s.createSession)
  const streaming = useSessionStore((s) => s.streaming)

  const currentCard = cards.find((c) => c.id === currentCardId)
  const currentSession = sessions.find((s) => s.id === currentSessionId)

  // 初始化
  useEffect(() => {
    void (async () => {
      await loadCards()
      await loadSessions()
      const { currentSessionId: cur } = useSessionStore.getState()
      if (!cur) {
        const card = useCharacterStore.getState().currentCardId
        if (card) await ensureSession(card)
      } else if (!useSessionStore.getState().sessions.some((s) => s.id === cur)) {
        await loadSessions()
      }
      // 存在当前会话则加载其消息
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

  // 切换角色卡：自动新建会话 + 同步桌宠模型
  const handleCardChange = async (cardId: string) => {
    setCurrentCard(cardId)
    const card = cards.find((c) => c.id === cardId)
    api.app.setPetModel(card?.modelId ?? null)
    try {
      await createSession(cardId)
    } catch (err) {
      toast(err instanceof Error ? err.message : '新建会话失败', 'error')
    }
  }

  const handleNewSession = async () => {
    if (!currentCardId) return
    try {
      await createSession(currentCardId)
    } catch (err) {
      toast(err instanceof Error ? err.message : '新建会话失败', 'error')
    }
  }

  return (
    <div className="flex h-screen flex-col bg-surface text-text">
      <WindowTitlebar title={currentCard?.name ? `${currentCard.name} · 聊天` : 'AI 桌宠 · 聊天'} />

      {/* 顶栏 */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-surface-2/60 px-3">
        <button
          onClick={() => setSidebarOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-text-2 transition hover:border-border-strong hover:text-text"
        >
          ☰ <span>全部会话</span>
        </button>

        <div className="min-w-0 flex-1 text-center">
          <span className="truncate text-sm font-medium text-text">{currentSession?.title ?? '新会话'}</span>
        </div>

        <div className="flex items-center gap-1.5">
          <select
            value={currentCardId ?? ''}
            onChange={(e) => void handleCardChange(e.target.value)}
            disabled={streaming}
            className="cursor-pointer rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-xs text-text outline-none transition focus:border-accent disabled:opacity-40"
            title="切换角色卡将自动新建会话"
          >
            {cards.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <button
            onClick={() => void handleNewSession()}
            disabled={streaming}
            className="inline-flex items-center gap-1 rounded-lg bg-gradient-to-r from-accent to-accent-2 px-2.5 py-1.5 text-xs font-medium text-white transition hover:brightness-110 disabled:opacity-40"
            title="新建会话"
          >
            ＋
          </button>
          <button
            onClick={() => api.app.openSettings()}
            className="inline-flex items-center rounded-lg border border-border px-2.5 py-1.5 text-xs text-text-2 transition hover:border-border-strong hover:text-text"
          >
            ⚙ 设置
          </button>
        </div>
      </div>

      {/* 消息区 */}
      <MessageList />

      {/* 输入框 */}
      <MessageInput />

      {/* 会话侧边栏 */}
      <SessionSidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
    </div>
  )
}
