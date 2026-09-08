/**
 * 通用 UI 原语：Button / Input / Textarea / Select / Switch / Card / Modal
 * 统一 Cyber-Kawaii 风格：毛玻璃 + 品牌渐变 + 主色/粉色光晕。
 * 颜色全部走 Design Tokens（src/index.css），跟随 data-theme 切换。
 * 圆角严格对齐规范：输入框 12px、按钮 16px、卡片 24px。
 */
import {
  type ReactNode,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
  type SelectHTMLAttributes,
  useEffect,
  useState,
} from 'react'
import { ChevronDown, RotateCcw, XCircle } from 'lucide-react'
import { cn } from '../lib/utils'

// ---------------- Button ----------------

type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'danger' | 'subtle'

const buttonVariants: Record<ButtonVariant, string> = {
  primary:
    'bg-brand-gradient text-[var(--on-brand)] hover:shadow-[var(--shadow-glow-primary)] hover:brightness-110 active:brightness-95 shadow-lg shadow-primary-glow/20',
  ghost: 'text-text-2 hover:text-text hover:bg-card-hover',
  outline: 'border border-border text-text-2 hover:text-text hover:bg-card-hover hover:border-border-strong',
  danger: 'bg-danger/15 text-danger hover:bg-danger/25 border border-danger/30',
  subtle: 'bg-card text-text-2 hover:text-text hover:bg-card-hover border border-border',
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: 'sm' | 'md'
}

export function Button({ variant = 'primary', size = 'md', className, ...rest }: ButtonProps) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-2 font-medium transition-all disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'rounded-[var(--radius-sm)] px-3 py-1 text-xs' : 'rounded-[var(--radius-md)] px-4 py-2 text-sm',
        buttonVariants[variant],
        className,
      )}
      {...rest}
    />
  )
}

// ---------------- 表单控件 ----------------

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-2 block text-[13px] font-medium text-text-2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-text-muted">{hint}</span>}
    </label>
  )
}

const inputClass =
  'w-full rounded-[var(--radius-sm)] border border-border bg-surface-2 px-3 py-2 text-sm text-text placeholder:text-text-muted outline-none transition-all focus:border-[var(--border-strong)] focus:shadow-[0_0_0_3px_var(--primary-glow)]'

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(inputClass, className)} {...rest} />
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(inputClass, 'resize-y leading-relaxed', className)} {...rest} />
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(inputClass, 'cursor-pointer appearance-none', className)} {...rest}>
      {children}
    </select>
  )
}

// ---------------- Switch ----------------

interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: string
}

export function Switch({ checked, onChange, label }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex items-center gap-2"
    >
      <span
        className={cn(
          'relative h-5 w-9 rounded-full transition-colors',
          checked ? 'bg-brand-gradient shadow-[0_0_12px_var(--primary-glow)]' : 'bg-border-strong',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all',
            checked ? 'left-[18px]' : 'left-0.5',
          )}
        />
      </span>
      {label && <span className="text-sm text-text-2">{label}</span>}
    </button>
  )
}

// ---------------- Card ----------------

export function Card({ className, children, onClick }: { className?: string; children: ReactNode; onClick?: () => void }) {
  return (
    <div
      onClick={onClick}
      className={cn(
        'glass rounded-[var(--radius-lg)] p-4',
        onClick && 'cursor-pointer transition-all hover:border-border-strong hover:shadow-[var(--shadow-card-hover)]',
        className,
      )}
    >
      {children}
    </div>
  )
}

// ---------------- Modal ----------------

interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
  width?: number
}

export function Modal({ open, onClose, title, children, footer, width = 480 }: ModalProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-full max-h-[85vh] overflow-auto rounded-[var(--radius-lg)] border border-border bg-surface p-4 shadow-xl"
        style={{ maxWidth: width }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-medium text-text">{title}</span>
          <button onClick={onClose} className="rounded p-1 text-text-muted hover:text-text">
            <XCircle size={16} />
          </button>
        </div>
        <div>{children}</div>
        {footer && <div className="mt-4 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  )
}

// ---------------- ConfirmModal ----------------

interface ConfirmModalProps {
  open: boolean
  title: string
  message?: string
  children?: ReactNode
  confirmText?: string
  cancelText?: string
  danger?: boolean
  onConfirm: () => void
  onClose: () => void
}

export function ConfirmModal({
  open,
  title,
  message,
  children,
  confirmText = '确定',
  cancelText = '取消',
  danger,
  onConfirm,
  onClose,
}: ConfirmModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      width={380}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {cancelText}
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={() => {
              onConfirm()
              onClose()
            }}
          >
            {confirmText}
          </Button>
        </>
      }
    >
      {message && <p className="text-sm leading-relaxed text-text-2">{message}</p>}
      {children}
    </Modal>
  )
}

// ---------------- 空状态 / 加载 ----------------

