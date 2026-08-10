import { create } from 'zustand'
import { api } from '../api'
import type { ChatMessage, SessionIndexItem } from '../types'
import { useCharacterStore } from './characterStore'

interface SessionState {
  sessions: SessionIndexItem[]
  currentSessionId: string | null
  messages: ChatMessage[]
  loading: boolean
  streaming: boolean
  /** 流式输出中的累积文本 */
  streamingContent: string
  streamError: string | null

  loadSessions: () => Promise<void>
  ensureSession: (characterCardId: string) => Promise<string>
  loadSession: (id: string) => Promise<void>
  createSession: (characterCardId: string) => Promise<void>
  deleteSession: (id: string) => Promise<void>
  /** 发送消息并驱动流式输出 */
  send: (content: string) => Promise<void>
  stop: () => void
  /** 其他窗口新建/删除会话后的跨窗口同步（刷新列表，当前会话被删则自动新建） */
  onSessionsChanged: () => Promise<void>
}

/** 更新当前会话在列表中的索引信息（title / messageCount / updatedAt） */
async function refreshSessionIndex() {
  try {
    const sessions = await api.session.list()
    useSessionStore.setState({ sessions })
  } catch {
    // 忽略刷新失败
  }
}

/** loadSession 请求序号：丢弃过期的异步响应，防止乱序覆盖当前会话 */
let loadSeq = 0

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  currentSessionId: null,
  messages: [],
  loading: false,
  streaming: false,
  streamingContent: '',
  streamError: null,

  loadSessions: async () => {
    set({ loading: true })
    try {
      const sessions = await api.session.list()
      set({ sessions, loading: false })
    } catch (err) {
      set({ loading: false })
      console.error('加载会话列表失败', err)
    }
  },

  ensureSession: async (characterCardId) => {
    const { currentSessionId, sessions } = get()
    if (currentSessionId && sessions.some((s) => s.id === currentSessionId)) {
      return currentSessionId
    }
    // 没有会话或当前会话已不存在 → 自动新建
    const item = await api.session.create({ characterCardId })
    set((s) => ({
      sessions: [item, ...s.sessions],
      currentSessionId: item.id,
      messages: [],
    }))
    return item.id
  },

  loadSession: async (id) => {
    const seq = ++loadSeq
    // 切换会话时重置流式状态，避免上一个会话的流式内容串到新会话
    set({ streaming: false, streamingContent: '', streamError: null })
    try {
      const detail = await api.session.get(id)
      if (seq !== loadSeq) return // 已有更新的切换请求，丢弃本次响应
      set({ currentSessionId: id, messages: detail.messages })
    } catch (err) {
      if (seq === loadSeq) console.error('加载会话失败', err)
    }
  },

  createSession: async (characterCardId) => {
    const item = await api.session.create({ characterCardId })
    set((s) => ({
      sessions: [item, ...s.sessions],
      currentSessionId: item.id,
      messages: [],
      streamError: null,
    }))
  },

  deleteSession: async (id) => {
    await api.session.remove(id)
    const { currentSessionId, sessions } = get()
    const nextSessions = sessions.filter((s) => s.id !== id)
    set({ sessions: nextSessions })

    if (currentSessionId === id) {
      const fallback = nextSessions[0]
      if (fallback) {
        await get().loadSession(fallback.id)
      } else {
        // 全部删光 → 为当前角色卡新建一个（无角色卡时保持空状态）
        const cardId = useCharacterStore.getState().currentCardId
        if (cardId) await get().createSession(cardId)
        else set({ currentSessionId: null, messages: [] })
      }
    }
  },

  send: (content) =>
    new Promise<void>((resolve) => {
      const { currentSessionId, messages, streaming } = get()
      const text = content.trim()
      if (!currentSessionId || !text || streaming) {
        resolve()
        return
      }

      const userMsg: ChatMessage = { role: 'user', content: text, timestamp: Date.now() }
      const nextMessages = [...messages, userMsg]
      set({ messages: nextMessages, streaming: true, streamingContent: '', streamError: null })

      const isStillCurrent = () => get().currentSessionId === currentSessionId

      function cleanup() {
        unsubscribeChunk()
        unsubscribeDone()
        unsubscribeError()
      }

      const unsubscribeChunk = api.ai.onStreamChunk((chunk) => {
        if (!isStillCurrent()) return
        set((s) => ({ streamingContent: s.streamingContent + chunk }))
      })

      const unsubscribeDone = api.ai.onStreamDone((payload) => {
        if (payload.sessionId !== currentSessionId) return
        if (isStillCurrent()) {
          set((s) => ({
            messages: [...s.messages, payload.message],
            streaming: false,
            streamingContent: '',
            streamError: null,
          }))
        } else {
          set({ streaming: false, streamingContent: '' })
        }
        void refreshSessionIndex()
        cleanup()
        resolve()
      })

      const unsubscribeError = api.ai.onStreamError((payload) => {
        if (payload.sessionId !== currentSessionId) return
        set((s) => {
          const partial = s.streamingContent
          const appended = partial
            ? [...s.messages, { role: 'assistant' as const, content: partial, timestamp: Date.now() }]
            : s.messages
          return {
            messages: appended,
            streaming: false,
            streamingContent: '',
            // 主动取消（停止）不算错误，不展示红色错误条
            streamError: payload.cancelled ? null : payload.error,
          }
        })
        void refreshSessionIndex()
        cleanup()
        resolve()
      })

      void api.ai.sendMessage({ sessionId: currentSessionId, messages: nextMessages }).catch(() => {
        set((s) => ({ streaming: false, streamError: s.streamError ?? '消息发送失败' }))
        cleanup()
        resolve()
      })
    }),

  stop: () => api.ai.cancel(),

  onSessionsChanged: async () => {
    try {
      const sessions = await api.session.list()
      const { currentSessionId } = get()
      set({ sessions })
      if (currentSessionId && !sessions.some((s) => s.id === currentSessionId)) {
        // 当前会话被其他窗口（Data 面板）删除 → 自动新建
        const cardId = useCharacterStore.getState().currentCardId
        if (cardId) await get().createSession(cardId)
        else set({ currentSessionId: null, messages: [] })
      }
    } catch {
      // 忽略刷新失败
    }
  },
}))
