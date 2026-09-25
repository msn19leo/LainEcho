/**
 * 设计令牌的 JS 侧镜像 —— 供 inline style / styled 风格 / 复杂动画直接读取。
 *
 * 单一真源仍是 src/index.css 的 CSS 变量；本文件把「不随主题变化的结构性常量」
 * （圆角、动效曲线、间距基准）以 TS 常量导出，把「随主题变化的颜色」以
 * `var(--xxx)` 字符串导出，确保 JS 侧引用与 CSS 侧始终同源、主题切换即时生效。
 *
 * 配色核心原则（与 index.css 一致）：
 *   - 禁止紫色系。
 *   - 浅色：白底 + 浅蓝 #E8F4FD→#4A9EFF；深色：黑底 + 青 #00D4FF→#0088CC。
 *   - 点缀粉 #FFB6C1→#FF8A9E（深色强调 #FF6B8A）。
 */

/** 圆角哲学：主容器 24px，按钮/头像 16px，输入框 12px（禁止 4/6px） */
export const radius = {
  sm: 'var(--radius-sm)', // 12px 输入框
  md: 'var(--radius-md)', // 16px 按钮/头像
  lg: 'var(--radius-lg)', // 24px 主容器
  xl: 'var(--radius-xl)', // 28px 大型面板
  full: 'var(--radius-full)',
} as const

/** 间距韵律：基础单位 8px；内边距 16/24px，外边距 12/20px */
export const spacing = {
  base: 8,
  pad: { sm: 16, md: 24 },
  margin: { sm: 12, md: 20 },
} as const

/** 品牌色（随主题切换，统一用 var() 引用） */
export const color = {
  primary: {
    100: 'var(--primary-100)',
    400: 'var(--primary-400)',
    500: 'var(--primary-500)',
    600: 'var(--primary-600)',
    700: 'var(--primary-700)',
    glow: 'var(--primary-glow)',
  },
  accent: {
    300: 'var(--accent-300)',
    400: 'var(--accent-400)',
    500: 'var(--accent-500)',
    600: 'var(--accent-600)',
    glow: 'var(--accent-glow)',
  },
  text: {
    primary: 'var(--text-primary)',
    secondary: 'var(--text-secondary)',
    tertiary: 'var(--text-tertiary)',
  },
  bg: {
    base: 'var(--bg-base)',
    surface: 'var(--bg-surface)',
    surface2: 'var(--bg-surface-2)',
    panel: 'var(--bg-panel)',
    region: 'var(--bg-region)',
  },
  border: {
    subtle: 'var(--border-subtle)',
    strong: 'var(--border-strong)',
  },
} as const

/** 品牌色（随主题切换；原为渐变，现单色化——变量名保留以兼容既有消费点） */
export const gradient = {
  brand: 'var(--gradient-brand)', // 深色青 / 浅色淡蓝（纯色）
  primary: 'var(--gradient-primary)', // 同上（纯色）
  accent: 'var(--gradient-accent)', // 同上（纯色）
} as const

/** 毛玻璃规格：blur(20px) + 主色调半透明背景 + 主色 0.15 边框 */
export const glass = {
  bg: 'var(--glass-bg)',
  border: 'var(--glass-border)',
  blur: 'var(--glass-blur)',
  /** 直接用于 inline style 的毛玻璃样式对象 */
  style: {
    background: 'var(--glass-bg)',
    backdropFilter: 'blur(var(--glass-blur))',
    WebkitBackdropFilter: 'blur(var(--glass-blur))',
    border: '1px solid var(--glass-border)',
  } as React.CSSProperties,
} as const

/** 光晕（airi 视觉辨识度关键：渐变/边框叠加主色或粉 drop-shadow） */
export const glow = {
  primary: 'var(--shadow-glow-primary)',
  accent: 'var(--shadow-glow-accent)',
  card: 'var(--shadow-card)',
  cardHover: 'var(--shadow-card-hover)',
} as const

/** 动效曲线（动效强度 7/10）—— framer-motion BezierDefinition 四元数组 */
export const easing = {
  /** 弹性入场：cubic-bezier(0.34, 1.56, 0.64, 1) —— 规范指定的弹性曲线 */
  spring: [0.34, 1.56, 0.64, 1] as [number, number, number, number],
  /** 标准缓出：cubic-bezier(0.16, 1, 0.3, 1) */
  out: [0.16, 1, 0.3, 1] as [number, number, number, number],
  /** 标准缓入缓出：cubic-bezier(0.4, 0, 0.2, 1) */
  inOut: [0.4, 0, 0.2, 1] as [number, number, number, number],
} as const

/** 动效时长（秒） */
export const duration = {
  fast: 0.2, // 悬浮反馈
  base: 0.4, // 入场动画（规范要求 0.4s）
  slow: 0.6, // 大面板展开
} as const
