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
import { bindPersistentSessionSync, useSessionStore } from '../store/sessionStore'
import { MessageList } from './MessageList'
import { InputArea } from './InputArea'
import { SessionSidebar } from './SessionSidebar'
import { toast } from '../components/toast'

/**
 * 流式分句配置（平衡版）：
 * - SENTENCE_BOUNDARY：匹配到第一个句子结束标点为止（中文/日文标点 + 换行）
 * - MIN_FLUSH_LENGTH：合并触发长度。短于此长度的句子会累积到下一个标点，合并到足够长再合成。
 *   MiMo 是非流式、逐请求合成，每次请求有固定延迟且独立无上下文——
 *   段太短会：请求过多变慢、单段语速/情感随机波动（一句快一句慢）、
 *   播放时长 < 下一段合成时长导致句间空档。
 *   调到 40（约 1~2 个完整句子）：
 *     - 长回复：首段 ~40 字即开口（不用等流式结束），后续段更少更连贯；
 *     - 短回复：整段合成一次，情感连贯；
 *     - 每段播放时长能覆盖下一段合成，消除句间空档。
 */
const SENTENCE_BOUNDARY = /^(.+?[。！？；\n])/
const MIN_FLUSH_LENGTH = 40

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
  /** 当前朗读到的合成分段索引（pet 段级播放时上报，用于聊天窗高亮当前段） */
  const [activeChunk, setActiveChunk] = useState<number | null>(null)

  // 持久订阅 AI 流式/完成事件，驱动会话消息流式上屏与完成落定（与宠物窗同步）
  useEffect(() => bindPersistentSessionSync(), [])

  // 订阅"当前朗读合成分段"（桌宠段级播放时经主进程转发），用于聊天窗高亮该段
  useEffect(() => api.pet.onChunkActive(setActiveChunk), [])
  // 新一轮回复开始时清空高亮，避免上一轮（尤其无语音时）的高亮残留
  useEffect(() => {
    if (streaming) setActiveChunk(null)
  }, [streaming])

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
    // 本轮流式的 TTS 上下文（首次 chunk 时惰性初始化）
    let ttsCtx: { voiceId: string; languageOverride: import('../types').TTSLanguage | null } | null = null
    // V2：是否已尝试初始化 TTS 上下文。即使结果为空（未配置语音/autoPlay 关闭）也只查一次，
    // 避免每 chunk 都重复走 getConfig IPC。
    let ttsChecked = false

    // 初始化 TTS 上下文：读取角色卡 voiceId / ttsOverride 和 TTS autoPlay 配置（每轮流式只查一次）
    async function ensureTtsCtx(): Promise<{ voiceId: string; languageOverride: import('../types').TTSLanguage | null } | null> {
      if (ttsChecked) return ttsCtx
      ttsChecked = true
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

    // 将语音统一在 onStreamDone 按主进程句子表触发；流式中只即时显示文本，不逐句合成
    function flush(_text: string): void {
      if (!ttsCtx) return
    }

    // 判断文本是否值得发送：过滤括号后还有足够长度
    // 避免全是括号动作描写的短句（如"（笑）"）也被累积合成
    function isFlushedCandidate(text: string): boolean {
      return stripBrackets(text).length >= MIN_FLUSH_LENGTH
    }

    // 从已消费位置开始，循环提取完整句子并发送（一次 chunk 可能含多个标点）。
    // V1 快速优先：收到完整句子即按 MIN_FLUSH_LENGTH 判定发送，不再缓冲等待。
    const processAccumulated = () => {
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
    }

    // 监听流式 chunk：累积文本，按标点切句，短句累积到 MIN_FLUSH_LENGTH 再发送。
    const unsubChunk = api.ai.onStreamChunk((chunk: string) => {
      accRef.text += chunk
      // 已初始化上下文直接同步处理；首 chunk 未初始化时异步初始化一次；
      // 若已检查过且未启用语音（ttsChecked 后 ctx 为空）则无需处理。
      if (ttsCtx) {
        processAccumulated()
      } else if (!ttsChecked) {
        void ensureTtsCtx().then((ctx) => {
          if (ctx) processAccumulated()
        })
      }
    })

    // 流式完成：文本由持久同步落定；语音由主进程在 stream-done 时直接触发桌宠（此处不再调 speak）
    const unsubDone = api.ai.onStreamDone(() => {
      // 重置本轮状态
      accRef.text = ''
      consumedPos = 0
      pendingShortRef.text = ''
      ttsCtx = null
      ttsChecked = false
    })

    // 流式错误/取消：清空状态
    const unsubError = api.ai.onStreamError(() => {
      accRef.text = ''
      consumedPos = 0
      pendingShortRef.text = ''
      ttsCtx = null
      ttsChecked = false
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
        <MessageList activeChunk={activeChunk} />

        {/* 输入区 */}
        <InputArea />
      </FloatingDock>
    </div>
  )
}