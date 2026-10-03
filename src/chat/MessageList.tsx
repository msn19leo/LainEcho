/**
 * 消息流（airi 风格竖向对话流）。
 *
 * 设计：
 *   - 用户消息靠右（气泡右对齐）：品牌纯色底（深色青 / 浅色淡蓝）+ 主色光晕，文字左对齐。
 *   - AI 消息靠左：毛玻璃卡片 + 主色调边框。
 *   - 流式输出带流光打字机光标（.streaming-cursor，见 index.css）。
 *   - 消息出现使用 popSlideUp 弹性入场（scale 0.96 + y 12，0.4s 弹性曲线），逐条轻微错落。
 *   - 滚动优化（T3）：新消息/流式更新仅在用户接近底部时自动滚到底，且用瞬时滚动替代
 *     smooth，避免每个 token 都做一次平滑滚动造成卡顿。
 *   - 末条 AI 由常驻槽位（LastAiSlot）接管：roundActive 期间定型行不再由 map 渲染，
 *     直播（流式/跟读）与定型两个阶段在同一槽位内切换，不经历「卸载 → 重挂载」，
 *     从根上消除回答收尾时入场动画重播造成的气泡闪烁。
 */
import { Fragment, useEffect, useRef, useState, type RefObject } from 'react'
import { motion } from 'framer-motion'
import { AlertTriangle } from 'lucide-react'
import { useSessionStore } from '../store/sessionStore'
import { useCharacterStore } from '../store/characterStore'
import { useChatReadingStore } from './readingStore'
import { typingSpeedToMs, useSettingsStore } from '../store/settingsStore'
import { Typewriter } from '../components/Typewriter'
import { cn, formatTime, splitSentences } from '../lib/utils'
import { useAutoScrollBottom } from '../lib/useAutoScrollBottom'
import type { ChatMessage, DialogueChunk } from '../types'
import { popSlideUp, springElastic } from '../lib/motion'

/** 距底部小于该阈值视为"接近底部"，此时才自动跟随滚动 */
const NEAR_BOTTOM_THRESHOLD = 80

