/**
 * 统一的图标底板容器：模拟 AIRI 的圆角方块图标观感。
 * 所有模块图标都包一层渐变底板 + 细边框，替代原本裸露的 emoji。
 *
 * 渐变方向严格遵循配色规范（禁止紫色系）：
 *   - primary：主色光晕底（青/蓝调），图标用主色
 *   - accent：粉色强调底（粉色光晕），图标用粉色
 *   - neutral：中性玻璃底
 */
import type { LucideIcon } from 'lucide-react'
import { cn } from '../lib/utils'

interface IconTileProps {
  icon: LucideIcon
  /** primary = 主色光晕底；accent = 粉色强调；neutral = 中性玻璃底 */
  gradient?: 'primary' | 'accent' | 'neutral'
  size?: 'xs' | 'sm' | 'md' | 'lg'
  className?: string
}

const sizeMap = { xs: 24, sm: 32, md: 44, lg: 56 } as const

export function IconTile({ icon: Icon, gradient = 'primary', size = 'md', className }: IconTileProps) {
  const px = sizeMap[size]
  const background =
    gradient === 'primary'
      ? 'linear-gradient(135deg, var(--primary-glow), rgba(0,212,255,0.08))'
      : gradient === 'accent'
        ? 'linear-gradient(135deg, var(--accent-glow), rgba(255,107,138,0.10))'
        : 'var(--bg-elevated)'
  const color = gradient === 'accent' ? 'var(--accent-400)' : 'var(--primary-400)'

  return (
    <div
      className={cn('flex shrink-0 items-center justify-center rounded-[var(--radius-md)]', className)}
      style={{ width: px, height: px, background, border: '1px solid var(--border-subtle)' }}
    >
      <Icon size={Math.round(px * 0.45)} strokeWidth={1.75} color={color} />
    </div>
  )
}
