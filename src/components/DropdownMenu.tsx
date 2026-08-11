/**
 * 轻量下拉菜单（无第三方依赖）。
 * - DropdownMenu：锚定在触发按钮下方，用于聊天工具栏的角色卡选择等
 * - PositionedMenu：自由定位（鼠标坐标），用于桌宠右键菜单
 * 菜单项统一「图标 + 文字」，毛玻璃深色卡片风格，与设置面板视觉一致。
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '../lib/utils'

export interface MenuItem {
  key: string
  label: string
  icon?: LucideIcon
  danger?: boolean
  onSelect: () => void
}

const PANEL_CLASS =
  'overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-panel)]/95 py-1 shadow-[var(--shadow-card-hover)] backdrop-blur-xl'

export function ItemButton({ item, onDone }: { item: MenuItem; onDone: () => void }) {
  const Icon = item.icon
  return (
    <button
      type="button"
      onClick={() => {
        onDone()
        item.onSelect()
      }}
      className={cn(
        'flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] transition-colors',
        item.danger
          ? 'text-[var(--danger)] hover:bg-danger/10'
          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text-primary)]',
      )}
    >
      {Icon && <Icon size={15} strokeWidth={1.75} />}
      {item.label}
    </button>
  )
}

// ---------------- DropdownMenu ----------------

interface DropdownMenuProps {
  trigger: ReactNode
  items: MenuItem[]
  align?: 'start' | 'end'
  buttonClassName?: string
  panelClassName?: string
  disabled?: boolean
}

export function DropdownMenu({
  trigger,
  items,
  align = 'end',
  buttonClassName,
  panelClassName,
  disabled,
}: DropdownMenuProps) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={cn('disabled:cursor-not-allowed disabled:opacity-40', buttonClassName)}
      >
        {trigger}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className={cn(
              PANEL_CLASS,
              'absolute z-50 mt-1.5 min-w-[168px]',
              align === 'end' ? 'right-0' : 'left-0',
              panelClassName,
            )}
          >
            {items.map((item) => (
              <ItemButton key={item.key} item={item} onDone={() => setOpen(false)} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ---------------- PositionedMenu（右键菜单） ----------------

interface PositionedMenuProps {
  x: number
  y: number
  open: boolean
  items: MenuItem[]
  onClose: () => void
}

export function PositionedMenu({ x, y, open, items, onClose }: PositionedMenuProps) {
  if (!open) return null
  return (
    <>
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div className={cn(PANEL_CLASS, 'fixed z-50 min-w-[176px]')} style={{ left: x, top: y }}>
        {items.map((item) => (
          <ItemButton key={item.key} item={item} onDone={onClose} />
        ))}
      </div>
    </>
  )
}
