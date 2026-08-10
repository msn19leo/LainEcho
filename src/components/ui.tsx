/**
 * 通用 UI 原语：Button / Input / Textarea / Select / Switch / Modal / Card
 * 统一 AIRI 风格的深色卡片式设计。
 */
import { type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type TextareaHTMLAttributes, type SelectHTMLAttributes, useEffect } from 'react'
import { cn } from '../lib/utils'

// ---------------- Button ----------------

type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'danger' | 'subtle'

const buttonVariants: Record<ButtonVariant, string> = {
  primary:
    'bg-gradient-to-r from-accent to-accent-2 text-white hover:brightness-110 active:brightness-95 shadow-md shadow-accent/20',
  ghost: 'text-text-2 hover:text-text hover:bg-card-hover',
  outline: 'border border-border text-text hover:bg-card-hover hover:border-border-strong',
  danger: 'bg-danger/15 text-danger hover:bg-danger/25 border border-danger/30',
  subtle: 'bg-card text-text-2 hover:bg-card-hover hover:text-text border border-border',
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: 'sm' | 'md'
}

export function Button({ variant = 'primary', size = 'md', className, ...rest }: ButtonProps) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-1.5 text-sm',
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
      <span className="mb-1.5 block text-sm font-medium text-text-2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-text-muted">{hint}</span>}
    </label>
  )
}

const inputClass =
  'w-full rounded-lg border border-border bg-surface-2 px-3 py-1.5 text-sm text-text placeholder:text-text-muted outline-none transition focus:border-accent focus:ring-1 focus:ring-accent/40'

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
          'relative h-5 w-9 rounded-full transition',
          checked ? 'bg-accent' : 'bg-border-strong',
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
        'rounded-xl border border-border bg-card p-4',
        onClick && 'cursor-pointer transition hover:border-border-strong hover:bg-card-hover',
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
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="max-h-[85vh] overflow-auto rounded-2xl border border-border bg-panel p-5 shadow-2xl"
        style={{ width }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold text-text">{title}</h3>
          <button onClick={onClose} className="rounded p-1 text-text-muted hover:bg-card-hover hover:text-text">
            ✕
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
      <h2 className="text-lg font-semibold text-text">{title}</h2>
      {desc && <p className="mt-0.5 text-sm text-text-muted">{desc}</p>}
    </div>
  )
}