export function MessageList() {
  // 逐字速度由独立的 LastAiSlot 组件内部读取（见函数 LastAiSlot）
  const messages = useSessionStore((s) => s.messages)
  // 顶层订阅直播源：仅用于 roundActive 上升沿判定（本轮是否开始过）
  const streamingContent = useSessionStore((s) => s.streamingContent)
  const streaming = useSessionStore((s) => s.streaming)
  const streamError = useSessionStore((s) => s.streamError)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const currentCardName = useCurrentCardName()
  const readingActive = useChatReadingStore((s) => s.readingActive)
  // 跟读文本（宠物窗 displayedText 镜像）：非空说明本轮已有前置旁白/跟读内容上屏
  const readingText = useChatReadingStore((s) => s.text)
  const listRef = useRef<HTMLDivElement>(null)
  /** 内容区外层（观测其实际高度以在打字机/流式增长时自动滚到底） */
  const contentRef = useRef<HTMLDivElement>(null)
  const nearBottomRef = useRef(true)

  /** 最后一条 AI 消息（用于按需分段展示合成分段，便于阅读） */
  const lastAssistantIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === 'assistant') return i
    }
    return -1
  })()

  /**
   * 本轮活跃标记：自本视图内第一轮流式/直播内容出现起为 true，
   * 期间末条 AI 消息交给 LastAiSlot 接管（map 跳过）；
   * 切换会话时重置（渲染期间调整，避免重置落后一帧）。
   */
  const [roundSession, setRoundSession] = useState(currentSessionId)
  const [roundActive, setRoundActive] = useState(false)
  if (roundSession !== currentSessionId) {
    setRoundSession(currentSessionId)
    setRoundActive(false)
  }
  useEffect(() => {
    if (streaming || readingActive || readingText.length > 0 || streamingContent.length > 0) {
      setRoundActive(true)
    }
  }, [streaming, readingActive, readingText, streamingContent])

  // 监听滚动：用户上翻看历史时不强制拉回底部
  const onScroll = () => {
    const el = listRef.current
    if (!el) return
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_THRESHOLD
  }

  // 内容高度增长（含打字机逐字 reveal、流式、跟读追加段）时自动滚到底；
  // 仅在用户接近底部时跟随，尊重其上翻历史
  useAutoScrollBottom(listRef, contentRef, nearBottomRef, [messages, streaming, streamError])

  if (messages.length === 0 && !streaming) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-8" style={{ background: 'var(--bg-base)' }}>
        <motion.div
          initial={{ opacity: 0, scale: 0.92 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.4, ease: springElastic }}
          className="text-center"
        >
          <motion.div
            className="mb-3 text-4xl"
            animate={{ y: [0, -7, 0] }}
            transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
          >
            👋
          </motion.div>
          <p className="text-sm font-medium text-text-2">
            和 {currentCardName || '桌宠'} 打个招呼吧
          </p>
          <p className="mt-1.5 text-xs text-text-muted">发送第一条消息，开启与桌宠的对话</p>
        </motion.div>
      </div>
    )
  }

  return (
    <div ref={listRef} onScroll={onScroll} className="flex-1 overflow-y-auto px-4 py-4" style={{ background: 'var(--bg-base)' }}>
      {/* 内容区：外层用于 ResizeObserver 观测内容高度以自动滚动 */}
      <div ref={contentRef} className="space-y-4">
      {messages.map((msg, i) => {
        // roundActive 期间（非流式生成中），末条 AI 定型行由 LastAiSlot 接管：map 跳过，
        // 槽位在原气泡位置渲染直播（打字机）或定型排版，交接不重挂载、不重播入场动画
        if (roundActive && !streaming && msg.role === 'assistant' && i === lastAssistantIndex) {
          return null
        }
        const isUser = msg.role === 'user'
        // 主动搭话旁白：弱化的居中斜体行（非用户气泡），标识"角色主动开口"的舞台指示
        if (isUser && msg.meta?.proactive) {
          return (
            <motion.div key={i} {...popSlideUp} transition={{ ...popSlideUp.transition, delay: Math.min(i * 0.04, 0.32) }} className="my-3 flex justify-center">
              <p className="max-w-[85%] text-center text-xs italic leading-relaxed text-text-muted selectable">{msg.content}</p>
            </motion.div>
          )
        }
        return (
          <motion.div
            key={i}
            {...popSlideUp}
            // roundActive 期间末条 AI 从槽位移交回 map（新一轮流式开始）时跳过入场动画，避免交接闪烁
            initial={roundActive && i === lastAssistantIndex ? false : undefined}
            transition={{ ...popSlideUp.transition, delay: Math.min(i * 0.04, 0.32) }}
            className={cn('flex', isUser ? 'justify-end' : 'justify-start')}
          >
            <div className="max-w-[80%] text-left">
              <div className={cn('mb-1 flex items-center gap-2 px-1 text-xs text-text-muted', isUser && 'justify-end')}>
                <span>{isUser ? '你' : currentCardName || 'AI'}</span>
                {msg.timestamp && <span>{formatTime(msg.timestamp)}</span>}
              </div>
              <div
                className={cn(
                  'selectable whitespace-pre-wrap break-words px-4 py-2.5 text-sm leading-relaxed',
                  isUser
                    ? // 用户气泡：品牌纯色底 + 主色光晕（深色青 / 浅色淡蓝，与主题呼应）
                      'rounded-[var(--radius-lg)] rounded-br-[var(--radius-md)] bg-primary-gradient text-[var(--on-brand)] shadow-[var(--shadow-glow-primary)]'
                    : // AI 气泡：毛玻璃卡片 + 主色调边框
                      'glass rounded-[var(--radius-lg)] rounded-bl-[var(--radius-md)] text-text',
                )}
              >
                {isUser ? (
                  msg.content
                ) : i === lastAssistantIndex ? (
                  <AssistantSentences content={normalizeParagraphs(msg.content)} chunks={msg.chunks} />
                ) : (
                  normalizeParagraphs(msg.content)
                )}
              </div>
            </div>
          </motion.div>
        )
      })}

      {/* 末条 AI 常驻槽位：roundActive 期间接管直播（流式/跟读打字机）与定型渲染，
          交接在组件内部完成，不重挂载、不重播入场动画 */}
      {roundActive ? (
        <LastAiSlot
          name={currentCardName || 'AI'}
          message={lastAssistantIndex >= 0 ? (messages[lastAssistantIndex] as ChatMessage) : undefined}
          listRef={listRef}
          nearBottomRef={nearBottomRef}
        />
      ) : null}

      {/* 两窗统一的失败提示（基于消息流判定，窗口重载后依然可见）：
          末条是用户消息且不在生成中 = 这轮没有 AI 回复落盘；消息上的 error 字段携带具体原因。
          发送下一条消息并成功落定后（末条变为 assistant）自动消失。 */}
      {(() => {
        const lastMessage = messages[messages.length - 1]
        const lastIsUser = !!lastMessage && lastMessage.role === 'user' && !lastMessage.meta?.proactive
        // streamError 横幅仅覆盖"末条不是用户消息"的失败（如建会话失败）；末条挂起时由下方提示接管，避免重复
        return (
          <>
            {streamError && !streaming && !lastIsUser && (
              <div className="flex justify-center">
                <div className="flex items-center gap-2 rounded-[var(--radius-md)] border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
                  <AlertTriangle size={14} strokeWidth={1.75} />
                  {streamError}
                </div>
              </div>
            )}
            {!streaming && lastIsUser && (
              <div className="flex justify-center">
                <div
                  className="flex max-w-[85%] items-center gap-2 rounded-[var(--radius-md)] border border-border bg-surface-2 px-3 py-2 text-xs"
                  style={{ color: 'var(--warning)' }}
                >
                  <AlertTriangle size={14} strokeWidth={1.75} />
                  <span>
                    上一条消息未收到回复
                    {lastMessage!.error ? `：${lastMessage.error}` : '（可能网络中断或服务暂不可用）'}
                  </span>
                </div>
              </div>
            )}
          </>
        )
      })()}
      </div>
    </div>
  )
}

