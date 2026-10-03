/**
 * 轻量下拉菜单（无第三方依赖）。
 * - DropdownMenu：命令式菜单，trigger 完全自定义（聊天工具栏角色卡选择等）
 * - SelectMenu：表单选择器，受控 value/onChange，触发器与 Input 同风格
 * - PositionedMenu：自由定位（鼠标坐标），用于桌宠右键菜单
 * 菜单项统一「图标 + 文字」，弹层共用一套定位引擎：fixed 定位（不受滚动
 * 容器裁剪）+ 下方空间不足自动向上翻转 + 视口边缘钳位 + 高度受限滚动。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode, RefObject } from 'react'
import type { LucideIcon } from 'lucide-react'
import { ChevronDown } from 'lucide-react'
import { cn } from '../lib/utils'

export interface MenuItem {
  key: string
  label: string
  icon?: LucideIcon
  danger?: boolean
  /** 选中态高亮（选择器场景使用） */
  selected?: boolean
  onSelect: () => void
}

const PANEL_CLASS =
  'overflow-y-auto overscroll-contain rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-panel)]/95 py-1 shadow-[var(--shadow-card-hover)] backdrop-blur-[20px]'

/** 弹层最小宽度，避免触发器太窄时菜单挤成一列 */
const PANEL_MIN_W = 168

export function ItemButton({ item, onDone }: { item: MenuItem; onDone: () => void }) {
  const Icon = item.icon
  return (
    <button
      type="button"
      title={item.label}
      onClick={() => {
        onDone()
        item.onSelect()
      }}
      className={cn(
        'flex w-full items-center gap-3 px-3 py-2 text-left text-[13px] transition-colors',
        item.danger
          ? 'text-[var(--danger)] hover:bg-danger/10'
          : item.selected
            ? 'bg-accent/15 font-medium text-accent'
            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text-primary)]',
      )}
    >
      {Icon && <Icon size={15} strokeWidth={1.75} className="shrink-0" />}
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
    </button>
  )
}

/** 打开期间监听 Esc / 外部滚动 / 窗口缩放，任一发生即关闭（面板内部滚动除外） */
function usePanelDismiss(panelRef: RefObject<HTMLDivElement | null>, onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const onScroll = (e: Event) => {
      // 面板内部滚动（滚选项列表）不关闭；外部页面/容器滚动关闭，避免弹层脱离锚点
      if (panelRef.current && e.target instanceof Node && panelRef.current.contains(e.target)) return
      onClose()
    }
    const onResize = () => onClose()
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [panelRef, onClose])
}

interface MenuPanelProps {
  /** 触发按钮的 DOMRect（打开瞬间捕获） */
  anchor: DOMRect
  align: 'start' | 'end'
  className?: string
  onDismiss: () => void
  children: ReactNode
}

/**
 * 统一弹层：Portal 到 body + fixed 定位。
 * 必须用 Portal：应用里大量容器带 backdrop-filter（glass 类），而
 * backdrop-filter 与 transform 一样会把 fixed 子元素变成相对该祖先定位，
 * 导致全屏遮罩盖不住整个窗口、坐标计算错位；挂到 body 后彻底规避。
 * 首帧按「触发器下方」渲染，useLayoutEffect 中测量实际尺寸后同步修正：
 * 下方空间不足且上方更宽裕则向上翻转，左右钳位在视口内，高度受限时滚动。
 * useLayoutEffect 在绘制前执行，修正过程无闪烁。
 */
