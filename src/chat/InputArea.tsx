/**
 * 输入区（InputArea）—— 替代旧 MessageInput。
 *
 * 设计：
 *   - 输入框：12px 圆角（规范），自动拉伸高度（rows 自适应，max-h 限制）。
 *   - 聚焦态：主色光晕环（0 0 0 3px primary-glow）。
 *   - 发送按钮：粉色渐变（accent-gradient）+ 粉色光晕，hover 加亮。
 *   - 流式中显示「停止」按钮（danger 边框）。
 *   - Enter 发送 / Shift+Enter 换行；中文输入法合成中不触发发送。
 */
import { useEffect, useRef, useState } from 'react'
import { Send, Square } from 'lucide-react'
import { useSessionStore } from '../store/sessionStore'

export function InputArea() {
  const streaming = useSessionStore((s) => s.streaming)
  const send = useSessionStore((s) => s.send)
  const stop = useSessionStore((s) => s.stop)
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // 流式结束后重新聚焦输入框
  useEffect(() => {
    if (!streaming) textareaRef.current?.focus()
  }, [streaming])

  /** 自动拉伸高度：按 scrollHeight 调整，上限 128px */
  const autoResize = () => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`
  }

  useEffect(autoResize, [value])

  const canSend = value.trim().length > 0 && !streaming

  /** 发送消息 */
  const handleSend = () => {
    const text = value.trim()
    if (!text || streaming) return
    setValue('')
    void send(text)
  }

  /** 键盘处理：Enter 发送 / Shift+Enter 换行；合成中不触发 */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="glass shrink-0 border-t-0 px-3 pb-3 pt-2">
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder={streaming ? 'AI 正在回复…' : 'Enter 发送，Shift+Enter 换行'}
          className="max-h-32 min-h-[40px] flex-1 resize-none rounded-[var(--radius-sm)] border border-border bg-surface-2/70 px-3.5 py-2.5 text-sm leading-relaxed text-text outline-none transition-all placeholder:text-text-muted focus:border-[var(--border-strong)] focus:shadow-[0_0_0_3px_var(--primary-glow)]"
        />
        {streaming ? (
          <button
            onClick={() => stop()}
            className="inline-flex h-[40px] items-center gap-1.5 rounded-[var(--radius-md)] border border-danger/40 bg-danger/10 px-4 text-sm font-medium text-danger transition-colors hover:bg-danger/20"
          >
            <Square size={13} fill="currentColor" />
            停止
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!canSend}
            className="bg-accent-gradient glow-accent inline-flex h-[40px] items-center gap-1.5 rounded-[var(--radius-md)] px-5 text-sm font-semibold text-white transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
          >
            <Send size={15} strokeWidth={2} />
            发送
          </button>
        )}
      </div>
    </div>
  )
}
