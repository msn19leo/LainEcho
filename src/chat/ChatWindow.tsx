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
import { useCharacterStore } from '../store/characterStore'
import { useSessionStore } from '../store/sessionStore'
import { MessageList } from './MessageList'
import { InputArea } from './InputArea'
import { SessionSidebar } from './SessionSidebar'
import { toast } from '../components/toast'

/**
 * 流式分句配置（方案 B）：
 * - SENTENCE_BOUNDARY：匹配到第一个句子结束标点为止（中文/日文标点 + 换行）
 * - MIN_FLUSH_LENGTH：最小触发长度。短于此长度的句子会累积到下一个标点，
 *   避免短句（如"嗯。""好。"）单独合成导致 MiMo 情感断裂、语速不稳。
 *   提高至 25，让每句更长，单次合成内容更完整，情感更连贯，同时减少合成请求次数。
 * - LONG_REPLY_THRESHOLD：方案 B 阈值。流式初期先缓冲累积文本，
 *   超过此长度才判定为「长回复」并切换到分句模式（边流式边合成，低延迟）；
 *   未超过则一直缓冲，流式结束时整段合成（情感更连贯）。
 *   提高至 100，让更多中等长度回复整段合成（情感连贯），真正长回复才分句降延迟。
 */
const SENTENCE_BOUNDARY = /^(.+?[。！？；\n])/
const MIN_FLUSH_LENGTH = 25
const LONG_REPLY_THRESHOLD = 100

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

  // 其他窗口（设置面板）增删改角色卡时的跨窗口同步
  useEffect(() => {
    const unsub = api.characterCard.onChanged(() => {
      void loadCards()
    })
    return unsub
  }, [loadCards])

  // 流式分句 TTS（方案 B）：
  // - 流式初期先缓冲累积文本，超过 LONG_REPLY_THRESHOLD 才切换分句模式；
  //   短回复一直缓冲，流式结束时整段合成（情感连贯）；长回复分句合成（低延迟）。
  // - 短句（< MIN_FLUSH_LENGTH）累积到足够长度再发送，避免情感断裂、语速不稳。
  useEffect(() => {
    // 累积的全部流式文本
    const accRef = { text: '' }
    // 已从 accRef.text 中提取（消费）的位置
    let consumedPos = 0
    // 已提取但太短未发送的累积句子（等待合并到足够长度）
    const pendingShortRef = { text: '' }
    // 方案 B：当前模式。buffering = 缓冲累积；streaming = 已切换分句
    let mode: 'buffering' | 'streaming' = 'buffering'
    // 本轮流式的 TTS 上下文（首次 chunk 时惰性初始化）
    let ttsCtx: { voiceId: string; languageOverride: import('../types').TTSLanguage | null } | null = null

    // 初始化 TTS 上下文：读取角色卡 voiceId / ttsOverride 和 TTS autoPlay 配置（每轮流式只读一次）
    async function ensureTtsCtx(): Promise<{ voiceId: string; languageOverride: import('../types').TTSLanguage | null } | null> {
      if (ttsCtx) return ttsCtx
      const state = useCharacterStore.getState()
      const card = state.cards.find((c) => c.id === state.currentCardId)
      if (!card?.voiceId) return null
      try {
        const ttsConfig = await api.tts.getConfig()
        // 角色级 autoPlay 覆盖：ttsOverride.autoPlay 非 null 时优先于全局
        const autoPlay = card.ttsOverride?.autoPlay ?? ttsConfig.autoPlay
        if (!autoPlay) return null
      } catch {
        return null
      }
      // 角色级语言覆盖：ttsOverride.language 非 null 时优先于全局
      ttsCtx = { voiceId: card.voiceId, languageOverride: card.ttsOverride?.language ?? null }
      return ttsCtx
    }

    // 移除括号/方括号中的动作描写内容（角色扮演中的旁白）
    // 这些内容用于屏幕阅读/视觉表达，不应被读成语音。
    // 用非贪婪匹配 + s 标志，让 . 也匹配换行。
    function stripBrackets(text: string): string {
      return text
        .replace(/[（(].*?[）)]/gs, '')   // 中文/英文圆括号
        .replace(/【.*?】/gs, '')          // 中文方括号
        .replace(/\[.*?\]/gs, '')          // 英文方括号
        .replace(/\s+/g, ' ')              // 多空格合并
        .trim()
    }

    // 将文本发送给桌宠窗口合成播放
    function flush(text: string): void {
      const cleaned = stripBrackets(text)
      if (!cleaned || !ttsCtx) return
      api.app.speak(cleaned, ttsCtx.voiceId, ttsCtx.languageOverride)
    }

    // 判断文本是否值得发送：过滤括号后还有足够长度
    // 避免全是括号动作描写的短句（如"（笑）"）也被累积合成
    function isFlushedCandidate(text: string): boolean {
      return stripBrackets(text).length >= MIN_FLUSH_LENGTH
    }

    // 监听流式 chunk：累积文本，按标点切句，短句累积到 MIN_FLUSH_LENGTH 再发送。
    // 方案 B：流式初期先缓冲（buffering 模式），累积超过 LONG_REPLY_THRESHOLD 才切换分句模式。
    const unsubChunk = api.ai.onStreamChunk((chunk: string) => {
      accRef.text += chunk
      void ensureTtsCtx().then((ctx) => {
        if (!ctx) return
        // 方案 B：缓冲模式。短回复（< 阈值）一直缓冲，流式结束时整段合成；
        // 累积超过阈值才切换到分句模式（边流式边合成，降低长回复延迟）。
        if (mode === 'buffering') {
          const buffered = accRef.text.slice(consumedPos)
          if (buffered.length < LONG_REPLY_THRESHOLD) {
            return // 继续缓冲，不分句
          }
          // 切换到分句模式：consumedPos 未变，下方 while 会从头切分已累积文本
          mode = 'streaming'
        }
        // 从已消费位置开始，循环提取完整句子（一次 chunk 可能含多个标点）
        while (true) {
          const remaining = accRef.text.slice(consumedPos)
          const match = remaining.match(SENTENCE_BOUNDARY)
          if (!match || !match[1]) break

          const sentence = match[1]
          // 合并之前累积的短句
          const candidate = pendingShortRef.text + sentence

          // 长度判断用清洗后的文本（剔除括号动作描写），避免"（笑）"等纯动作
          // 被单独触发合成，也避免括号内长内容污染长度的判断
          if (isFlushedCandidate(candidate)) {
            // 达到最小长度，发送
            flush(candidate)
            pendingShortRef.text = ''
          } else {
            // 太短或纯括号动作，累积等待下一次
            pendingShortRef.text = candidate
          }
          // 无论是否发送，这段文本都已从 accRef 中消费
          consumedPos += match[0].length
        }
      })
    })

    // 流式完成：把所有剩余未发送的文本（累积的短句 + 无标点的尾巴）一起发送。
    // 方案 B 兜底：短回复（一直 buffering）此处整段合成；长回复（streaming）发送最后尾巴。
    const unsubDone = api.ai.onStreamDone(() => {
      if (ttsCtx) {
        const remaining = accRef.text.slice(consumedPos)
        const combined = pendingShortRef.text + remaining
        if (combined.trim()) {
          flush(combined)
        }
        pendingShortRef.text = ''
      }
      // 重置本轮状态
      accRef.text = ''
      consumedPos = 0
      mode = 'buffering'
      ttsCtx = null
    })

    // 流式错误/取消：清空状态
    const unsubError = api.ai.onStreamError(() => {
      accRef.text = ''
      consumedPos = 0
      pendingShortRef.text = ''
      mode = 'buffering'
      ttsCtx = null
    })

    return () => {
      unsubChunk()
      unsubDone()
      unsubError()
    }
  }, [])

  // 切换角色卡：同步桌宠模型 + 表情/待机动作覆盖 + 清空当前会话（首条消息时才新建持久化会话）
  const handleCardChange = async (cardId: string) => {
    setCurrentCard(cardId)
    const card = cards.find((c) => c.id === cardId)
    api.app.setPetCard({
      modelId: card?.modelId ?? null,
      modelOverride: card?.modelOverride ?? null,
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
              className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-md)] border border-border text-text-2 transition-colors hover:border-border-strong hover:text-text"
            >
              <SettingsIcon size={15} strokeWidth={1.75} />
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