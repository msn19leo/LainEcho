/**
 * 统一动效参数（framer-motion tokens）—— 动效强度 7/10。
 *
 * 规范要求：
 *   - 入场：scale(0.92) + opacity(0) → scale(1) + opacity(1)，持续 0.4s，
 *     缓动 cubic-bezier(0.34, 1.56, 0.64, 1)（弹性效果）。
 *   - 悬浮反馈：上浮 -4px，阴影加深，过渡 0.2s。
 *   - 打字机光标：流光渐变闪烁（见 index.css .streaming-cursor）。
 *
 * 性能：动画仅使用 transform 与 opacity，触发 GPU 加速。
 */
import type { Transition, Variants } from 'framer-motion'
import { duration, easing } from './tokens'

/** 弹性曲线（规范指定的入场缓动）—— framer-motion BezierDefinition 四元数组 */
export const springElastic: [number, number, number, number] = [0.34, 1.56, 0.64, 1]

/** 标准弹性过渡（用于 layout 动画、指示器位移） */
export const springSoft: Transition = { type: 'spring', stiffness: 320, damping: 24, mass: 0.8 }
export const springSnappy: Transition = { type: 'spring', stiffness: 420, damping: 20, mass: 0.7 }

/**
 * 弹性入场（强度 7 核心）：scale 0.92→1 + opacity 0→1，0.4s 弹性曲线。
 * 用于面板、卡片、消息气泡等所有需要「出现」反馈的元素。
 */
export const popIn = {
  initial: { opacity: 0, scale: 0.92 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.92 },
  transition: { duration: duration.base, ease: springElastic },
} as const

/** 淡入上移（保留作为轻量入场，用于列表逐项错落） */
export const fadeSlideUp = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 8 },
  transition: { duration: duration.base, ease: easing.out },
} as const

/** 弹性淡入上移（消息气泡主用：scale + y 双重反馈，强度 7） */
export const popSlideUp = {
  initial: { opacity: 0, y: 12, scale: 0.96 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: 8, scale: 0.96 },
  transition: { duration: duration.base, ease: springElastic },
} as const

/** 会话侧边栏 Drawer 的左右滑入滑出 */
export const drawerSlide = {
  initial: { x: '-100%' },
  animate: { x: 0 },
  exit: { x: '-100%' },
  transition: springSoft,
} as const

/**
 * 悬浮反馈 Variants（规范：上浮 -4px，0.2s）。
 * 用于 motion.button / motion.div 的 whileHover。
 */
export const hoverLift = {
  rest: { y: 0 },
  hover: { y: -4, transition: { duration: duration.fast, ease: easing.out } },
} satisfies Variants

/** 悬浮 + 轻微放大（按钮、卡片悬浮态） */
export const hoverLiftScale = {
  rest: { y: 0, scale: 1 },
  hover: {
    y: -4,
    scale: 1.02,
    transition: { duration: duration.fast, ease: easing.out },
  },
} satisfies Variants

/** 按压反馈（whileTap） */
export const tapPress = { scale: 0.97 } as const
