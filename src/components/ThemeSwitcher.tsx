/**
 * 主题切换开关（独立原子组件）。
 *
 * 设计：
 *   - 三段式 segmented control：深色 / 浅色 / 跟随系统，月亮/太阳/显示器图标。
 *   - 选中态使用品牌渐变底 + 主色光晕；未选态中性文字。
 *   - 切换走 useSettingsStore.setTheme，自动 applyTheme 到 <html data-theme>，
 *     并持久化到主进程 settings.json，跨窗口同步（其他窗口 focus 时刷新）。
 *
 * 从 SettingsLayout 解耦后，聊天主界面、浮动 Dock 均可直接复用。
 */
import { motion } from 'framer-motion'
import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react'
import { useSettingsStore } from '../store/settingsStore'
import type { ThemeMode } from '../types'
import { cn } from '../lib/utils'
import { springSoft } from '../lib/motion'

interface ThemeOption {
  value: ThemeMode
  label: string
  icon: LucideIcon
}

const THEMES: ThemeOption[] = [
  { value: 'dark', label: '深色', icon: Moon },
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'system', label: '系统', icon: Monitor },
]

interface ThemeSwitcherProps {
  /** 紧凑模式：仅显示图标，隐藏文字（用于空间受限的顶栏） */
  compact?: boolean
  className?: string
}

export function ThemeSwitcher({ compact = false, className }: ThemeSwitcherProps) {
  const theme = useSettingsStore((s) => s.settings.theme)
  const setTheme = useSettingsStore((s) => s.setTheme)

  return (
    <div
      className={cn(
        'glass relative flex items-center gap-1 rounded-[var(--radius-full)] p-1',
        className,
      )}
    >
      {THEMES.map(({ value, label, icon: Icon }) => {
        const active = theme === value
        return (
          <button
            key={value}
            onClick={() => void setTheme(value)}
            title={label}
            aria-pressed={active}
            className={cn(
              'relative z-10 flex items-center gap-1.5 rounded-[var(--radius-full)] px-3 py-1.5 text-xs transition-colors duration-200',
              active
                ? 'text-[var(--on-brand)]'
                : 'text-text-2 hover:text-text',
            )}
          >
            {active && (
              <motion.span
                layoutId="theme-active-pill"
                transition={springSoft}
                className="bg-brand-gradient glow-primary absolute inset-0 -z-10 rounded-[var(--radius-full)]"
              />
            )}
            <Icon size={14} strokeWidth={active ? 2.25 : 1.75} />
            {!compact && <span className="font-medium">{label}</span>}
          </button>
        )
      })}
    </div>
  )
}
