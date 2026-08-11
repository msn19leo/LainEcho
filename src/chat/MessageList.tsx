/**
 * 消息流（airi 风格竖向对话流）。
 *
 * 设计：
 *   - 用户消息靠右：填充主色调渐变（深色青→深青，浅色蓝→深蓝）+ 主色光晕。
 *   - AI 消息靠左：毛玻璃卡片 + 主色调边框。
 *   - 流式输出带流光打字机光标（.streaming-cursor，见 index.css）。
 *   - 消息出现使用 popSlideUp 弹性入场（scale 0.96 + y 12，0.4s 弹性曲线），逐条轻微错落。
 *   - 新消息/流式更新自动滚动到底部。
 */
import { useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import { AlertTriangle } from 'lucide-react'
import { useSessionStore } from '../store/sessionStore'
import { useCharacterStore } from '../store/characterStore'
import { cn, formatTime } from '../lib/utils'
import { popSlideUp, springElastic } from '../lib/motion'

export function MessageList() {
  const messages = useSessionStore((s) => s.messages)
  const streaming = useSessionStore((s) => s.streaming)
  const streamingContent = useSessionStore((s) => s.streamingContent)
  const streamError = useSessionStore((s) => s.streamError)
  const currentCardName = useCurrentCardName()
  const bottomRef = useRef<HTMLDivElement>(null)

  // 新消息 / 流式内容更新时滚动到底部
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, streamingContent, streaming, streamError])

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
    <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
      {messages.map((msg, i) => {
        const isUser = msg.role === 'user'
        return (
          <motion.div
            key={i}
            {...popSlideUp}
            transition={{ ...popSlideUp.transition, delay: Math.min(i * 0.04, 0.32) }}
            className={cn('flex', isUser ? 'justify-end' : 'justify-start')}
          >
            <div className={cn('max-w-[80%]', isUser ? 'text-right' : 'text-left')}>
              <div className="mb-1 flex items-center gap-2 px-1 text-xs text-text-muted">
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
                {msg.content}
              </div>
            </div>
          </motion.div>
        )
      })}

      {streaming && (
        <motion.div {...popSlideUp} className="flex justify-start">
          <div className="max-w-[80%] text-left">
            <div className="mb-1 px-1 text-xs text-text-muted">{currentCardName || 'AI'}</div>
            <div className="glass selectable rounded-[var(--radius-lg)] rounded-bl-[var(--radius-md)] px-4 py-2.5 text-sm leading-relaxed text-text">
              <span className="streaming-cursor whitespace-pre-wrap break-words">
                {streamingContent}
              </span>
            </div>
          </div>
        </motion.div>
      )}

      {streamError && !streaming && (
        <div className="flex justify-center">
          <div className="flex items-center gap-2 rounded-[var(--radius-md)] border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
            <AlertTriangle size={14} strokeWidth={1.75} />
            {streamError}
          </div>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  )
}

/** 获取当前角色卡名称（独立 hook，避免 MessageList 因 cards 变化整体重算） */
function useCurrentCardName(): string {
  const cards = useCharacterStore((s) => s.cards)
  const currentId = useCharacterStore((s) => s.currentCardId)
  const card = cards.find((c) => c.id === currentId)
  return card?.name ?? 'AI'
}
