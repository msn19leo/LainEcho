/**
 * 运行日志面板（设置页）：查看主进程与各窗口的运行日志。
 *
 * 数据源两层：
 *  - 内存环形缓冲（logs:get-buffer）：打开秒显当前会话最近 500 条；
 *  - 日志文件尾部（logs:read-tail）：手动加载，查看重启前的历史（解析自 latest.log）；
 * 实时 tail：订阅 logs:appended，新日志追加显示并自动滚动（向上翻阅时自动暂停，回到底部恢复）。
 * 过滤：级别（全部/信息/警告/错误）+ 来源（全部/主进程/各窗口）+ 文本搜索（不区分大小写）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Download, Eraser, FolderOpen } from 'lucide-react'
import type { LogEntry, LogEntryLevel, LogEntrySource } from '../../types'
import { api } from '../../api'
import { cn } from '../../lib/utils'

/** 列表渲染上限（超限只渲染最新的前 N 条，防 DOM 过大） */
const RENDER_LIMIT = 1500

/** 级别过滤选项 */
const LEVEL_FILTERS: Array<{ id: 'all' | LogEntryLevel; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'info', label: '信息' },
  { id: 'warn', label: '警告' },
  { id: 'error', label: '错误' },
]

/** 来源过滤选项 */
const SOURCE_FILTERS: Array<{ id: 'all' | LogEntrySource; label: string }> = [
  { id: 'all', label: '全部来源' },
  { id: 'main', label: '主进程' },
  { id: 'chat', label: '聊天' },
  { id: 'pet', label: '桌宠' },
  { id: 'settings', label: '设置' },
  { id: 'story', label: '剧情' },
  { id: 'editor', label: '编辑器' },
]

/** 级别 → 显示色（暗/亮主题下均用语义变量） */
const LEVEL_COLOR: Record<LogEntryLevel, string> = {
  info: 'text-text-2',
  warn: 'text-[var(--warning)]',
  error: 'text-[var(--danger)]',
}

