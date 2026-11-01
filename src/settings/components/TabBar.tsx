/**
 * 设置页二级 tab 栏（剧情系统 / 记忆体共用）。
 * 样式与记忆体原有 tab 保持一致：圆角矩形、选中态用更亮的边框 + 浅底。
 */
import { type ReactNode } from 'react'
import { cn } from '../../lib/utils'

export interface TabItem<T extends string> {
  id: T
  label: string
  /** 标签右侧的角标（数字 / 小圆点），无则不渲染 */
  badge?: ReactNode
}

interface TabBarProps<T extends string> {
  tabs: readonly TabItem<T>[]
  value: T
  onChange: (id: T) => void
  /** 右侧附加内容（如「演出中」状态点） */
  right?: ReactNode
  className?: string
}

export function TabBar<T extends string>({ tabs, value, onChange, right, className }: TabBarProps<T>) {
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={cn(
            'inline-flex items-center gap-1 rounded-[var(--radius-md)] border px-3 py-1.5 text-xs font-medium transition-colors',
            value === t.id
              ? 'border-[var(--border-strong)] bg-surface-2 text-text'
              : 'border-border text-text-2 hover:border-border-strong hover:text-text',
          )}
        >
          {t.label}
          {t.badge}
        </button>
      ))}
      {right && <div className="ml-auto">{right}</div>}
    </div>
  )
}
