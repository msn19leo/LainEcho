/**
 * 宠物窗会话记录列表（Shinsekai 设计借鉴）：
 * - 圆角气泡列表，左右对齐；用户/AI 气泡上方带小名牌，AI 用角色名+角色色表达情绪（不塞文字标签）。
 * - 正在生成的那条做"逐字打印"（对已到达的 streamingContent 做打字机 reveal）。
 * 内容随 useSessionStore（宠物窗镜像）与聊天窗同步。
 */
import { useEffect, useRef, useState } from 'react'
import { useSessionStore } from '../store/sessionStore'
import { useCharacterStore } from '../store/characterStore'
import { cn } from '../lib/utils'

/** 逐字打印组件：对增量到达的流式文本做打字机 reveal。
 *  关键：可见量在文本增长时只增不减（用 ref 记忆），不做每 text 变化的 0 重置，
 *  避免流式期间反复重播/抖动。 */
function TypewriterText({ text, className }: { text: string; className?: string }) {
  const [visible, setVisible] = useState(0)
  const visibleRef = useRef(0)
  useEffect(() => {
    const s = setInterval(() => {
      visibleRef.current += 1
      setVisible(visibleRef.current)
    }, 25)
    return () => clearInterval(s)
  }, [])
  return (
    <span className={className}>
      {text.slice(0, Math.min(visible, text.length))}
      {visible < text.length && <span className="streaming-cursor" />}
    </span>
  )
}

/** 当前使用中的角色名（AI 名牌用） */
function useCurrentCardName(): string {
  const cards = useCharacterStore((s) => s.cards)
  const currentId = useCharacterStore((s) => s.currentCardId)
  const card = cards.find((c) => c.id === currentId)
  return card?.name ?? 'AI'
}

export function PetContentList() {
  const messages = useSessionStore((s) => s.messages)
  const streaming = useSessionStore((s) => s.streaming)
  const streamingContent = useSessionStore((s) => s.streamingContent)
  const aiName = useCurrentCardName()
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, streaming, streamingContent])

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto px-2 py-1 text-[13px] leading-[16px] text-text" onWheel={(e) => e.stopPropagation()}>
      {messages.map((msg, i) => {
        const isUser = msg.role === 'user'
        return (
          <div key={i} className={cn('my-1 flex flex-col', isUser ? 'items-end' : 'items-start')}>
            {/* 名牌：用户=你；AI=角色名（用角色色表达说话人/情绪） */}
            <span
              className={cn(
                'mb-0.5 select-none px-1 text-[10px] font-medium',
                isUser ? 'text-text-muted' : 'text-[var(--primary-400)]',
              )}
            >
              {isUser ? '你' : aiName}
            </span>
            <div
              className={cn(
                'max-w-[90%] selectable whitespace-pre-wrap break-words rounded-[5px] px-2 py-1',
                isUser
                  ? 'bg-primary-gradient text-white'
                  : 'border border-[var(--border-strong)] bg-[var(--bg-surface)]/70 text-text',
              )}
            >
              {msg.content.replace(/\n+/g, '\n')}
            </div>
          </div>
        )
      })}

      {streaming && (
        <div className="my-1 flex flex-col items-start">
          <span className="mb-0.5 select-none px-1 text-[10px] font-medium text-[var(--primary-400)]">{aiName}</span>
          <span className="max-w-[90%] whitespace-pre-wrap break-words rounded-[5px] border border-[var(--border-strong)] bg-[var(--bg-surface)]/70 px-2 py-1 text-text">
            <TypewriterText text={streamingContent} />
          </span>
        </div>
      )}
    </div>
  )
}