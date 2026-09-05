/**
 * 桌宠窗上下文工具栏：显示当前会话上下文 token 用量 + 手动压缩历史按钮。
 * 位置约定：始终位于「会话收放按钮」左侧 ——
 *   - 展开态：内容框头部"收起"按钮的左边
 *   - 收起态：右下角"会话"胶囊的左边
 * token 用量来自主进程 ai:context-stats 广播（每次 AI 组装 / 手动压缩后更新）。
 */
import { Loader2, Wand2 } from 'lucide-react'
import type { ContextStats } from '../types'

interface PetContextToolbarProps {
  /** 当前会话的上下文 token 用量；null 表示尚未发送/无数据 */
  stats: ContextStats | null
  /** 模型上下文窗口 token 数（实时，跟随设置变更同步；0 = 不限制） */
  windowTokens: number
  /** 手动压缩进行中（禁用按钮 + 转圈） */
  compacting: boolean
  /** 压缩结果提示（"已压缩" / "失败：..."），短暂显示 */
  note: string | null
  /** 点击手动压缩 */
  onCompact: () => void
}

/** token 数格式化：>=1000 显示为 x.xk，其余原样 */
function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n >= 1000) {
    const k = n / 1000
    return `${k >= 100 ? k.toFixed(0) : k.toFixed(1).replace(/\.0$/, '')}k`
  }
  return String(n)
}

export function PetContextToolbar({ stats, windowTokens, compacting, note, onCompact }: PetContextToolbarProps) {
  // 已用来自广播 stats，窗口值用实时设置（跟随设置窗变更即时同步）
  const label = stats
    ? windowTokens > 0
      ? `${fmtTokens(stats.total)}/${fmtTokens(windowTokens)}`
      : fmtTokens(stats.total)
    : '—'
  return (
    <div className="app-no-drag flex shrink-0 items-center gap-1">
      <span
        className="max-w-[96px] select-none truncate rounded-full border border-[var(--border-strong)] bg-[var(--bg-surface)]/70 px-1.5 py-0.5 text-[10px] font-medium leading-[14px] text-text-muted"
        title={
          stats
            ? `上下文用量：已用 ${stats.total} / 窗口 ${windowTokens} token（system ${stats.system}，历史 ${stats.history}）`
            : '尚未发送消息'
        }
      >
        {note ?? label}
      </span>
      <button
        type="button"
        onClick={onCompact}
        disabled={compacting || !stats}
        title="压缩历史：把较早对话（最近 20 条之外）生成摘要，缩小上下文占用"
        className="flex h-[18px] w-[18px] items-center justify-center rounded-full border border-[var(--border-strong)] bg-[var(--bg-surface)]/70 text-text-muted transition-colors hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
      >
        {compacting ? <Loader2 size={11} className="animate-spin" /> : <Wand2 size={11} strokeWidth={2} />}
      </button>
    </div>
  )
}