export function Empty({ text }: { text: string }) {
  return <div className="py-10 text-center text-sm text-text-muted">{text}</div>
}

export function Loading({ text = '加载中…' }: { text?: string }) {
  return <div className="py-10 text-center text-sm text-text-muted">{text}</div>
}

// ---------------- Section 标题（设置面板） ----------------

export function PanelHeader({ title, desc }: { title: string; desc?: string }) {
  return (
    <div className="mb-5">
      <h2 className="text-xl font-semibold tracking-tight text-text">{title}</h2>
      {desc && <p className="mt-1 text-[13px] text-text-2">{desc}</p>}
    </div>
  )
}

// ---------------- Slider（带数值显示 + 重置按钮） ----------------

interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  defaultValue?: number
  onChange: (value: number) => void
  /** 值的格式化显示（如保留小数位） */
  format?: (v: number) => string
}

/**
 * 滑块组件：青色 handle + 浅灰轨道，右侧显示数值，带重置按钮。
 * 样式参考 airi 的 Slider 控件。
 */
export function Slider({ label, value, min, max, step = 0.01, defaultValue, onChange, format }: SliderProps) {
  const displayValue = format ? format(value) : value.toFixed(2)
  const showReset = defaultValue !== undefined && Math.abs(value - defaultValue) > 0.001
  const percent = ((value - min) / (max - min)) * 100

  return (
    <div className="py-1.5">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[13px] text-text-2">{label}</span>
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium tabular-nums text-text-muted">{displayValue}</span>
          {showReset && (
            <button
              onClick={() => onChange(defaultValue!)}
              className="text-text-muted transition-colors hover:text-primary-400"
              title="重置为默认值"
            >
              <RotateCcw size={11} strokeWidth={2} />
            </button>
          )}
        </div>
      </div>
      <div className="relative flex items-center">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="slider-cyber w-full"
          style={{
            background: `linear-gradient(to right, var(--primary-400) 0%, var(--primary-400) ${percent}%, var(--bg-surface-2) ${percent}%, var(--bg-surface-2) 100%)`,
          }}
        />
      </div>
    </div>
  )
}

// ---------------- SegmentedControl（分段选择器） ----------------

interface SegmentedControlProps<T extends string | number> {
  options: Array<{ value: T; label: string }>
  value: T
  onChange: (value: T) => void
}

/**
 * 分段控件：平铺选项，选中态浅蓝底 + 主色文字。
 * 用于 FPS 选择（30/60/∞）和眨眼模式（Auto/Force）。
 */
export function SegmentedControl<T extends string | number>({ options, value, onChange }: SegmentedControlProps<T>) {
  return (
    <div className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] border border-border bg-surface-2 p-1">
      {options.map((opt) => (
        <button
          key={String(opt.value)}
          onClick={() => onChange(opt.value)}
          className={cn(
            'rounded-[calc(var(--radius-sm)-4px)] px-3 py-1 text-xs font-medium transition-all',
            value === opt.value
              ? 'bg-brand-gradient text-[var(--on-brand)] shadow-[0_0_8px_var(--primary-glow)]'
              : 'text-text-muted hover:text-text',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

// ---------------- Accordion（折叠面板） ----------------

interface AccordionItemProps {
  title: string
  icon?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}

/**
 * 折叠面板项：标题行带图标 + chevron 箭头，点击展开/收起。
 * 用于角色模型设置的分区展示。
 */
export function AccordionItem({ title, icon, defaultOpen = true, children }: AccordionItemProps) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className="glass overflow-hidden rounded-[var(--radius-lg)]">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-card-hover"
      >
        <div className="flex items-center gap-2">
          {icon && <span className="text-primary-400">{icon}</span>}
          <span className="text-sm font-semibold text-text">{title}</span>
        </div>
        <ChevronDown
          size={16}
          strokeWidth={2}
          className={cn('text-text-muted transition-transform duration-200', open && 'rotate-180')}
        />
      </button>
      {open && (
        <div className="border-t border-border px-4 py-3">{children}</div>
      )}
    </div>
  )
}

// ---------------- SettingRow（设置行：标题 + 描述 + 控件） ----------------

interface SettingRowProps {
  title: string
  desc?: string
  children: ReactNode
  /** 是否展开子项（用于 Switch 开关控制子设置项的显示） */
  expanded?: boolean
}

/**
 * 设置行：左侧标题+描述，右侧控件（Switch/Select/SegmentedControl 等）。
 * 可选展开子项（expanded=true 时在下方显示 children 之外的额外内容）。
 */
export function SettingRow({ title, desc, children, expanded }: SettingRowProps) {
  return (
    <div className="py-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-text-2">{title}</div>
          {desc && <div className="mt-0.5 text-xs leading-relaxed text-text-muted">{desc}</div>}
        </div>
        <div className="shrink-0">{children}</div>
      </div>
      {expanded && <div className="mt-2 pl-1">{/* 子项由外部传入 */}</div>}
    </div>
  )
}