/** 时间戳短格式（时:分:秒） */
function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function LogPanel() {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [levelFilter, setLevelFilter] = useState<'all' | LogEntryLevel>('all')
  const [sourceFilter, setSourceFilter] = useState<'all' | LogEntrySource>('all')
  const [query, setQuery] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const [loadingFile, setLoadingFile] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  /** 自动滚动的暂停判定：用户向上滚动时暂停，滚回底部附近恢复 */
  const stickBottomRef = useRef(true)

  // 初始化：拉内存缓冲 + 订阅实时推送
  useEffect(() => {
    void api.logs.getBuffer().then(setEntries)
    const unsub = api.logs.onAppended((entry) => {
      setEntries((prev) => {
        const next = prev.length >= RENDER_LIMIT ? [...prev.slice(prev.length - RENDER_LIMIT + 1), entry] : [...prev, entry]
        return next
      })
    })
    return unsub
  }, [])

  // 自动滚动：新日志到达且处于底部跟随态时滚到底
  useEffect(() => {
    if (autoScroll && stickBottomRef.current) {
      const el = listRef.current
      if (el) el.scrollTop = el.scrollHeight
    }
  }, [entries, autoScroll])

  // 过滤（内存计算，条目量级 ≤1500 无压力）
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return entries.filter((e) => {
      if (levelFilter !== 'all' && e.level !== levelFilter) return false
      if (sourceFilter !== 'all' && e.source !== sourceFilter) return false
      if (q && !e.msg.toLowerCase().includes(q) && !e.source.includes(q)) return false
      return true
    })
  }, [entries, levelFilter, sourceFilter, query])

  // 渲染窗口：超限只取最新前 N 条（提示截断）
  const visible = filtered.length > RENDER_LIMIT ? filtered.slice(filtered.length - RENDER_LIMIT) : filtered
  const errorCount = entries.filter((e) => e.level === 'error').length

  /** 清空当前会话日志：先清本地列表，主进程清缓冲与 latest.log（广播回一条"已清空"标记自动到达） */
  const clearLog = async () => {
    setEntries([])
    try {
      await api.logs.clear()
    } catch {
      // 清空失败静默（缓冲仍会继续积累）
    }
  }

  /** 加载日志文件尾部（重启前历史），替换当前列表 */
  const loadFileTail = async () => {
    setLoadingFile(true)
    try {
      const { entries: fileEntries } = await api.logs.readFileTail()
      if (fileEntries.length > 0) setEntries(fileEntries)
    } finally {
      setLoadingFile(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* 统计 + 操作行 */}
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs text-text-muted">
          共 {entries.length} 条{errorCount > 0 && <span className="ml-2 text-[var(--danger)]">错误 {errorCount} 条</span>}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void loadFileTail()}
            disabled={loadingFile}
            className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-border px-2.5 py-1.5 text-xs text-text-2 transition hover:border-border-strong hover:text-text disabled:opacity-50"
          >
            <Download size={14} strokeWidth={1.75} />
            {loadingFile ? '加载中…' : '加载重启前日志'}
          </button>
          <button
            onClick={() => void clearLog()}
            className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-border px-2.5 py-1.5 text-xs text-text-2 transition hover:border-border-strong hover:text-text"
          >
            <Eraser size={14} strokeWidth={1.75} />
            清空日志
          </button>
          <button
            onClick={() => void api.logs.openFolder()}
            className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-border px-2.5 py-1.5 text-xs text-text-2 transition hover:border-border-strong hover:text-text"
          >
            <FolderOpen size={14} strokeWidth={1.75} />
            打开日志文件夹
          </button>
        </div>
      </div>

      {/* 过滤器 */}
      <div className="glass flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] p-3">
        <div className="flex items-center gap-1">
          {LEVEL_FILTERS.map((f) => (
            <FilterChip key={f.id} active={levelFilter === f.id} onClick={() => setLevelFilter(f.id)}>
              {f.label}
            </FilterChip>
          ))}
        </div>
        <div className="mx-1 h-4 w-px bg-[var(--border)]" />
        <div className="flex items-center gap-1">
          {SOURCE_FILTERS.map((f) => (
            <FilterChip key={f.id} active={sourceFilter === f.id} onClick={() => setSourceFilter(f.id)}>
              {f.label}
            </FilterChip>
          ))}
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索日志内容…"
          className="ml-auto min-w-[160px] flex-1 rounded-[var(--radius-sm)] border border-border bg-transparent px-2.5 py-1.5 text-xs text-text outline-none placeholder:text-text-muted focus:border-[var(--primary-400)] sm:max-w-60"
        />
      </div>

      {/* 日志列表 */}
      <div
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget
          stickBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
        }}
        className="selectable h-[480px] overflow-y-auto rounded-[var(--radius-md)] border border-border bg-[var(--bg-surface-2)]/60 p-3 font-mono text-xs leading-relaxed"
      >
        {visible.length === 0 ? (
          <div className="flex h-full items-center justify-center text-text-muted">暂无符合条件的日志</div>
        ) : (
          visible.map((e, i) => (
            <div key={`${e.ts}-${i}`} className="flex gap-2 border-b border-border/40 py-1 last:border-b-0">
              <span className="shrink-0 select-none text-text-tertiary">{fmtTime(e.ts)}</span>
              <span className={cn('w-10 shrink-0 font-medium', LEVEL_COLOR[e.level])}>{levelTag(e.level)}</span>
              <span className="w-16 shrink-0 select-none truncate text-text-tertiary" title={e.source}>
                {sourceTag(e.source)}
              </span>
              <span className={cn('min-w-0 whitespace-pre-wrap break-all', LEVEL_COLOR[e.level])}>{e.msg}</span>
            </div>
          ))
        )}
      </div>

      {/* 底部状态 */}
      <div className="flex items-center justify-between text-xs text-text-muted">
        <span>显示 {visible.length} 条{filtered.length !== entries.length && `（过滤自 ${entries.length} 条）`}</span>
        <label className="flex cursor-pointer items-center gap-1.5 select-none">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
            className="h-3.5 w-3.5 accent-[var(--primary-500)]"
          />
          自动滚动到底部
        </label>
      </div>
    </div>
  )
}

/** 级别短标签 */
function levelTag(level: LogEntryLevel): string {
  return level === 'error' ? 'ERR' : level === 'warn' ? 'WARN' : 'INFO'
}

/** 来源显示名（main 主进程 / 窗口名） */
function sourceTag(source: string): string {
  const map: Record<string, string> = { main: '主进程', chat: '聊天', pet: '桌宠', settings: '设置', story: '剧情', editor: '编辑器' }
  return map[source] ?? source
}

/** 过滤 chip 按钮 */
function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'rounded-full border px-2.5 py-1 text-xs transition-colors',
        active ? 'border-[var(--primary-400)] bg-primary-500/10 text-text' : 'border-border text-text-2 hover:border-border-strong hover:text-text',
      )}
    >
      {children}
    </button>
  )
}
