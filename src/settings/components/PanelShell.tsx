/**
 * 设置页骨架原语：PanelShell（宽度档 + 可选右栏）/ Section（分组容器，可折叠）/ SettingRow（设置行）。
 * 规格见 docs/settings-redesign.md §3。
 *
 * 约定：
 * - 内容区不使用毛玻璃 / 品牌渐变 / 光晕（装饰预算集中在左侧导航与吸顶标题条）。
 * - 一个 Section 只允许一个边框，内部行用分隔线，禁止 Section 内再嵌 Card。
 * - SettingRow 的控件区宽度固定，保证所有行控件左边缘对齐成一条竖线。
 * - 可选中列表项的选中/未选中色只能用下方 SELECTABLE_* 常量，避免各处漂移。
 */
import { useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '../../lib/utils'

// ---------------- 可选中列表项的统一色 ----------------

/**
 * 可选中列表项的统一选中态。
 * Genie 角色模型 / SBV2 声线 / MiMo 参考音频三处共用 —— 改这里三处同步。
 * 历史问题：SBV2 曾单独用 `border-brand bg-brand-gradient/10`，渐变类加 `/10` 不生效，
 * 表现为只有亮边框没有底色，与另两处明显不一致。
 */
export const SELECTABLE_ON = 'border-[var(--primary-400)] bg-primary-500/10'
export const SELECTABLE_OFF = 'border-border bg-surface-2/50 hover:border-border-strong'

// ---------------- PanelShell ----------------

export type PanelWidth = 'narrow' | 'medium' | 'wide'

const WIDTH_CLASS: Record<PanelWidth, string> = {
  narrow: 'max-w-[800px]',
  medium: 'max-w-[600px]',
  wide: 'max-w-[864px]',
}

interface PanelShellProps {
  children: ReactNode
  /** 宽度档：窄=纯表单 720 / 中=600+右栏 / 宽=表格日志 864 */
  width?: PanelWidth
  /** 右栏内容。传入时才切 600 + 240 布局。 */
  aside?: ReactNode
}

/**
 * 面板容器：负责内容区内边距、宽度上限与可选右栏。
 *
 * 一律居中（mx-auto）：设置窗没有 maxWidth，可被拉宽或最大化，贴左会让右侧留白
 * 随窗口宽度无上限增长（1250 宽时已空 370px）。居中在任意窗口宽度下都成立。
 *
 * 右栏**不能贴右**，必须与内容列连成一个 908 的整体一起居中，否则中间会裂开一道缝。
 * 声明为 medium 但没有 aside 时按窄档渲染 —— 否则右侧会空出一大块。
 */
export function PanelShell({ children, width = 'narrow', aside }: PanelShellProps) {
  if (aside) {
    return (
      <div className="mx-auto flex max-w-[908px] items-start gap-5 px-6 py-5">
        <div className="min-w-0 flex-1">{children}</div>
        <aside className="sticky top-[60px] w-[240px] shrink-0">{aside}</aside>
      </div>
    )
  }
  const effective: PanelWidth = width === 'medium' ? 'narrow' : width
  return <div className={cn('mx-auto px-6 py-5', WIDTH_CLASS[effective])}>{children}</div>
}

// ---------------- Section ----------------

interface SectionProps {
  /** 分组标题（11px 灰色小字，不带图标） */
  title?: string
  /** 标题右侧补充说明（可选，同样 11px） */
  hint?: string
  children: ReactNode
  className?: string
  /** 可折叠：标题进容器内并带 chevron，整行可点。用于分区多且长、需要跳读的面板。 */
  collapsible?: boolean
  /** 折叠初始状态（仅 collapsible 时有效） */
  defaultOpen?: boolean
}

/**
 * 分组容器：一个小标题 + 一个带边框的容器，内部行用分隔线。
 * 一个 Section 只画一个边框 —— 这是替代「每个开关一张卡片」的核心。
 *
 * collapsible 形态（标题在容器内）用于「AI 模型接入」：4 个分区展开后能到 1500px，
 * 收起后一屏能看到全部分区，点击标题展开要看的那一块。
 */
export function Section({
  title,
  hint,
  children,
  className,
  collapsible = false,
  defaultOpen = true,
}: SectionProps) {
  const [open, setOpen] = useState(defaultOpen)

  if (collapsible && title) {
    return (
      <section className={cn('mb-2.5 last:mb-0', className)}>
        <div className="overflow-hidden rounded-[var(--radius-lg)] border border-border bg-card/70">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors hover:bg-card-hover"
          >
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="shrink-0 text-[12.5px] font-medium text-text">{title}</span>
              {hint && <span className="truncate text-[11px] text-text-muted">{hint}</span>}
            </span>
            <ChevronDown
              size={14}
              strokeWidth={1.75}
              className={cn('shrink-0 text-text-muted transition-transform', open && 'rotate-180')}
            />
          </button>
          {open && <div className="divide-y divide-border border-t border-border">{children}</div>}
        </div>
      </section>
    )
  }

  return (
    <section className={cn('mb-5 last:mb-0', className)}>
      {(title || hint) && (
        <div className="mb-1.5 flex items-baseline gap-2 px-1">
          {title && <span className="text-[11px] font-medium tracking-wide text-text-muted">{title}</span>}
          {hint && <span className="text-[11px] text-text-muted/70">{hint}</span>}
        </div>
      )}
      <div className="divide-y divide-border overflow-hidden rounded-[var(--radius-lg)] border border-border bg-card/70">
        {children}
      </div>
    </section>
  )
}

// ---------------- SettingRow ----------------

interface SettingRowProps {
  title: string
  /** 说明文字：建议控制在一行内，需要长说明请改用 stacked + 自定义内容 */
  desc?: ReactNode
  /** 右侧控件（Switch / Select / Slider 等） */
  children?: ReactNode
  /** 整行可点：点行等于触发控件。子控件内部已 stopPropagation，不会双触发。 */
  onClick?: () => void
  /** 禁用态：整行降透明度（不只置灰控件） */
  disabled?: boolean
  /** 控件列宽度，默认 180px。所有行必须一致，否则左边缘不齐。 */
  controlWidth?: number
  /** 纵向布局：控件换行到标题下方并占满宽度（输入框 / 文本域 / 长滑块） */
  stacked?: boolean
}

/**
 * 设置行：左侧标题 + 说明，右侧固定宽度的控件列。
 * 控件左边缘在整页对齐成一条竖线，是本方案「不吵」的主要来源。
 */
export function SettingRow({
  title,
  desc,
  children,
  onClick,
  disabled = false,
  controlWidth = 180,
  stacked = false,
}: SettingRowProps) {
  const interactive = Boolean(onClick) && !disabled

  return (
    <div
      onClick={interactive ? onClick : undefined}
      className={cn(
        'flex gap-3 px-4 py-3 transition-colors',
        stacked ? 'flex-col' : 'min-h-[52px] items-center',
        interactive && 'cursor-pointer hover:bg-card-hover',
        disabled && 'opacity-45',
      )}
    >
      <div className={cn('min-w-0', stacked ? '' : 'flex-1')}>
        <div className="text-[13px] font-medium text-text">{title}</div>
        {desc && <div className="mt-0.5 text-[11.5px] leading-relaxed text-text-muted">{desc}</div>}
      </div>
      {children && (
        <div
          className={cn('shrink-0', stacked ? 'w-full' : 'flex justify-end')}
          style={stacked ? undefined : { width: controlWidth }}
          // 行可点时阻止冒泡：否则点开关会同时触发「控件自身」与「整行」，来回抵消
          onClick={(e) => {
            if (interactive) e.stopPropagation()
          }}
        >
          {children}
        </div>
      )}
    </div>
  )
}
