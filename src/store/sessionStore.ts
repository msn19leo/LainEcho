import { create } from 'zustand'
import { api } from '../api'
import type { ChatImage, ChatMessage, SessionIndexItem } from '../types'
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
  /** 当前会话消息修订号（主进程落盘权威值；重答卷标用它做乐观并发校验） */
  revision: number
  /** 重答准备/情景重建/重跑启动中：禁用发送与二次重答 */
  rewinding: boolean

  loadSessions: () => Promise<void>
  loadSession: (id: string) => Promise<void>
  deleteSession: (id: string) => Promise<void>
  /** 新建空会话：清空当前会话与消息；会话在发送首条消息时才真正持久化，避免空会话堆积 */
  resetCurrentSession: () => void
  /**
   * 确保当前有持久化会话（无则惰性创建），返回会话 id；无角色卡或创建失败返回 null。
   * 附件落盘需要会话目录，因此粘贴图片前就要先拿到 id（而不是等到发送时）。
   */
  ensureSession: () => Promise<string | null>
  /** 发送消息并驱动流式输出（无会话时先惰性创建再发送；传入 images 时为本轮附图） */
  send: (content: string, images?: ChatImage[]) => Promise<void>
  /** 消息重答（最后一轮）：重新回答，不编辑文本 */
  regenerate: () => Promise<void>
  /** 编辑并重发任意一条 user 消息：截断该消息及其后全部消息后重跑（不可撤销） */
  rewindEdit: (targetIndex: number, editText: string) => Promise<void>
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
/** 正在切换到的会话 id：切换期间旧会话的重答广播不得打断/作废这次切换 */
let loadTarget: string | null = null
/**
 * 本窗口刚乐观插入的 user 消息（内容 + 本地时刻）：仅用于 stream-user 幂等去重。
 * 不能用"末条 user 内容相同"做全局去重——编辑重发后新消息可能与存活历史里的某条同文；
 * 也不该把宠物窗发来的同文消息误判为重复。
 */
let pendingSend: { content: string; timestamp: number } | null = null
/** 一次会话惰性创建的在途请求（粘贴图片与发送可能同时触发，复用一个 Promise 防重复建会话） */
let ensureInFlight: Promise<string | null> | null = null

/**
 * 纯文本链路的图片占位：1 张 → `[图片]`，多张 → `[图片×N]`。
 * content 必须自带占位，否则桌宠窗/摘要/导出这些只读 content 的下游完全看不出有图。
 * 聊天窗渲染时会把这枚标记剥掉（图片缩略图已经表达了同一件事）。
 */
export function imagePlaceholder(count: number): string {
  return count === 1 ? '[图片]' : `[图片×${count}]`
}

