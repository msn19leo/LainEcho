/**
 * 宠物窗聊天输入框：无背景/边框，只有一个输入框 + 圆角方形发送按钮。
 * Enter 发送、Shift+Enter 换行；流式中按钮变为停止。与聊天窗同会话异步同步。
 */
import { useEffect, useRef, useState } from 'react'
import { Send, Square } from 'lucide-react'
import { useSessionStore } from '../store/sessionStore'

export function PetInput() {
  const streaming = useSessionStore((s) => s.streaming)
  const send = useSessionStore((s) => s.send)
  const stop = useSessionStore((s) => s.stop)
  const [value, setValue] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!streaming) taRef.current?.focus()
  }, [streaming])

  const handleSend = () => {
    const text = value.trim()
    if (!text || streaming) return
    setValue('')
    if (taRef.current) taRef.current.style.height = 'auto'
    void send(text)
  }

  return (
    <div className="app-no-drag flex h-full items-center gap-2 px-2" onWheel={(e) => e.stopPropagation()}>
      <textarea
        ref={taRef}
        value={value}
        rows={1}
        spellCheck={false}
        placeholder="说点什么…"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            handleSend()
          }
        }}
        className="min-h-0 w-full flex-1 resize-none rounded-[5px] border border-[var(--border-strong)] bg-[var(--bg-surface)] px-3 py-1.5 text-sm leading-[20px] text-text outline-none placeholder:text-text-muted focus:border-[var(--primary-400)]"
        style={{ maxHeight: 38 }}
      />
      <button
        type="button"
        title={streaming ? '停止' : '发送'}
        onClick={() => (streaming ? stop() : handleSend())}
        className="flex h-8 w-9 shrink-0 items-center justify-center rounded-[5px] text-white transition-colors hover:brightness-110"
        style={{ backgroundColor: 'var(--primary-500)' }}
      >
        {streaming ? <Square size={15} strokeWidth={2.5} fill="currentColor" /> : <Send size={16} strokeWidth={2.25} />}
      </button>
    </div>
  )
}