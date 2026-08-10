/**
 * 消息流：用户消息靠右，AI 消息靠左；流式输出带打字机光标。
 */
import { useEffect, useRef } from 'react'
import { useSessionStore } from '../store/sessionStore'
import { useCharacterStore } from '../store/characterStore'
import { cn, formatTime } from '../lib/utils'

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
      <div className="flex flex-1 items-center justify-center text-sm text-text-muted">
        <div className="text-center">
          <div className="mb-2 text-3xl">👋</div>
          <p>和 {currentCardName || '桌宠'} 打个招呼吧</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
      {messages.map((msg, i) => {
        const isUser = msg.role === 'user'
        return (
          <div key={i} className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
            <div className={cn('max-w-[78%]', isUser ? 'text-right' : 'text-left')}>
              <div className="mb-1 flex items-center gap-2 px-1 text-xs text-text-muted">
                <span>{isUser ? '你' : currentCardName || 'AI'}</span>
                {msg.timestamp && <span>{formatTime(msg.timestamp)}</span>}
              </div>
              <div
                className={cn(
                  'selectable whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-sm leading-relaxed',
                  isUser
                    ? 'rounded-br-md bg-gradient-to-r from-accent to-accent-2 text-white'
                    : 'rounded-bl-md border border-border bg-card text-text',
                )}
              >
                {msg.content}
              </div>
            </div>
          </div>
        )
      })}

      {streaming && (
        <div className="flex justify-start">
          <div className="max-w-[78%] text-left">
            <div className="mb-1 px-1 text-xs text-text-muted">{currentCardName || 'AI'}</div>
            <div className="selectable rounded-2xl rounded-bl-md border border-border bg-card px-4 py-2.5 text-sm leading-relaxed text-text">
              <span className="streaming-cursor whitespace-pre-wrap break-words">{streamingContent}</span>
            </div>
          </div>
        </div>
      )}

      {streamError && !streaming && (
        <div className="flex justify-center">
          <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
            ⚠ {streamError}
          </div>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  )
}

function useCurrentCardName(): string {
  const cards = useCharacterStore((s) => s.cards)
  const currentId = useCharacterStore((s) => s.currentCardId)
  const card = cards.find((c) => c.id === currentId)
  return card?.name ?? 'AI'
}