/**
 * 末条 AI 常驻槽位：roundActive 期间接管末条 AI 消息的显示。
 *
 * - 直播阶段：跟读显示 readingText 打字机（宠物窗随语音段段追加的镜像），非跟读显示
 *   streamingContent 打字机；行为与原 StreamingBubble 一致。
 * - 定型阶段：流式结束且直播源排空后，同一位置直接渲染定型排版（AssistantSentences），
 *   无重挂载、无入场动画重播——这是消除"回答收尾气泡闪烁"的关键。
 * - 定型阶段持续到本轮视图结束（切换会话重置），期间该行由 map 跳过，不重复渲染。
 */
function LastAiSlot({
  name,
  message,
  listRef,
  nearBottomRef,
}: {
  name: string
  /** 接管的末条 AI 消息（定型阶段渲染其内容；中止等场景可能尚未落盘 → undefined） */
  message: ChatMessage | undefined
  listRef: RefObject<HTMLDivElement | null>
  nearBottomRef: RefObject<boolean>
}) {
  const streaming = useSessionStore((s) => s.streaming)
  const streamingContent = useSessionStore((s) => s.streamingContent)
  // 语音跟读文本与模式：跟读时与宠物窗完全一致地显示段落文本
  const followReading = useChatReadingStore((s) => s.followReading)
  const readingText = useChatReadingStore((s) => s.text)
  const readingActive = useChatReadingStore((s) => s.readingActive)
  // 逐字速度：从全局设置读文字显示速度档（0-100）并换算为每字间隔毫秒
  const textSpeed = useSettingsStore((s) => s.settings.textSpeed ?? 80)
  const typeSpeed = typingSpeedToMs(textSpeed)

  // 即时模式（textSpeed=0 → typeSpeed<=0）：Typewriter 全量直显、不触发 onDone 清空 streamingContent，
  // 会导致定型消息被持续隐藏、气泡文字停在流式气泡里。流式一结束即清空，切换到定型渲染。
  useEffect(() => {
    if (!streaming && streamingContent.length > 0 && typeSpeed <= 0) {
      useSessionStore.setState({ streamingContent: '' })
    }
  }, [streaming, streamingContent, typeSpeed])

  // 流式内容更新时跟随滚动（复用父级列表，仅在接近底部时瞬时滚动）
  useEffect(() => {
    const el = listRef.current
    if (el && nearBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [streamingContent, readingText, listRef, nearBottomRef])

  // 定型判定：流式已结束且直播源已排空。注意跟读块间 readingActive 会瞬时回落，
  // 但 readingText 仍非空 → 仍算直播阶段，不会误判定型。
  const finalized =
    !streaming &&
    (followReading
      ? !readingActive && readingText.length === 0
      : streamingContent.length === 0)

  if (finalized) {
    // 中止/失败等场景消息可能尚未落盘：无可渲染内容，直接隐藏（与原"气泡隐藏"语义一致）
    if (!message) return null
    return (
      <div className="flex justify-start">
        <div className="max-w-[80%] text-left">
          <div className="mb-1 flex items-center gap-2 px-1 text-xs text-text-muted">
            <span>{name}</span>
            {message.timestamp && <span>{formatTime(message.timestamp)}</span>}
          </div>
          <div className="glass selectable whitespace-pre-wrap break-words rounded-[var(--radius-lg)] rounded-bl-[var(--radius-md)] px-4 py-2.5 text-sm leading-relaxed text-text">
            <AssistantSentences content={normalizeParagraphs(message.content)} chunks={message.chunks} />
          </div>
        </div>
      </div>
    )
  }

  return (
    <motion.div {...popSlideUp} className="flex justify-start">
      <div className="max-w-[80%] text-left">
        <div className="mb-1 px-1 text-xs text-text-muted">{name}</div>
        <div className="glass selectable rounded-[var(--radius-lg)] rounded-bl-[var(--radius-md)] px-4 py-2.5 text-sm leading-relaxed text-text">
          {/* 语音跟读：显示 readingText（宠物窗随语音段落追加的 displayedText 镜像），打字机逐字；
              与宠物窗完全同源——语音播到哪段、文本跟到哪段，杜绝"全文先出、语音后到"的不同步。
              打完不清（由朗读结束清），光标仅在输出中显示。 */}
          {followReading ? (
            <span className="whitespace-pre-wrap break-words">
              <Typewriter text={readingText} speed={typeSpeed} noCursor />
              {(streaming || readingActive) && <span className="streaming-cursor" />}
            </span>
          ) : (
            <Typewriter
                text={streamingContent}
                speed={typeSpeed}
                className="whitespace-pre-wrap break-words"
                complete={!streaming}
                onDone={() => useSessionStore.setState({ streamingContent: '' })}
              />
          )}
        </div>
      </div>
    </motion.div>
  )
}

/**
 * 显示前规范化文本：把模型输出的连续换行（含多余空行）统一压成单个换行，去掉过密的空行。
 * 气泡 pre-wrap 保留单换行即可有自然的段间换行。
 */
function normalizeParagraphs(text: string): string {
  return text.replace(/\n+/g, '\n')
}

/**
 * 保留段落结构展示：以合成分段（dialogue 逐项）为单位渲染，
 * 段与段之间留空行，段内多行用 <br/> 分隔（去掉朗读高亮）。
 * 无 chunks 时退化为整段文本（仍保留多行与空行）。
 */
function AssistantSentences({ content, chunks }: { content: string; chunks?: DialogueChunk[] }) {
  const list = chunks && chunks.length > 0 ? chunks.map((c) => normalizeParagraphs(c.text)) : [normalizeParagraphs(content)]
  return (
    <>
      {list.map((chunkText, ci) => {
        const lines = chunkText.split('\n')
        return (
          <Fragment key={ci}>
            {ci > 0 && <br />}
            {lines.map((line, li) => (
              <Fragment key={li}>
                {line.trim() === '' ? null : (
                  <>
                    {li > 0 && <br />}
                    {splitSentences(line).map((s, i) => (
                      <span key={i}>{s}</span>
                    ))}
                  </>
                )}
              </Fragment>
            ))}
          </Fragment>
        )
      })}
    </>
  )
}

/** 获取当前角色卡名称（独立 hook，避免 MessageList 因 cards 变化整体重算） */
function useCurrentCardName(): string {
  const cards = useCharacterStore((s) => s.cards)
  const currentId = useCharacterStore((s) => s.currentCardId)
  const card = cards.find((c) => c.id === currentId)
  return card?.name ?? 'AI'
}
