import { create } from 'zustand'
import { api } from '../api'
import type { ChatMessage, SessionIndexItem } from '../types'
import { useCharacterStore } from './characterStore'
import { toast } from '../components/toast'

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
  /**
   * 消息重答（最后一轮）：editText 非空 = 编辑并重发；为空 = 重新回答。
   * 主进程截断最后一轮（广播 ai:session-rewound 由订阅同步两窗）后重跑正常聊天链路。
   */
  regenerate: (editText?: string) => Promise<void>
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
      // 并通知桌宠窗口同步模型 + 表情/待机动作覆盖。
      // 必须无条件广播，不能以聊天窗自身 currentCardId 判同跳过——聊天窗重开后
      // currentCardId 会静默回退到 cards[0]，宠物窗独立存活可能停在其他卡，
      // "同卡" 守卫一旦跳过就会造成两侧角色名不一致（宠物窗头部/名牌显示旧卡）
      if (detail.characterCardId) {
        const charStore = useCharacterStore.getState()
        charStore.setCurrentCard(detail.characterCardId)
        const card = charStore.cards.find((c) => c.id === detail.characterCardId)
        api.app.setPetCard({
          cardId: detail.characterCardId,
          modelId: card?.modelId ?? null,
          renderMode: card?.renderMode ?? null,
          spriteId: card?.spriteId ?? null,
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
        // invoke 拒绝只剩「轮次从未开始」的前置拒绝（busy/校验/IPC 错误）——轮次执行失败时主进程
        // 返回 null、失败态由 stream-error 广播驱动。此处回滚本地预插入的 user 气泡（按引用精确
        // 移除，不覆盖并发更新），以 toast 提示代替失败横幅，避免与在途对账竞态产生黄→红闪变。
        api.ai.sendMessage({ sessionId: currentSessionId, messages: nextMessages }).catch((err) => {
          useSessionStore.setState((s) => ({
            streaming: false,
            messages: s.messages.filter((m) => m !== userMsg),
          }))
          toast(err instanceof Error ? err.message : '消息发送失败', 'error')
        })
        resolve()
      })()
    }),

  regenerate: async (editText) => {
    const { currentSessionId, streaming } = get()
    if (!currentSessionId || streaming) return
    try {
      await api.ai.regenerate({ sessionId: currentSessionId, editText: editText?.trim() || undefined })
    } catch (err) {
      // 失败（如轮次进行中被主进程拒绝）不中断界面；重答链路无流式态需要复位
      console.error('重新回答失败', err)
    }
  },

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
  // 剧情 run 不是聊天会话：聊天/宠物窗对 storyrun_* 的事件一律忽略（防误认领导致 session:get 报错）
  const isStoryRunId = (id?: string | null) => !!id && id.startsWith('storyrun_')
  const unsubUser = api.ai.onStreamUser((payload) => {
    const st = useSessionStore.getState()
    if (!payload?.sessionId || isStoryRunId(payload.sessionId)) return
    // 若当前已持有其它会话，则忽略属于别的新会话的流式事件（避免串台）
    if (st.currentSessionId && st.currentSessionId !== payload.sessionId) {
      console.log('[bind] streamUser IGNORE sid=' + payload?.sessionId, 'cur=' + st.currentSessionId)
      return
    }
    // 镜像窗口从收到 stream-user 起就进入 streaming 态，与发起方 send() 的本地状态对齐：
    // 否则在"用户气泡已上屏、首个 chunk 未到"的 LLM 延迟窗口内，镜像窗口会因
    // 「末条是用户消息 && !streaming」误判为发送失败，弹出黄色"未收到回复"警告。
    // 主进程保证 stream-user 之后必有 stream-chunk/done/error 之一复位该状态。
    // 同时清空上一轮残留的 streamingContent（发起方在 send() 里同样清空），避免镜像流式首块拼上旧文。
    useSessionStore.setState({ streaming: true, streamingContent: '', streamError: null })
    // 幂等追加：仅在 messages 末尾还没有这条 user 消息时补上，避免发起方收到自身广播时重复
    const last = st.messages[st.messages.length - 1]
    if (last?.role === 'user' && last.content === payload.content) {
      console.log('[bind] streamUser DUP 已存在，跳过 usr=' + payload.content.slice(0, 12))
      return
    }
    // 跟随窗口若尚未持有该会话（新会话首条会先广播 stream-user），从事件中即席采纳会话 id，
    // 让新会话的第一个用户气泡立即同步出现，无需等主进程 session:current 或 stream-done
    useSessionStore.setState((s) => ({
      currentSessionId: payload.sessionId,
      messages: [
        ...s.messages,
        { role: 'user', content: payload.content, timestamp: payload.timestamp, meta: payload.meta ?? undefined },
      ],
    }))
    console.log('[bind] streamUser ADD usr=' + payload.content.slice(0, 12))
  })
  // ===== 方案A第3步：旧直播链退役 =====
  // 已删除：onActiveSession 认领补发（快照拉取取代）、onStreamChunk 增量消费（快照取代）。
  // 保留：streamUser（用户气泡即时同步，非直播显示职责）、streamDone（落盘拉取）、
  //       streamError（错误态）——这三者属于会话编排，不属于直播显示。
  const unsubDone = api.ai.onStreamDone((payload) => {
    const st = useSessionStore.getState()
    if (!payload?.sessionId || isStoryRunId(payload.sessionId) || payload.sessionId !== st.currentSessionId) return
    // ===== 原子落定 =====：streaming 复位与 assistant 消息入列表在同一次 setState。
    // 旧实现先复位 streaming、再等 session:get 往返回来才更新 messages——间隙里
    // 「末条是 user && !streaming」成立，失败提示横幅每轮收尾单帧闪现（2026-10-22 实锤），
    // 且 LastAiSlot 定型渲染会短暂取到上一轮旧回答。payload.message 是主进程已落盘的
    // assistant 消息，直接本地追加，间隙归零。
    useSessionStore.setState((s) => {
      const last = s.messages[s.messages.length - 1]
      const alreadySettled =
        !!payload.message && last?.role === 'assistant' && last.content === payload.message.content && last.timestamp === payload.message.timestamp
      if (alreadySettled) return { streaming: false, streamError: null }
      return {
        streaming: false,
        streamError: null,
        messages: payload.message ? [...s.messages, payload.message] : s.messages,
      }
    })
    // 后台对账：拉磁盘权威状态（补 meta/error/句级字段等），失败静默不阻塞 UI。
    // 期间若已开新轮或切换会话则放弃（新轮自己的 done 会再对账），防止旧快照覆盖新状态。
    void (async () => {
      try {
        const detail = await api.session.get(payload.sessionId!)
        const cur = useSessionStore.getState()
        if (cur.currentSessionId !== payload.sessionId || cur.streaming) return
        useSessionStore.setState({ messages: detail.messages })
      } catch {
        // 对账失败不影响界面（本地已原子落定）
      }
      void refreshSessionIndex()
    })()
  })
  const unsubError = api.ai.onStreamError((payload) => {
    const st = useSessionStore.getState()
    if (!payload?.sessionId || isStoryRunId(payload.sessionId) || payload.sessionId !== st.currentSessionId) return
    // ===== 原子对齐 =====：与主进程落盘的失败态在同一次 setState 内对齐——
    // user 消息就地替换为权威版本（error 具体原因 / meta.cancelled 标记），已流出部分收成的
    // assistant 气泡原子追加。中途不出现「末条=user 且无标记」的假失败间隙，提示条无闪变。
    useSessionStore.setState((s) => {
      let messages = s.messages
      const failedUser = payload.userMessage
      if (failedUser) {
        const last = messages[messages.length - 1]
        if (last?.role === 'user' && last.content === failedUser.content) {
          // 本轮 user 已在本地（send/stream-user 预插入）：就地替换为落盘权威版本
          messages = [...messages.slice(0, -1), failedUser]
        } else if (!messages.some((m) => m.role === 'user' && m.content === failedUser.content)) {
          // 本地缺用户气泡（中途开窗才收到失败广播）：补上
          messages = [...messages, failedUser]
        }
      }
      if (payload.partialMessage) {
        // 已流出的部分收成 assistant 气泡：失败后已流出的文本不消失，LastAiSlot 定型渲染有据可依
        messages = [...messages, payload.partialMessage]
      }
      return {
        messages,
        streaming: false,
        // 主动取消（停止）不算错误，不展示红色错误条；meta.cancelled 标记让「未收到回复」提示同样豁免
        streamError: payload.cancelled ? null : payload.error,
      }
    })
    void refreshSessionIndex()
  })
  // ===== 消息重答：会话截断广播（ai:regenerate 删除最后一轮后）=====
  // 两窗用磁盘最新消息列表整体替换本地（旧轮 user+assistant 气泡消失），
  // 随后的 ai:stream-user 按既有链路补上重发/重跑的用户气泡
  const unsubRewound = api.ai.onSessionRewound((payload) => {
    const st = useSessionStore.getState()
    if (!payload?.sessionId || isStoryRunId(payload.sessionId) || payload.sessionId !== st.currentSessionId) return
    useSessionStore.setState({ messages: payload.messages ?? [], streaming: false, streamingContent: '', streamError: null })
  })
  return () => {
    unsubUser()
    unsubDone()
    unsubError()
    unsubRewound()
  }
}
