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
  loadSession: (id: string) => Promise<void>
  deleteSession: (id: string) => Promise<void>
  /** 新建空会话：清空当前会话与消息；会话在发送首条消息时才真正持久化，避免空会话堆积 */
  resetCurrentSession: () => void
  /** 发送消息并驱动流式输出（无会话时先惰性创建再发送） */
  send: (content: string) => Promise<void>
  stop: () => void
  /** 其他窗口新建/删除会话后的跨窗口同步（刷新列表；当前会话被删则回到空会话状态） */
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

  loadSession: async (id) => {
    const seq = ++loadSeq
    // 切换会话时重置流式状态，避免上一个会话的流式内容串到新会话
    set({ streaming: false, streamingContent: '', streamError: null })
    try {
      const detail = await api.session.get(id)
      if (seq !== loadSeq) return // 已有更新的切换请求，丢弃本次响应
      set({ currentSessionId: id, messages: detail.messages })
      // 切换会话时同步角色卡：根据会话绑定的 characterCardId 切换当前角色卡，
      // 并通知桌宠窗口同步模型 + 表情/待机动作覆盖
      const charStore = useCharacterStore.getState()
      if (detail.characterCardId && detail.characterCardId !== charStore.currentCardId) {
        charStore.setCurrentCard(detail.characterCardId)
        const card = charStore.cards.find((c) => c.id === detail.characterCardId)
        api.app.setPetCard({
          modelId: card?.modelId ?? null,
          modelOverride: card?.modelOverride ?? null,
        })
      }
    } catch (err) {
      if (seq === loadSeq) console.error('加载会话失败', err)
    }
  },

  resetCurrentSession: () =>
    set({ currentSessionId: null, messages: [], streamingContent: '', streamError: null }),

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
        // 全部删光 → 回到空会话状态，发送首条消息时才新建持久化会话
        set({ currentSessionId: null, messages: [], streamError: null })
      }
    }
  },

  send: (content) =>
    new Promise<void>((resolve) => {
      void (async () => {
        const text = content.trim()
        if (!text || get().streaming) {
          resolve()
          return
        }

        // 尚无会话（首次发送 / 点「新建会话」后）→ 先惰性创建持久化会话，避免空会话堆积
        let { currentSessionId, messages } = get()
        if (!currentSessionId) {
          const cardId = useCharacterStore.getState().currentCardId
          if (!cardId) {
            resolve()
            return
          }
          try {
            const item = await api.session.create({ characterCardId: cardId })
            currentSessionId = item.id
            set((s) => ({ sessions: [item, ...s.sessions], currentSessionId: item.id }))
            messages = get().messages
          } catch (err) {
            console.error('创建会话失败', err)
            set({ streamError: err instanceof Error ? err.message : '创建会话失败' })
            resolve()
            return
          }
        }

        const userMsg: ChatMessage = { role: 'user', content: text, timestamp: Date.now() }
        const nextMessages = [...messages, userMsg]
        set({ messages: nextMessages, streaming: true, streamingContent: '', streamError: null })

        const isStillCurrent = () => get().currentSessionId === currentSessionId

        // 流式上屏合并（T2）：把多次 chunk 累积到本地缓冲，按 ~40ms 合并 flush 到
        // streamingContent，避免每个 token 都触发一次 React 全量重渲染，显著降低渲染开销。
        let streamBuffer = ''
        let streamFlushTimer: ReturnType<typeof setTimeout> | null = null
        const scheduleStreamFlush = () => {
          if (streamFlushTimer) return
          streamFlushTimer = setTimeout(() => {
            streamFlushTimer = null
            if (streamBuffer) {
              const buffered = streamBuffer
              streamBuffer = ''
              if (isStillCurrent()) set((s) => ({ streamingContent: s.streamingContent + buffered }))
            }
          }, 40)
        }
        // 清空定时器并立即 flush（流结束/错误/清理时调用，避免残留定时器触发过期 set）
        const flushStreamNow = () => {
          if (streamFlushTimer) {
            clearTimeout(streamFlushTimer)
            streamFlushTimer = null
          }
          streamBuffer = ''
        }

      function cleanup() {
        unsubscribeChunk()
        unsubscribeDone()
        unsubscribeError()
        flushStreamNow()
      }

      const unsubscribeChunk = api.ai.onStreamChunk((chunk) => {
        if (!isStillCurrent()) return
        streamBuffer += chunk
        scheduleStreamFlush()
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
      })()
    }),

  stop: () => api.ai.cancel(),

  onSessionsChanged: async () => {
    try {
      const sessions = await api.session.list()
      const { currentSessionId } = get()
      set({ sessions })
      if (currentSessionId && !sessions.some((s) => s.id === currentSessionId)) {
        // 当前会话被其他窗口（Data 面板）删除 → 回到空会话状态，发送首条消息时才新建
        set({ currentSessionId: null, messages: [], streamError: null })
      }
    } catch {
      // 忽略刷新失败
    }
  },
}))
