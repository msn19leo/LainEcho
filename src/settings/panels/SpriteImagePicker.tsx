/**
 * 立绘图片选择器：缩略图网格 + 状态名 + 搜索。
 *
 * 为什么不用原生 select：立绘文件名通常是 01.webp / 02.webp 这种无意义编号，
 * 而立绘集本身有状态词表（微笑、温柔、害羞…），按图 + 状态名选才是可读的。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Search, X } from 'lucide-react'
import { api } from '../../api'

interface Props {
  open: boolean
  spriteId: string
  images: string[]
  /** 文件名 → 状态标签（立绘集词表；无标签的图回落文件名） */
  labels: Record<string, string>
  /** 当前帧已选的图 */
  current: string
  /** 桌宠窗当前显示的那张（标「当前」） */
  liveFile?: string | null
  onPick: (file: string) => void
  onClose: () => void
}

/** 状态标签可能是一串同义词（"喜爱，满脸喜欢"）：网格里只取第一段，完整放 title */
function shortLabel(label: string): string {
  const first = label.split(/[，,]/)[0]?.trim() ?? ''
  return first || label
}

export function SpriteImagePicker({
  open,
  spriteId,
  images,
  labels,
  current,
  liveFile,
  onPick,
  onClose,
}: Props) {
  const [q, setQ] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setQ('')
    const t = setTimeout(() => inputRef.current?.focus(), 60)
    return () => clearTimeout(t)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const list = useMemo(() => {
    const kw = q.trim().toLowerCase()
    if (!kw) return images
    return images.filter(
      (f) => f.toLowerCase().includes(kw) || (labels[f] ?? '').toLowerCase().includes(kw),
    )
  }, [images, labels, q])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[82vh] w-full max-w-3xl flex-col overflow-hidden rounded-[var(--radius-lg)] border border-border bg-bg-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
          <span className="text-sm font-medium text-text">选择立绘</span>
          <span className="text-xs text-text-muted">{images.length} 张</span>
          <div className="ml-auto flex items-center gap-2 rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-1">
            <Search size={13} strokeWidth={1.75} className="text-text-muted" />
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索状态名或文件名"
              className="w-48 bg-transparent text-xs text-text outline-none placeholder:text-text-muted"
            />
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-text-muted transition-colors hover:text-text"
            title="关闭（Esc）"
          >
            <X size={16} strokeWidth={1.75} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {list.length === 0 ? (
            <p className="py-10 text-center text-xs text-text-muted">没有匹配的图片</p>
          ) : (
            <div className="grid grid-cols-4 gap-3 sm:grid-cols-5">
              {list.map((file) => {
                const label = labels[file]
                const active = file === current
                const isLive = !!liveFile && liveFile === file
                return (
                  <button
                    key={file}
                    type="button"
                    onClick={() => {
                      onPick(file)
                      onClose()
                    }}
                    title={label ? `${label}（${file}）` : file}
                    className={
                      'group relative rounded-[var(--radius-md)] border p-1.5 text-left transition-colors ' +
                      (active
                        ? 'border-primary-400 bg-primary-500/10'
                        : 'border-border hover:border-primary-400/60 hover:bg-card-hover')
                    }
                  >
                    <div className="flex h-24 items-center justify-center overflow-hidden rounded-[var(--radius-sm)] bg-bg">
                      <img
                        src={api.pet.spriteUrl(spriteId, file)}
                        alt={label ?? file}
                        loading="lazy"
                        decoding="async"
                        draggable={false}
                        className="max-h-full max-w-full object-contain"
                      />
                    </div>
                    <div className="mt-1 truncate text-center text-[11px] text-text-2">
                      {label ? shortLabel(label) : file}
                    </div>
                    <div className="truncate text-center text-[10px] text-text-muted">{file}</div>

                    {active && (
                      <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary-500 text-[var(--primary-foreground,#fff)]">
                        <Check size={11} strokeWidth={2.5} />
                      </span>
                    )}
                    {isLive && !active && (
                      <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[10px] leading-4 text-white">
                        当前
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <footer className="shrink-0 border-t border-border px-4 py-2 text-[11px] text-text-muted">
          点一张即可替换这一帧的图；带「当前」标记的是桌宠此刻正在显示的那张。
        </footer>
      </div>
    </div>
  )
}
