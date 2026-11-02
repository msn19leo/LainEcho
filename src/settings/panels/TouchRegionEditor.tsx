/**
 * 触摸命中区可视化编辑器：把桌宠窗截下来的角色图当底，直接在图上拖框。
 *
 * 坐标换算：区域的 x/y/w/h 是「相对角色包围盒」的 0~1，
 * 而图里只知道包围盒的像素位置，所以每次都要在两者之间换算一遍。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ImageOff, RefreshCw } from 'lucide-react'
import type { ModelProfile } from '../../types'
import { Button, Switch } from '../../components/ui'

type DragMode = 'move' | 'nw' | 'ne' | 'sw' | 'se'

/** 编辑器只关心这四个数与名字：Live2D 区域和立绘区域都能传进来 */
export type EditableRegion = {
  id: string
  label: string
  x: number
  y: number
  w: number
  h: number
}

interface Snapshot {
  image: string
  width: number
  height: number
  bounds: { x: number; y: number; w: number; h: number }
}

export function TouchRegionEditor<T extends EditableRegion>({
  snapshot,
  regions,
  parts,
  selectedId,
  refreshing,
  onSelect,
  onChange,
  onCommit,
  onRefresh,
  sideExtra,
}: {
  snapshot: Snapshot | null
  regions: T[]
  parts: ModelProfile['parts']
  selectedId: string | null
  refreshing: boolean
  onSelect: (id: string | null) => void
  onChange: (id: string, patch: Partial<T>) => void
  /** 拖动结束：把最后一帧的位置立即落盘（不能只靠防抖，关窗会丢） */
  onCommit: () => void
  onRefresh: () => void
  /** 右侧空白区的附加内容（如「从部件取一块」） */
  sideExtra?: React.ReactNode
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{
    mode: DragMode
    id: string
    startX: number
    startY: number
    orig: T
  } | null>(null)
  const [dragging, setDragging] = useState(false)
  // onChange 每次渲染都会变；放进 ref，拖动期间就不用反复解绑/重绑 window 监听
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])
  const onCommitRef = useRef(onCommit)
  useEffect(() => {
    onCommitRef.current = onCommit
  }, [onCommit])
  const [showParts, setShowParts] = useState(true)

  const b = snapshot?.bounds
  const toImagePct = useCallback(
    (r: EditableRegion) => {
      if (!snapshot || !b || b.w <= 0 || b.h <= 0) return { left: 0, top: 0, width: 0, height: 0 }
      return {
        left: ((b.x + r.x * b.w) / snapshot.width) * 100,
        top: ((b.y + r.y * b.h) / snapshot.height) * 100,
        width: ((r.w * b.w) / snapshot.width) * 100,
        height: ((r.h * b.h) / snapshot.height) * 100,
      }
    },
    [snapshot, b],
  )

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current
      const el = boxRef.current
      const snap = snapshot
      if (!drag || !el || !snap || !b) return
      const rect = el.getBoundingClientRect()
      // 屏幕位移 → 图片比例 → 角色包围盒比例
      const dx = ((e.clientX - drag.startX) / rect.width) * (snap.width / b.w)
      const dy = ((e.clientY - drag.startY) / rect.height) * (snap.height / b.h)
      const o = drag.orig
      const min = 0.02
      // 允许区域超出角色包围盒：否则框一贴到右/下边缘就再也拖不动了
      // （默认区域宽度 76%，四周只剩十几%可移动，手感像"卡住"）
      const LIMIT = 4
      let next: Partial<EditableRegion>
      if (drag.mode === 'move') {
        next = {
          x: clamp(o.x + dx, -LIMIT, LIMIT),
          y: clamp(o.y + dy, -LIMIT, LIMIT),
        }
      } else {
        let x = o.x
        let y = o.y
        let w = o.w
        let h = o.h
        if (drag.mode === 'nw' || drag.mode === 'sw') {
          // 左边跟随指针，右边固定
          const nx = Math.min(o.x + dx, o.x + o.w - min)
          w = o.x + o.w - nx
          x = nx
        }
        if (drag.mode === 'ne' || drag.mode === 'se') {
          w = Math.max(min, o.w + dx)
        }
        if (drag.mode === 'nw' || drag.mode === 'ne') {
          const ny = Math.min(o.y + dy, o.y + o.h - min)
          h = o.y + o.h - ny
          y = ny
        }
        if (drag.mode === 'sw' || drag.mode === 'se') {
          h = Math.max(min, o.h + dy)
        }
        next = { x, y, w, h }
      }
      // next 只含 x/y/w/h，T 必然都有这些字段
      onChangeRef.current(drag.id, next as Partial<T>)
    }
    const onUp = () => {
      const wasDragging = dragRef.current !== null
      dragRef.current = null
      setDragging(false)
      // 松手立刻落盘：只靠 300/800ms 防抖的话，拖完就关设置窗会丢掉这次编辑
      if (wasDragging) onCommitRef.current()
    }
    // 指针被系统取消（切窗口、触控板手势）时也要收尾，否则会卡在"一直拖着"的状态
    const onCancel = () => {
      const wasDragging = dragRef.current !== null
      dragRef.current = null
      setDragging(false)
      if (wasDragging) onCommitRef.current()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging, snapshot, b])

  const startDrag = (e: React.PointerEvent, r: T, mode: DragMode) => {
    e.stopPropagation()
    e.preventDefault()
    // 关键：没有指针捕获时，鼠标一移出窗口就收不到 pointermove，
    // 表现就是"往右/往下拖一会就卡住"（光标撞到窗口边缘）
    try {
      ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    } catch {
      // 某些环境不支持捕获：退化为普通监听
    }
    onSelect(r.id)
    dragRef.current = { mode, id: r.id, startX: e.clientX, startY: e.clientY, orig: { ...r } }
    setDragging(true)
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="text-sm font-medium text-text">区域编辑</div>
          {/* 立绘没有部件信息：不传 parts 时这个开关没有意义，直接隐藏 */}
          {!!parts && parts.length > 0 && (
            <label className="flex items-center gap-1.5 text-[11px] text-text-muted">
              部件参考框
              <Switch checked={showParts} onChange={setShowParts} />
            </label>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={refreshing}>
          <RefreshCw size={13} strokeWidth={1.75} className={refreshing ? 'animate-spin' : undefined} />
          按当前姿势重新截图
        </Button>
      </div>

      {/* items-start：避免右栏内容变高时把左栏（棋盘格容器）拉伸，
          容器一高，按百分比定位的区域框就会整体下移并被拉长 */}
      <div className="mt-2 flex items-start gap-3">
        <div
          className="relative w-[300px] shrink-0 overflow-hidden rounded-[var(--radius-md)] border border-border"
          style={{
            backgroundImage:
              'linear-gradient(45deg,#2a2a2a 25%,transparent 25%),linear-gradient(-45deg,#2a2a2a 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#2a2a2a 75%),linear-gradient(-45deg,transparent 75%,#2a2a2a 75%)',
            backgroundSize: '16px 16px',
            backgroundPosition: '0 0,0 8px,8px -8px,-8px 0px',
          }}
          onClick={() => onSelect(null)}
          ref={boxRef}
        >
          {snapshot ? (
            <>
              <img src={snapshot.image} alt="当前姿势" className="block w-full select-none" draggable={false} />

              {/* 角色包围盒：所有区域的百分比都以它为基准 */}
              {b && (
                <div
                  className="pointer-events-none absolute border border-dashed border-primary-400/40"
                  style={{
                    left: `${(b.x / snapshot.width) * 100}%`,
                    top: `${(b.y / snapshot.height) * 100}%`,
                    width: `${(b.w / snapshot.width) * 100}%`,
                    height: `${(b.h / snapshot.height) * 100}%`,
                  }}
                />
              )}

              {/* 部件参考框 */}
              {showParts &&
                (parts ?? []).map((p) => {
                  const style = toImagePct({ id: p.id, label: p.name, x: p.x, y: p.y, w: p.w, h: p.h })
                  return (
                    <div
                      key={p.id}
                      title={p.name}
                      className="pointer-events-none absolute border border-white/15"
                      style={{
                        left: `${style.left}%`,
                        top: `${style.top}%`,
                        width: `${style.width}%`,
                        height: `${style.height}%`,
                      }}
                    />
                  )
                })}

              {/* 可拖拽的区域 */}
              {regions.map((r) => {
                const style = toImagePct(r)
                const active = r.id === selectedId
                return (
                  <div
                    key={r.id}
                    onPointerDown={(e) => startDrag(e, r, 'move')}
                    // 阻止冒泡到容器：否则点/拖完区域会立刻被容器的"点空白取消选中"清掉
                    onClick={(e) => e.stopPropagation()}
                    className={
                      'absolute cursor-move border ' +
                      (active ? 'border-primary-300 bg-primary-400/20' : 'border-white/40 bg-white/5 hover:bg-white/10')
                    }
                    style={{ left: `${style.left}%`, top: `${style.top}%`, width: `${style.width}%`, height: `${style.height}%` }}
                  >
                    {/* 标签放在框内左上：贴着图顶边的区域如果放外面会被裁掉 */}
                    <span className="absolute left-0 top-0 rounded-br bg-black/55 px-1 text-[10px] leading-4 text-white">
                      {r.label}
                    </span>
                    {active &&
                      (['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
                        <span
                          key={corner}
                          onPointerDown={(e) => startDrag(e, r, corner)}
                          className="absolute h-2.5 w-2.5 rounded-sm border border-primary-200 bg-primary-500"
                          style={{
                            left: corner.includes('w') ? -5 : undefined,
                            right: corner.includes('e') ? -5 : undefined,
                            top: corner.includes('n') ? -5 : undefined,
                            bottom: corner.includes('s') ? -5 : undefined,
                            cursor: `${corner}-resize`,
                          }}
                        />
                      ))}
                  </div>
                )
              })}
            </>
          ) : (
            <div className="flex h-[220px] flex-col items-center justify-center gap-2 text-[11px] text-text-muted">
              <ImageOff size={20} strokeWidth={1.5} />
              点「按当前姿势重新截图」获取角色图
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1 text-[11px] leading-relaxed text-text-muted">
          <p>· 拖动框体可移动，拖四角可缩放；坐标会实时换算成百分比。</p>
          <p>· 虚线大框是「角色包围盒」，所有区域都相对它定位。</p>
          {!!parts && parts.length > 0 && <p>· 细实线是部件参考框（头部/身体/腿…），可用来对齐。</p>}
          <p>· 截图是当前姿势，头转动时不跟随；改完可以再截一张核对。</p>
          <p className="mt-2 text-text-2">
            · 区域重叠时面积更小的优先（脚画在腿上时脚生效）。
          </p>
          <p className="text-text-2">
            · 脚这类贴底部位，框要拉到画面最下方：角色包围盒会随呼吸浮动，只画到脚踝处会点不到脚底。
          </p>
          {sideExtra && <div className="mt-3">{sideExtra}</div>}
        </div>
      </div>
    </div>
  )
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}
