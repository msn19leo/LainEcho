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
} from 'react'
import { X } from 'lucide-react'
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
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-[20px]" onClick={onClose}>
      <div
        className="glass-strong glow-primary max-h-[85vh] overflow-auto rounded-[var(--radius-xl)] p-6"
        style={{ width }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold text-text">{title}</h3>
          <button onClick={onClose} className="rounded-[var(--radius-sm)] p-1 text-text-muted hover:bg-card-hover hover:text-text">
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>
        <div>{children}</div>
        {footer && <div className="mt-5 flex justify-end gap-2">{footer}</div>}
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
      width={420}
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
