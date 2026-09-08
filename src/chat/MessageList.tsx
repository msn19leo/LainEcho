/**
 * 消息流（airi 风格竖向对话流）。
 *
 * 设计：
 *   - 用户消息靠右（气泡右对齐）：填充主色调渐变（深色青→深青，浅色蓝→深蓝）+ 主色光晕，文字左对齐。
 *   - AI 消息靠左：毛玻璃卡片 + 主色调边框。
 *   - 流式输出带流光打字机光标（.streaming-cursor，见 index.css）。
 *   - 消息出现使用 popSlideUp 弹性入场（scale 0.96 + y 12，0.4s 弹性曲线），逐条轻微错落。
 *   - 滚动优化（T3）：新消息/流式更新仅在用户接近底部时自动滚到底，且用瞬时滚动替代
 *     smooth，避免每个 token 都做一次平滑滚动造成卡顿。
 *   - 流式气泡抽成独立组件（StreamingBubble）单独订阅 streamingContent，流式更新时
 *     不再触发整个 MessageList 的 messages.map 重渲染。
 */
import { Fragment, useEffect, useRef, type RefObject } from 'react'
import { motion } from 'framer-motion'
import { AlertTriangle } from 'lucide-react'
import { useSessionStore } from '../store/sessionStore'
import { useCharacterStore } from '../store/characterStore'
import { useChatReadingStore } from './readingStore'
import { typingSpeedToMs, useSettingsStore } from '../store/settingsStore'
import { Typewriter } from '../components/Typewriter'
import { cn, formatTime, splitSentences } from '../lib/utils'
import { useAutoScrollBottom } from '../lib/useAutoScrollBottom'
import type { DialogueChunk } from '../types'
import { popSlideUp, springElastic } from '../lib/motion'

/** 距底部小于该阈值视为"接近底部"，此时才自动跟随滚动 */
const NEAR_BOTTOM_THRESHOLD = 80

export function MessageList() {
  // 逐字速度由独立的 StreamingBubble 组件内部读取（见函数 StreamingBubble）
  const messages = useSessionStore((s) => s.messages)
  // 顶层订阅 streamingContent：用于"流式结束但文字仍在逐字揭示"时隐藏定型 AI、保留揭示气泡
  const streamingContent = useSessionStore((s) => s.streamingContent)
  const streaming = useSessionStore((s) => s.streaming)
  const streamError = useSessionStore((s) => s.streamError)
  const currentCardName = useCurrentCardName()
  const followReading = useChatReadingStore((s) => s.followReading)
  const readingActive = useChatReadingStore((s) => s.readingActive)
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
      <div className="flex flex-1 items-center justify-center px-6 py-8">
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
    <div ref={listRef} onScroll={onScroll} className="flex-1 overflow-y-auto px-4 py-4">
      {/* 内容区：外层用于 ResizeObserver 观测内容高度以自动滚动 */}
      <div ref={contentRef} className="space-y-4">
      {messages.map((msg, i) => {
        // 隐藏末条定型 AI 的判定（须确有内容可显示，才由跟读/流式气泡接管，避免误藏上一条已落定回答）：
        //  - 跟读：仅当语音正在朗读（readingActive）时才隐藏；朗读结束即恢复定型消息，
        //    不依赖 streamingContent（跟读气泡显示 readingText），避免"朗读结束空档"误隐藏。
        //  - 流式（非跟读）：streamingContent 尚有内容（揭示未完）时隐藏。
        if (!streaming && ((followReading && readingActive) || (!followReading && streamingContent.length > 0)) && msg.role === 'assistant' && i === lastAssistantIndex) {
          console.log('[sync] chat 隐藏末条AI 下标=%d 原因(followReading=%s,readingActive=%s,sc=%d)', i, followReading, readingActive, streamingContent.length)
          return null
        }
        const isUser = msg.role === 'user'
        return (
          <motion.div
            key={i}
            {...popSlideUp}
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
                    ? // 用户气泡：主色调渐变 + 主色光晕（深色青→深青，浅色蓝→深蓝）
                      'rounded-[var(--radius-lg)] rounded-br-[var(--radius-md)] bg-primary-gradient text-white shadow-[var(--shadow-glow-primary)]'
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

      {/* 流式/跟读气泡显示：跟读仅当语音正在朗读（readingActive）时出现（否则朗读结束后
          streamingContent 已空会渲染空气泡）；非跟读在 streamingContent 尚有内容时出现 */}
      {streaming || (!followReading && streamingContent.length > 0) || (followReading && readingActive) ? (
        <StreamingBubble
          name={currentCardName || 'AI'}
          listRef={listRef}
          nearBottomRef={nearBottomRef}
        />
      ) : null}

      {streamError && !streaming && (
        <div className="flex justify-center">
          <div className="flex items-center gap-2 rounded-[var(--radius-md)] border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
            <AlertTriangle size={14} strokeWidth={1.75} />
            {streamError}
          </div>
        </div>
      )}
      </div>
    </div>
  )
}

/**
 * 流式气泡（T3）：独立组件单独订阅 streamingContent。
 * 这样流式 token 逐帧刷新只重渲染本气泡，不会触发 MessageList 里整条 messages.map 重渲染。
 * 同时在内容增长时驱动父级列表滚动（仅在接近底部时瞬时滚到底）。
 */
function StreamingBubble({
  name,
  listRef,
  nearBottomRef,
}: {
  name: string
  listRef: RefObject<HTMLDivElement | null>
  nearBottomRef: RefObject<boolean>
}) {
  const streamingContent = useSessionStore((s) => s.streamingContent)
  const streaming = useSessionStore((s) => s.streaming)
  // 语音跟读文本与模式：跟读时与宠物窗完全一致地显示段落文本
  const followReading = useChatReadingStore((s) => s.followReading)
  const readingText = useChatReadingStore((s) => s.text)
  const readingActive = useChatReadingStore((s) => s.readingActive)
  // 逐字速度：从全局设置读文字显示速度档（0-100）并换算为每字间隔毫秒
  const textSpeed = useSettingsStore((s) => s.settings.textSpeed ?? 80)
  const typeSpeed = typingSpeedToMs(textSpeed)

  // 即时模式（textSpeed=0 → typeSpeed<=0）：Typewriter 全量直显、不触发 onDone 清空 streamingContent，
  // 会导致定型消息被持续隐藏、气泡文字停在流式气泡里。流式一结束即清空，让完整消息上屏。
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
