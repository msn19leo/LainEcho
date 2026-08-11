/**
 * 自定义无边框标题栏（聊天 / 设置窗口共用）。
 * 左侧品牌渐变圆点带呼吸光效；底部极细渐变分隔线；右侧最小化/最大化/关闭。
 */
import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { api } from '../api'
import { cn } from '../lib/utils'

export function WindowTitlebar({ title, onDoubleClick }: { title: string; onDoubleClick?: () => void }) {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    let mounted = true
    void api.win.isMaximized().then((m) => mounted && setMaximized(m))
    const unsub = api.win.onMaximizedChange(setMaximized)
    return () => {
      mounted = false
      unsub()
    }
  }, [])

  return (
    <div
      className="glass app-drag relative flex h-10 shrink-0 items-center justify-between border-x-0 border-t-0 pl-4 pr-2"
      onDoubleClick={() => {
        onDoubleClick?.()
        api.win.toggleMaximize()
      }}
    >
      <div className="flex items-center gap-2.5 text-sm font-medium text-text-2">
        <motion.span
          className="h-2.5 w-2.5 rounded-full"
          style={{ background: 'var(--gradient-brand)' }}
          animate={{
            boxShadow: [
              '0 0 2px var(--primary-glow)',
              '0 0 10px var(--primary-glow), 0 0 4px var(--accent-glow)',
              '0 0 2px var(--primary-glow)',
            ],
          }}
          transition={{ duration: 2.6, repeat: Infinity, ease: 'easeInOut' }}
        />
        {title}
      </div>
      <div className="app-no-drag flex items-center gap-0.5">
        <TitlebarButton label="最小化" onClick={() => api.win.minimize()}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </TitlebarButton>
        <TitlebarButton label={maximized ? '还原' : '最大化'} onClick={() => api.win.toggleMaximize()}>
          {maximized ? (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <rect x="2.5" y="4" width="5.5" height="5.5" stroke="currentColor" strokeWidth="1.1" />
              <path d="M5 2.5h4.5V7" stroke="currentColor" strokeWidth="1.1" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <rect x="2.5" y="2.5" width="7" height="7" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          )}
        </TitlebarButton>
        <TitlebarButton label="关闭" onClick={() => api.win.close()} close>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </TitlebarButton>
      </div>
    </div>
  )
}

function TitlebarButton({
  label,
  onClick,
  children,
  close,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
  close?: boolean
}) {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'flex h-7 w-9 items-center justify-center rounded-[var(--radius-md)] text-text-muted transition-colors duration-150',
        close ? 'hover:bg-danger hover:text-white' : 'hover:bg-card-hover hover:text-text',
      )}
    >
      {children}
    </button>
  )
}
