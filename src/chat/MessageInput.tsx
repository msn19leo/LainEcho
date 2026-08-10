/**
 * 消息输入框：Enter 发送 / Shift+Enter 换行；流式中显示「停止」按钮。
 */
import { useEffect, useRef, useState } from 'react'
import { useSessionStore } from '../store/sessionStore'

export function MessageInput() {
  const streaming = useSessionStore((s) => s.streaming)
  const send = useSessionStore((s) => s.send)
  const stop = useSessionStore((s) => s.stop)
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!streaming) textareaRef.current?.focus()
  }, [streaming])

  const canSend = value.trim().length > 0 && !streaming

  const handleSend = () => {
    const text = value.trim()
    if (!text || streaming) return
    setValue('')
    void send(text)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="border-t border-border bg-surface-2/60 p-3">
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder={streaming ? 'AI 正在回复…' : '输入消息，Enter 发送，Shift+Enter 换行'}
          className="max-h-32 min-h-[40px] flex-1 resize-none rounded-xl border border-border bg-surface-2 px-3.5 py-2.5 text-sm leading-relaxed text-text placeholder:text-text-muted outline-none transition focus:border-accent focus:ring-1 focus:ring-accent/40"
        />
        {streaming ? (
          <button
            onClick={() => stop()}
            className="inline-flex h-[40px] items-center gap-1.5 rounded-xl border border-danger/40 bg-danger/10 px-4 text-sm font-medium text-danger transition hover:bg-danger/20"
          >
            ■ 停止
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!canSend}
            className="inline-flex h-[40px] items-center rounded-xl bg-gradient-to-r from-accent to-accent-2 px-5 text-sm font-medium text-white shadow-md shadow-accent/20 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            发送
          </button>
        )}
      </div>
    </div>
  )
}