function MenuPanel({ anchor, align, className, onDismiss, children }: MenuPanelProps) {
  const ref = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight?: number }>({
    left: anchor.left,
    top: anchor.bottom + 6,
  })
  usePanelDismiss(ref, onDismiss)

  useLayoutEffect(() => {
    const measure = () => {
      const el = ref.current
      if (!el) return
      const MARGIN = 8
      const pw = el.offsetWidth
      // scrollHeight 是完整内容高（含被 maxHeight 裁掉的部分），+2 为上下边框，
      // 未裁剪时恰等于 offsetHeight，保证「放得下时绝不出现滚动条」
      const ph = el.scrollHeight + 2
      const spaceBelow = window.innerHeight - anchor.bottom - MARGIN
      const spaceAbove = anchor.top - MARGIN
      // 下方放不下（或只能放下很小一截）且上方更宽裕 → 向上翻转
      const openUp = spaceBelow < Math.min(ph, 160) && spaceAbove > spaceBelow
      const maxHeight = Math.max(120, Math.min(ph, openUp ? spaceAbove : spaceBelow))
      let left = align === 'end' ? anchor.right - pw : anchor.left
      left = Math.max(MARGIN, Math.min(left, window.innerWidth - pw - MARGIN))
      const top = openUp ? anchor.top - 6 - maxHeight : anchor.bottom + 6
      setPos({ left, top, maxHeight })
    }

    measure()
    // 选项增删（如其他窗口新增角色卡）、字体/图标加载完成都会改变内容高度，
    // 需要重测，否则 maxHeight 停留在打开瞬间的旧值，列表变长会冒出多余滚动条。
    // 观察内层内容盒而非面板本身：面板被 maxHeight 裁剪时盒子不变、RO 不触发。
    const content = contentRef.current
    if (!content || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => measure())
    ro.observe(content)
    return () => ro.disconnect()
  }, [anchor, align])

  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={onDismiss} />
      <div
        ref={ref}
        className={cn(PANEL_CLASS, 'fixed z-50 max-w-[320px]', className)}
        style={{
          left: pos.left,
          top: pos.top,
          maxHeight: pos.maxHeight,
          minWidth: Math.max(anchor.width, PANEL_MIN_W),
        }}
      >
        <div ref={contentRef}>{children}</div>
      </div>
    </>,
    document.body,
  )
}

// ---------------- DropdownMenu（命令式菜单，trigger 自定义） ----------------

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
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  const toggle = () => {
    if (open) {
      setOpen(false)
      return
    }
    const rect = btnRef.current?.getBoundingClientRect()
    if (rect) setAnchor(rect)
    setOpen(true)
  }

  return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        onClick={toggle}
        className={cn('disabled:cursor-not-allowed disabled:opacity-40', buttonClassName)}
      >
        {trigger}
      </button>
      {open && anchor && (
        <MenuPanel anchor={anchor} align={align} className={panelClassName} onDismiss={() => setOpen(false)}>
          {items.map((item) => (
            <ItemButton key={item.key} item={item} onDone={() => setOpen(false)} />
          ))}
        </MenuPanel>
      )}
    </div>
  )
}

// ---------------- SelectMenu（表单选择器，受控 value/onChange） ----------------

export interface SelectOption {
  value: string
  label: string
  icon?: LucideIcon
}

interface SelectMenuProps {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  /** 当前值无匹配选项时的占位文案 */
  placeholder?: string
  disabled?: boolean
  align?: 'start' | 'end'
  /** 追加到最外层容器的类名（宽度/弹性布局用，如 flex-1、min-w-0） */
  className?: string
}

/** 表单选择器：触发器与 Input 同风格（表单场景统一外观），弹层与其他下拉统一 */
export function SelectMenu({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  align = 'start',
  className,
}: SelectMenuProps) {
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  const current = options.find((o) => o.value === value)
  const CurrentIcon = current?.icon

  const toggle = () => {
    if (open) {
      setOpen(false)
      return
    }
    const rect = btnRef.current?.getBoundingClientRect()
    if (rect) setAnchor(rect)
    setOpen(true)
  }

  return (
    <div className={cn('relative', className)}>
      <button
        ref={btnRef}
        type="button"
        disabled={disabled || options.length === 0}
        onClick={toggle}
        className={cn(
          'flex w-full cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none transition-all',
          'focus-visible:border-[var(--border-strong)] focus-visible:shadow-[0_0_0_3px_var(--primary-glow)]',
          'disabled:cursor-not-allowed disabled:opacity-40',
        )}
      >
        {CurrentIcon && <CurrentIcon size={14} strokeWidth={1.75} className="shrink-0 text-text-2" />}
        <span className={cn('min-w-0 flex-1 truncate text-left', !current && 'text-text-muted')}>
          {current?.label ?? placeholder ?? '请选择'}
        </span>
        <ChevronDown
          size={14}
          strokeWidth={2}
          className={cn('shrink-0 text-text-muted transition-transform', open && 'rotate-180')}
        />
      </button>
      {open && anchor && (
        <MenuPanel anchor={anchor} align={align} onDismiss={() => setOpen(false)}>
          {options.map((o) => (
            <ItemButton
              key={o.value}
              item={{
                key: o.value,
                label: o.label,
                icon: o.icon,
                selected: o.value === value,
                onSelect: () => onChange(o.value),
              }}
              onDone={() => setOpen(false)}
            />
          ))}
        </MenuPanel>
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