/** 组装落盘的 user 文本：用户原文 + 图片占位（纯图时只有占位） */
export function composeUserContent(text: string, imageCount: number): string {
  if (imageCount <= 0) return text
  const mark = imagePlaceholder(imageCount)
  return text ? `${text} ${mark}` : mark
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  currentSessionId: null,
  messages: [],
  loading: false,
  streaming: false,
  streamingContent: '',
  streamError: null,
  revision: 0,
  rewinding: false,

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
    loadTarget = id
    pendingSend = null
    // 切换会话时重置流式与重答状态，避免上一个会话的流式内容串到新会话
    set({ streaming: false, streamingContent: '', streamError: null, rewinding: false })
    try {
      const detail = await api.session.get(id)
      if (seq !== loadSeq) return // 已有更新的切换请求，丢弃本次响应
      set({ currentSessionId: id, messages: detail.messages, revision: detail.revision ?? 0 })
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
    } finally {
      if (loadTarget === id) loadTarget = null
    }
  },

  resetCurrentSession: () => {
    // 作废在途 loadSession，避免旧会话响应把新空会话覆盖回去
    loadSeq += 1
    loadTarget = null
    pendingSend = null
    // 通知宠物窗内容框清空（新建空会话时保持两侧一致）
    api.app.notifyCurrentSession(null)
    return set({
      currentSessionId: null,
      messages: [],
      streamingContent: '',
      streamError: null,
      revision: 0,
      rewinding: false,
    })
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
        loadSeq += 1
        loadTarget = null
        pendingSend = null
        set({ currentSessionId: null, messages: [], streamError: null, revision: 0, rewinding: false })
      }
    }
  },

  ensureSession: async () => {
    const existing = get().currentSessionId
    if (existing) return existing
    // 并发保护：粘贴图片与发送可能同时触发创建，复用同一个在途请求
    if (ensureInFlight) return ensureInFlight
    ensureInFlight = (async () => {
      const cardId = useCharacterStore.getState().currentCardId
      if (!cardId) return null
      try {
        const item = await api.session.create({ characterCardId: cardId })
        set((s) => ({ sessions: [item, ...s.sessions], currentSessionId: item.id, revision: 0 }))
        // 通知宠物窗跟随新建的会话（内容框同步）
        api.app.notifyCurrentSession(item.id)
        return item.id
      } catch (err) {
        console.error('创建会话失败', err)
        set({ streamError: err instanceof Error ? err.message : '创建会话失败' })
        return null
      } finally {
        ensureInFlight = null
      }
    })()
    return ensureInFlight
  },

  send: (content, images) =>
    new Promise<void>((resolve) => {
      void (async () => {
        const text = content.trim()
        const hasImages = !!images?.length
        if ((!text && !hasImages) || get().streaming) {
          resolve()
          return
        }
        if (get().rewinding) {
          toast('正在处理上一条消息的重发，请稍候', 'info')
          resolve()
          return
        }

        // 尚无会话（首次发送 / 点「新建会话」后）→ 先惰性创建持久化会话，避免空会话堆积
        const currentSessionId = await get().ensureSession()
        if (!currentSessionId) {
          resolve()
          return
        }
        const { messages } = get()

        // 纯文本链路（桌宠窗/摘要/导出）靠 content 里的占位感知图片存在；聊天窗渲染时再剥掉
        const userMsg: ChatMessage = {
          role: 'user',
          content: composeUserContent(text, images?.length ?? 0),
          timestamp: Date.now(),
          ...(hasImages ? { images } : {}),
        }
        const nextMessages = [...messages, userMsg]
        pendingSend = { content: userMsg.content, timestamp: userMsg.timestamp ?? Date.now() }
        set({ messages: nextMessages, streaming: true, streamingContent: '', streamError: null })

        // 流式上屏、完成落定统一由 bindPersistentSessionSync 的持久订阅驱动（聊天窗/宠物窗两侧同步）
        // invoke 拒绝只剩「轮次从未开始」的前置拒绝（busy/校验/IPC 错误）——轮次执行失败时主进程
        // 返回 null、失败态由 stream-error 广播驱动。此处回滚本地预插入的 user 气泡（按引用精确
        // 移除，不覆盖并发更新），以 toast 提示代替失败横幅，避免与在途对账竞态产生黄→红闪变。
        api.ai.sendMessage({ sessionId: currentSessionId, messages: nextMessages }).catch((err) => {
          pendingSend = null
          useSessionStore.setState((s) => ({
            streaming: false,
            messages: s.messages.filter((m) => m !== userMsg),
          }))
          toast(err instanceof Error ? err.message : '消息发送失败', 'error')
        })
        resolve()
      })()
    }),

  regenerate: async () => {
    const { currentSessionId, streaming, rewinding, revision } = get()
    if (!currentSessionId || streaming || rewinding) return
    // 立即进入重答忙态：截断→摘要重建→重跑启动之间禁用发送/二次重答
    set({ rewinding: true })
    try {
      await api.ai.regenerate({ sessionId: currentSessionId, expectedRevision: revision })
    } catch (err) {
      set({ rewinding: false })
      const msg = err instanceof Error ? err.message : '重新回答失败'
      toast(msg, 'error')
      if (/会话已更新/.test(msg)) void get().loadSession(currentSessionId)
    }
  },

  rewindEdit: async (targetIndex, editText) => {
    const { currentSessionId, messages, streaming, rewinding, revision } = get()
    if (!currentSessionId) return
    if (streaming || rewinding) {
      toast('正在处理上一条消息的重发，请稍候', 'info')
      return
    }
    const target = messages[targetIndex]
    if (!target || target.role !== 'user' || target.meta?.proactive) {
      toast('该消息不可编辑', 'error')
      return
    }
    const text = editText.trim()
    if (!text) {
      toast('消息内容不能为空', 'error')
      return
    }
    set({ rewinding: true })
    try {
      await api.ai.rewindEdit({
        sessionId: currentSessionId,
        targetIndex,
        editText: text,
        expectedRevision: revision,
        ...(target.timestamp !== undefined ? { expectedTimestamp: target.timestamp } : {}),
        expectedContent: target.content,
      })
    } catch (err) {
      set({ rewinding: false })
      const msg = err instanceof Error ? err.message : '编辑重发失败'
      toast(msg, 'error')
      if (/会话已更新/.test(msg)) void get().loadSession(currentSessionId)
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
        loadSeq += 1
        loadTarget = null
        pendingSend = null
        set({ currentSessionId: null, messages: [], streamError: null, revision: 0, rewinding: false })
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
    useSessionStore.setState({ streaming: true, streamingContent: '', streamError: null, rewinding: false })
    // 幂等追加：仅当这条 user 正是本窗口刚刚乐观插入的那条时跳过，避免发起方收到自身广播时重复。
    // 不能只看"末条 user 内容相同"——编辑重发的新消息可能与存活历史里的某条同文。
    const last = st.messages[st.messages.length - 1]
    const isPendingEcho = !!pendingSend && last?.role === 'user' && last.content === payload.content && pendingSend.content === payload.content
    if (isPendingEcho) {
      pendingSend = null
      console.log('[bind] streamUser DUP 本窗乐观插入，跳过 usr=' + payload.content.slice(0, 12))
      return
    }
    pendingSend = null
    // 跟随窗口若尚未持有该会话（新会话首条会先广播 stream-user），从事件中即席采纳会话 id，
    // 让新会话的第一个用户气泡立即同步出现，无需等主进程 session:current 或 stream-done
    useSessionStore.setState((s) => ({
      currentSessionId: payload.sessionId,
      // revision 只对当前会话有意义：采纳的是别的会话（新会话首条消息）时必须归零，
      // 否则会把上一个会话的版本号带过来，新会话首轮 stream-done 被判成"旧轮"丢弃
      revision: s.currentSessionId === payload.sessionId ? s.revision : 0,
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
    if (!payload?.sessionId || isStoryRunId(payload.sessionId)) return
    // 静默丢弃是"streaming 永不复位"的最大嫌疑（按钮卡停止/回包不入列表/气泡消失），
    // 丢弃必须留痕：这两条是唯一会让 stream-done 无效而不报错的分支。
    if (payload.sessionId !== st.currentSessionId) {
      console.warn('[bind] stream-done IGNORE sid=%s cur=%s（会话不匹配 → streaming 不复位）', payload.sessionId, st.currentSessionId)
      return
    }
    // 迟到的旧轮完成事件（revision 已落后于当前会话）不得把已删除的 assistant 追回列表
    if (payload.revision !== undefined && payload.revision < st.revision) {
      console.warn('[bind] stream-done IGNORE sid=%s rev=%d < 本地rev=%d（旧轮 → streaming 不复位）', payload.sessionId, payload.revision, st.revision)
      return
    }
    pendingSend = null
    // ===== 原子落定 =====：streaming 复位与 assistant 消息入列表在同一次 setState。
    // 旧实现先复位 streaming、再等 session:get 往返回来才更新 messages——间隙里
    // 「末条是 user && !streaming」成立，失败提示横幅每轮收尾单帧闪现（2026-10-22 实锤），
    // 且 LastAiSlot 定型渲染会短暂取到上一轮旧回答。payload.message 是主进程已落盘的
    // assistant 消息，直接本地追加，间隙归零。
    useSessionStore.setState((s) => {
      const last = s.messages[s.messages.length - 1]
      const alreadySettled =
        !!payload.message && last?.role === 'assistant' && last.content === payload.message.content && last.timestamp === payload.message.timestamp
      if (alreadySettled) {
        return { streaming: false, streamError: null, rewinding: false, revision: Math.max(s.revision, payload.revision ?? s.revision) }
      }
      return {
        streaming: false,
        streamError: null,
        rewinding: false,
        revision: Math.max(s.revision, payload.revision ?? s.revision),
        messages: payload.message ? [...s.messages, payload.message] : s.messages,
      }
    })
    // 后台对账：拉磁盘权威状态（补 meta/error/句级字段等），失败静默不阻塞 UI。
    // 期间若已开新轮、切换会话或发生重答截断则放弃，防止旧快照覆盖新状态。
    void (async () => {
      try {
        const detail = await api.session.get(payload.sessionId!)
        const cur = useSessionStore.getState()
        if (cur.currentSessionId !== payload.sessionId || cur.streaming) return
        // 重答会推进 revision；磁盘快照比本地旧 → 丢弃（否则会把截断后的列表覆盖回旧轮）
        if ((detail.revision ?? 0) < cur.revision) return
        useSessionStore.setState({ messages: detail.messages, revision: detail.revision ?? cur.revision })
      } catch {
        // 对账失败不影响界面（本地已原子落定）
      }
      void refreshSessionIndex()
    })()
  })
  const unsubError = api.ai.onStreamError((payload) => {
    const st = useSessionStore.getState()
    if (!payload?.sessionId || isStoryRunId(payload.sessionId) || payload.sessionId !== st.currentSessionId) return
    // 迟到的旧轮失败事件不得把已删除的 user/partial 追回列表
    if (payload.revision !== undefined && payload.revision < st.revision) return
    pendingSend = null
    // ===== 原子对齐 =====：与主进程落盘的失败态在同一次 setState 内对齐——
    // user 消息就地替换为权威版本（error 具体原因 / meta.cancelled 标记），已流出部分收成的
    // assistant 气泡原子追加。中途不出现「末条=user 且无标记」的假失败间隙，提示条无闪变。
    useSessionStore.setState((s) => {
      let messages = s.messages
      const failedUser = payload.userMessage
      if (failedUser) {
        // 内容 + 时间戳（5s 容差）：send 的本地乐观时刻与主进程落盘时刻相差几毫秒；
        // 只看内容会在"编辑成与历史某条同文"时认错/漏补消息
        const sameTurnUser = (m: ChatMessage) =>
          m.role === 'user' &&
          m.content === failedUser.content &&
          (failedUser.timestamp == null ||
            m.timestamp == null ||
            Math.abs(m.timestamp - failedUser.timestamp) < 5000)
        const last = messages[messages.length - 1]
        if (last && sameTurnUser(last)) {
          // 本轮 user 已在本地（send/stream-user 预插入）：就地替换为落盘权威版本
          messages = [...messages.slice(0, -1), failedUser]
        } else if (!messages.some(sameTurnUser)) {
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
        rewinding: false,
        revision: Math.max(s.revision, payload.revision ?? s.revision),
        // 主动取消（停止）不算错误，不展示红色错误条；meta.cancelled 标记让「未收到回复」提示同样豁免
        streamError: payload.cancelled ? null : payload.error,
      }
    })
    // 失败轮已落盘（user 带 error / partial assistant）：后台补一次 revision，
    // 否则紧接着的编辑重发可能用旧 revision 被主进程拒绝。重答广播若先到会推进 revision，此处自动放弃。
    const revAt = useSessionStore.getState().revision
    void api.session
      .get(payload.sessionId)
      .then((detail) => {
        const cur = useSessionStore.getState()
        if (cur.currentSessionId !== payload.sessionId || cur.streaming || cur.revision !== revAt) return
        useSessionStore.setState({ revision: detail.revision ?? cur.revision })
      })
      .catch(() => {})
    void refreshSessionIndex()
  })
  // ===== 消息重答：会话截断广播 =====
  // 两窗用磁盘最新消息列表整体替换本地（被删轮次气泡消失），随后的 ai:stream-user
  // 按既有链路补上重发/重跑的用户气泡。删除不可撤销。
  const unsubRewound = api.ai.onSessionRewound((payload) => {
    const st = useSessionStore.getState()
    if (!payload?.sessionId || isStoryRunId(payload.sessionId) || payload.sessionId !== st.currentSessionId) return
    // 正在切到别的会话：旧会话的重答广播不得作废这次切换（loadSession 的 seq 校验会被打断）
    if (loadTarget && loadTarget !== payload.sessionId) return
    // 迟到的截断广播不得覆盖更新的会话状态
    if (payload.revision !== undefined && payload.revision < st.revision) return
    // 打断在途 loadSession，避免它把旧快照写回截断后的列表
    loadSeq += 1
    pendingSend = null
    useSessionStore.setState({
      currentSessionId: payload.sessionId,
      messages: payload.messages ?? [],
      revision: Math.max(st.revision, payload.revision ?? st.revision),
      streaming: false,
      streamingContent: '',
      streamError: null,
      rewinding: true,
    })
  })

  return () => {
    unsubUser()
    unsubDone()
    unsubError()
    unsubRewound()
  }
}
