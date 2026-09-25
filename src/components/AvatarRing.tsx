/**
 * 头像光环组件（AvatarRing）—— airi 风格的头像视觉锚点。
 *
 * 设计：
 *   - 外圈：品牌色（深色青 / 浅色淡蓝）旋转光环 + 主色 drop-shadow 光晕。
 *   - 内圈：毛玻璃圆盘，承载头像图片或角色名首字。
 *   - 呼吸光效：box-shadow 在主色光晕与粉色光晕间脉动（2.6s 循环）。
 *   - 点击可触发折叠/展开切换（FloatingDock 用）。
 *
 * 粉色点缀作为品牌锚点贯穿深浅两套主题。
 */
import { motion } from 'framer-motion'
import { cn } from '../lib/utils'

interface AvatarRingProps {
  /** 头像图片地址；缺省时显示 name 首字 */
  src?: string | null
  /** 角色名（用于占位首字与 alt） */
  name?: string
  /** 尺寸（像素） */
  size?: number
  /** 点击回调（FloatingDock 用作折叠/展开切换） */
  onClick?: () => void
  className?: string
}

export function AvatarRing({ src, name, size = 48, onClick, className }: AvatarRingProps) {
  const initial = (name?.trim()?.[0] ?? 'AI').toUpperCase()

  return (
    <motion.button
      type="button"
      onClick={onClick}
      whileHover={{ scale: 1.05 }}
      whileTap={{ scale: 0.95 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className={cn('relative shrink-0 cursor-pointer', className)}
      style={{ width: size, height: size }}
      aria-label={name ? `${name} 头像` : 'AI 桌宠头像'}
    >
      {/* 旋转品牌渐变光环 */}
      <motion.span
        className="absolute inset-0 rounded-full"
        style={{ background: 'var(--gradient-brand)' }}
        animate={{ rotate: 360 }}
        transition={{ duration: 8, repeat: Infinity, ease: 'linear' }}
      />
      {/* 呼吸光晕：主色 ↔ 粉色脉动 */}
      <motion.span
        className="pointer-events-none absolute -inset-1 rounded-full"
        animate={{
          boxShadow: [
            '0 0 8px var(--primary-glow)',
            '0 0 16px var(--primary-glow), 0 0 6px var(--accent-glow)',
            '0 0 8px var(--primary-glow)',
          ],
        }}
        transition={{ duration: 2.6, repeat: Infinity, ease: 'easeInOut' }}
      />
      {/* 内圈毛玻璃承载头像 */}
      <span
        className="glass-strong absolute inset-[3px] flex items-center justify-center overflow-hidden rounded-full"
        style={{ width: size - 6, height: size - 6 }}
      >
        {src ? (
          <img
            src={src}
            alt={name ?? '头像'}
            className="h-full w-full object-cover"
            draggable={false}
          />
        ) : (
          <span
            className="bg-brand-gradient bg-clip-text text-transparent font-semibold"
            style={{ fontSize: size * 0.36 }}
          >
            {initial}
          </span>
        )}
      </span>
    </motion.button>
  )
}
