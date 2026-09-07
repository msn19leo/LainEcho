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
      // 通知宠物窗跟随切换会话（内容框同步）
      api.app.notifyCurrentSession(id)
      // 切换会话时同步角色卡：根据会话绑定的 characterCardId 切换当前角色卡，
      // 并通知桌宠窗口同步模型 + 表情/待机动作覆盖
      const charStore = useCharacterStore.getState()
      if (detail.characterCardId && detail.characterCardId !== charStore.currentCardId) {
        charStore.setCurrentCard(detail.characterCardId)
        const card = charStore.cards.find((c) => c.id === detail.characterCardId)
        api.app.setPetCard({
          cardId: detail.characterCardId,
          modelId: card?.modelId ?? null,
          modelOverride: card?.modelOverride ?? null,
          renderMode: card?.renderMode ?? null,
          spriteId: card?.spriteId ?? null,
          emotionMap: card?.emotionMap ?? null,
          live2dExpressionMap: card?.live2dExpressionMap ?? null,
        })
      }
    } catch (err) {
      if (seq === loadSeq) console.error('加载会话失败', err)
    }
  },

  resetCurrentSession: () => {
    // 通知宠物窗内容框清空（新建空会话时保持两侧一致）
    api.app.notifyCurrentSession(null)
    return set({ currentSessionId: null, messages: [], streamingContent: '', streamError: null })
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
            // 通知宠物窗跟随新建的会话（内容框同步）
            api.app.notifyCurrentSession(item.id)
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

        // 流式上屏、完成落定统一由 bindPersistentSessionSync 的持久订阅驱动（聊天窗/宠物窗两侧同步）
        api.ai.sendMessage({ sessionId: currentSessionId, messages: nextMessages }).catch((err) => {
          set({ streaming: false, streamError: err instanceof Error ? err.message : '消息发送失败' })
        })
        resolve()
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

/**
 * 持久订阅 AI 流式/完成/错误事件，统一驱动会话消息的流式上屏与完成落定。
 * 聊天窗、宠物窗各注册一次，保证两侧会话视图同步（无论哪一端发起发送）：
 * - stream-chunk：追加到 streamingContent（非发起方在本轮首块时重置，实现镜像流式）；
 * - stream-done：从主进程拉取该会话已落定的完整消息（含本轮 user+assistant），避免增量去重；
 * - stream-error：把已流出的部分收成一条 assistant 消息并展示错误（主动取消不报错）。
 * 返回取消订阅函数。
 */
export function bindPersistentSessionSync(): () => void {
  const unsubUser = api.ai.onStreamUser((payload) => {
    const st = useSessionStore.getState()
    if (!payload?.sessionId) return
    // 若当前已持有其它会话，则忽略属于别的新会话的流式事件（避免串台）
    if (st.currentSessionId && st.currentSessionId !== payload.sessionId) {
      console.log('[bind] streamUser IGNORE sid=' + payload?.sessionId, 'cur=' + st.currentSessionId)
      return
    }
    // 幂等追加：仅在 messages 末尾还没有这条 user 消息时补上，避免发起方收到自身广播时重复
    const last = st.messages[st.messages.length - 1]
    if (last?.role === 'user' && last.content === payload.content) return
    // 跟随窗口若尚未持有该会话（新会话首条会先广播 stream-user），从事件中即席采纳会话 id，
    // 让新会话的第一个用户气泡立即同步出现，无需等主进程 session:current 或 stream-done
    useSessionStore.setState((s) => ({
      currentSessionId: payload.sessionId,
      messages: [...s.messages, { role: 'user', content: payload.content, timestamp: payload.timestamp }],
    }))
    console.log('[bind] streamUser ADD usr=' + payload.content.slice(0, 12))
  })
  const unsubActive = api.ai.onActiveSession((sessionId) => {
    // 仅认领：本地尚未持有会话、且主进程确实有进行中的流时，才拉取该会话补上漏掉的轮次。
    // 本地已有会话（无论是否等于该 id）一律忽略，绝不顶掉用户正看的会话。
    if (!sessionId) return
    const st = useSessionStore.getState()
    if (st.currentSessionId) return
    void useSessionStore.getState().loadSession(sessionId)
  })
  const unsubChunk = api.ai.onStreamChunk((delta) => {
    const st = useSessionStore.getState()
    if (!st.currentSessionId) return
    // 非发起方的镜像：本轮首块时重置流式内容
    const base = st.streaming ? st.streamingContent : ''
    useSessionStore.setState({ streaming: true, streamError: null, streamingContent: base + (delta ?? '') })
  })
  const unsubDone = api.ai.onStreamDone((payload) => {
    const st = useSessionStore.getState()
    if (!payload?.sessionId || payload.sessionId !== st.currentSessionId) return
    void (async () => {
      useSessionStore.setState({ streaming: false })
      try {
        const detail = await api.session.get(payload.sessionId!)
        useSessionStore.setState({ messages: detail.messages, streamError: null })
        console.log('[bind] DONE setMsg=' + detail.messages.length, 'usr=' + detail.messages.filter((m) => m.role === 'user').length)
      } catch {
        // 拉取失败：仍清空流式状态，不阻塞
      }
      void refreshSessionIndex()
    })()
  })
  const unsubError = api.ai.onStreamError((payload) => {
    const st = useSessionStore.getState()
    if (!payload?.sessionId || payload.sessionId !== st.currentSessionId) return
    useSessionStore.setState((s) => {
      const partial = s.streamingContent
      const appended = partial
        ? [...s.messages, { role: 'assistant' as const, content: partial, timestamp: Date.now() }]
        : s.messages
      return {
        messages: appended,
        streaming: false,
        // 保留已流出的部分用于"揭示完再落定"：错误/停止后文字仍按设置速度揭示完再切定型
        streamingContent: partial,
        // 主动取消（停止）不算错误，不展示红色错误条
        streamError: payload.cancelled ? null : payload.error,
      }
    })
    void refreshSessionIndex()
  })
  return () => {
    unsubUser()
    unsubActive()
    unsubChunk()
    unsubDone()
    unsubError()
  }
}
