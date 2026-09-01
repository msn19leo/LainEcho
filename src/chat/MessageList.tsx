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
import { cn, formatTime, splitSentences } from '../lib/utils'
import type { DialogueChunk } from '../types'
import { popSlideUp, springElastic } from '../lib/motion'

/** 距底部小于该阈值视为"接近底部"，此时才自动跟随滚动 */
const NEAR_BOTTOM_THRESHOLD = 80

export function MessageList({ activeChunk }: { activeChunk?: number | null }) {
  const messages = useSessionStore((s) => s.messages)
  const streaming = useSessionStore((s) => s.streaming)
  const streamError = useSessionStore((s) => s.streamError)
  const currentCardName = useCurrentCardName()
  const listRef = useRef<HTMLDivElement>(null)
  const nearBottomRef = useRef(true)

  /** 最后一条 AI 消息（当前正在朗读/高亮的目标） */
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

  // 新消息 / 流式更新：仅在接近底部时瞬时滚到底（替代每 token 的 smooth，降低渲染开销）
  useEffect(() => {
    const el = listRef.current
    if (el && nearBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages, streaming, streamError])

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
    <div ref={listRef} onScroll={onScroll} className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
      {messages.map((msg, i) => {
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
                  <AssistantSentences content={normalizeParagraphs(msg.content)} chunks={msg.chunks} activeChunk={activeChunk ?? null} />
                ) : (
                  normalizeParagraphs(msg.content)
                )}
              </div>
            </div>
          </motion.div>
        )
      })}

      {streaming && (
        <StreamingBubble
          name={currentCardName || 'AI'}
          listRef={listRef}
          nearBottomRef={nearBottomRef}
        />
      )}

      {streamError && !streaming && (
        <div className="flex justify-center">
          <div className="flex items-center gap-2 rounded-[var(--radius-md)] border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
            <AlertTriangle size={14} strokeWidth={1.75} />
            {streamError}
          </div>
        </div>
      )}
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

  // 流式内容更新时跟随滚动（复用父级列表，仅在接近底部时瞬时滚动）
  useEffect(() => {
    const el = listRef.current
    if (el && nearBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [streamingContent, listRef, nearBottomRef])

  return (
    <motion.div {...popSlideUp} className="flex justify-start">
      <div className="max-w-[80%] text-left">
        <div className="mb-1 px-1 text-xs text-text-muted">{name}</div>
        <div className="glass selectable rounded-[var(--radius-lg)] rounded-bl-[var(--radius-md)] px-4 py-2.5 text-sm leading-relaxed text-text">
          <span className="streaming-cursor whitespace-pre-wrap break-words">
            {streamingContent}
          </span>
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
 * 段级朗读高亮 + 保留空行段落：
 * 以合成分段（dialogue 逐项）为单位渲染，当前朗读段整段高亮；
 * 段与段之间留空行，段内多行用 <br/> 分隔，行内 splitSentences 保证段落换行/标点自然。
 * 无 chunks 时退化为整段文本（仍保留多行与空行）。
 */
function AssistantSentences({ content, chunks, activeChunk }: { content: string; chunks?: DialogueChunk[]; activeChunk: number | null }) {
  const list = chunks && chunks.length > 0 ? chunks.map((c) => c.text) : [content]
  const ACTIVE_CLS = 'rounded bg-[var(--primary-400)]/20 text-[var(--primary-400)]'
  return (
    <>
      {list.map((chunkText, ci) => {
        const active = ci === activeChunk
        const lines = chunkText.split('\n')
        return (
          <Fragment key={ci}>
            {ci > 0 && <br />}
            {lines.map((line, li) => (
              <Fragment key={li}>
                {li > 0 && <br />}
                {splitSentences(line).map((s, i) => (
                  <span key={i} className={active ? ACTIVE_CLS : undefined}>
                    {s}
                  </span>
                ))}
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
