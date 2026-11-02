/**
 * 2D 立绘的触摸部位模块。
 *
 * 与 Live2D 的触摸模块并列、互不共用数据：
 * - 命中区相对"立绘内容框"（alpha 包围盒）归一化，换窗口/缩放都不影响；
 * - 触发的是立绘序列（多帧切图 + 每帧台词 + 各自保持时长），没有动作/表情；
 * - 区域按立绘集存（spriteTouchBySprite），换集就换一份配置。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Plus, Sparkles, Trash2, X } from 'lucide-react'
import type { CharacterSprite, SpriteTouchFrame, SpriteTouchRegion } from '../../types'
import { api } from '../../api'
import { toast } from '../../components/toast'
import { Button, Slider, Switch } from '../../components/ui'
import { resolveSpriteTouchRegions, useModelSettingsStore } from '../../store/modelSettingsStore'
import { makeBandRegions } from '../../lib/touch'
import { TouchRegionEditor } from './TouchRegionEditor'
import { SpriteImagePicker } from './SpriteImagePicker'

interface Snapshot {
  image: string
  width: number
  height: number
  bounds: { x: number; y: number; w: number; h: number }
  mode?: 'live2d' | 'sprite'
  spriteId?: string | null
  spriteFile?: string | null
}

/** 首次进入且没有任何配置时的编辑起点（不落盘，改了才写） */
const DEFAULT_REGIONS: SpriteTouchRegion[] = makeBandRegions().map((r) => ({
  id: r.id,
  label: r.label,
  x: r.x,
  y: r.y,
  w: r.w,
  h: r.h,
  frames: [],
  restore: true,
}))

export function SpriteTouchPanel({ spriteId }: { spriteId: string | null }) {
  const modelSettings = useModelSettingsStore((s) => s.settings)
  const modelLoaded = useModelSettingsStore((s) => s.loaded)
  const loadModelSettings = useModelSettingsStore((s) => s.load)
  const saveModelSettings = useModelSettingsStore((s) => s.save)

  const [sprite, setSprite] = useState<CharacterSprite | null>(null)
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<SpriteTouchRegion[] | null>(null)
  /** 正在选图的目标（regionId + 第几帧）；null = 弹层关闭 */
  const [picking, setPicking] = useState<{ regionId: string; frameIndex: number } | null>(null)
  /** 当前正在编辑第几帧（序列按钮条 + 单帧卡共用） */
  const [frameIndex, setFrameIndex] = useState(0)

  useEffect(() => {
    if (!modelLoaded) void loadModelSettings()
  }, [modelLoaded, loadModelSettings])

  // 立绘集元数据（图列表 + 名字）
  useEffect(() => {
    if (!spriteId) {
      setSprite(null)
      return
    }
    let alive = true
    void api.sprite
      .list()
      .then((list) => {
        if (alive) setSprite(list.find((s) => s.id === spriteId) ?? null)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [spriteId])

  const capture = useCallback(async () => {
    setRefreshing(true)
    const tryOnce = async () => {
      try {
        return await api.touch.snapshot()
      } catch {
        return null
      }
    }
    // 启动/切 tab 的瞬间桌宠窗可能还没就绪：失败后自动补两次，省得用户手动点
    let snap = await tryOnce()
    for (let i = 0; !snap && i < 2; i++) {
      await new Promise((r) => setTimeout(r, 600))
      snap = await tryOnce()
    }
    console.log(
      '[sprite-touch] snapshot ->',
      snap ? { mode: snap.mode, sid: snap.spriteId, w: snap.width, h: snap.height, bound: snap.bounds } : null,
    )
    if (snap) setSnapshot(snap)
    setRefreshing(false)
  }, [])

  useEffect(() => {
    setSnapshot(null)
    setSelectedId(null)
    setDraft(null)
    autoSelectedRef.current = false
    if (spriteId) void capture()
  }, [spriteId, capture])

  const persisted = resolveSpriteTouchRegions(modelSettings, spriteId)
  /** 是否"从未配置过"：用键是否存在区分，避免用户删光区域后被默认分区顶回来 */
  const hasConfig = !!spriteId && Object.prototype.hasOwnProperty.call(modelSettings.spriteTouchBySprite ?? {}, spriteId)
  const usingDefault = !hasConfig && draft === null
  const regions = draft ?? (usingDefault ? DEFAULT_REGIONS : persisted)

  /** 未加载完绝不写：否则会把默认分区当成用户配置覆盖磁盘 */
  const loadedRef = useRef(modelLoaded)
  loadedRef.current = modelLoaded
  const spriteIdRef = useRef<string | null>(spriteId)
  spriteIdRef.current = spriteId
  const pendingRef = useRef<SpriteTouchRegion[] | null>(null)
  const lastSpriteRef = useRef<string | null>(spriteId)

  const persist = (targetSpriteId: string, next: SpriteTouchRegion[]) => {
    if (!loadedRef.current) {
      console.warn('[sprite-touch] 模型设置尚未加载完成，跳过这次写入')
      return
    }
    void saveModelSettings({ spriteTouchBySprite: { [targetSpriteId]: next } }).catch((err) => {
      console.error('[sprite-touch] 保存失败', err)
      toast('保存立绘触摸区域失败')
    })
  }

  const flushPending = () => {
    const id = spriteIdRef.current
    const next = pendingRef.current
    if (!id || !next) return
    pendingRef.current = null
    persist(id, next)
  }

  /** 取最新区域：优先待写草稿，避免连续编辑用旧闭包互相覆盖 */
  const latestRegions = () => pendingRef.current ?? regions

  /** 拖动中：只改界面，松手由 onCommit 写一次 */
  const previewRegion = (id: string, patch: Partial<SpriteTouchRegion>) => {
    const next = latestRegions().map((r) => (r.id === id ? { ...r, ...patch } : r))
    setDraft(next)
    pendingRef.current = next
  }

  /** 离散操作（名字/序列/开关/增删）：立即落盘 */
  const updateRegion = (id: string, patch: Partial<SpriteTouchRegion>) => {
    previewRegion(id, patch)
    flushPending()
  }

  const writeRegions = (next: SpriteTouchRegion[]) => {
    setDraft(next)
    pendingRef.current = next
    flushPending()
  }

  // 切立绘集：先把上一套的草稿补写，再切
  useEffect(() => {
    const prev = lastSpriteRef.current
    if (prev === spriteId) return
    const pending = pendingRef.current
    if (prev && pending) persist(prev, pending)
    pendingRef.current = null
    lastSpriteRef.current = spriteId
  }, [spriteId])

  // 卸载：尽力写出最后一次编辑
  useEffect(() => {
    return () => {
      const id = spriteIdRef.current
      const pending = pendingRef.current
      if (id && pending) persist(id, pending)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 切换部位：帧选中回到第一帧（避免索引越界到别的部位的序列上）
  useEffect(() => {
    setFrameIndex(0)
  }, [selectedId])

  /** 首次进入自动选中第一个部位：右侧直接显示序列编辑，不用先点一次框 */
  const autoSelectedRef = useRef(false)
  useEffect(() => {
    if (autoSelectedRef.current || regions.length === 0) return
    autoSelectedRef.current = true
    setSelectedId(regions[0]?.id ?? null)
  }, [regions])

  const selectedRegion = regions.find((r) => r.id === selectedId) ?? null
  const images = (sprite?.images ?? []).map((i) => i.filePath)
  /** 文件名 → 状态名（立绘集词表），用于选择器与帧卡片显示 */
  const labels = useMemo(() => {
    const map: Record<string, string> = {}
    for (const e of sprite?.emotions ?? []) map[e.image] = e.name
    return map
  }, [sprite])
  const pickingFrame =
    picking && regions.find((r) => r.id === picking.regionId)?.frames[picking.frameIndex]

  /** 截图与当前编辑对象是否一致：立绘模式下且是同一套立绘集 */
  const snapshotMatches = !!snapshot && snapshot.mode === 'sprite' && snapshot.spriteId === spriteId

  const addRegion = () => {
    const id = `scustom-${Date.now().toString(36)}`
    writeRegions([
      ...latestRegions(),
      {
        id,
        label: `部位 ${regions.length + 1}`,
        x: 0.3,
        y: 0.3,
        w: 0.4,
        h: 0.2,
        frames: [],
        restore: true,
      },
    ])
    setSelectedId(id)
  }

  const frameList = selectedRegion?.frames ?? []
  const safeFrameIndex = Math.min(frameIndex, Math.max(0, frameList.length - 1))
  const currentFrame = frameList[safeFrameIndex]

  /** 新增一帧：用当前集第一张图，并自动选中它 */
  const addFrame = () => {
    const cur = selectedRegion && latestRegions().find((r) => r.id === selectedRegion.id)
    if (!cur) return
    const next = [...cur.frames, { image: images[0] ?? '', holdMs: 1200, line: '' }]
    updateRegion(selectedRegion.id, { frames: next })
    setFrameIndex(next.length - 1)
  }

  /** 左移/右移：顺序就是演出顺序 */
  const moveFrame = (dir: -1 | 1) => {
    const cur = selectedRegion && latestRegions().find((r) => r.id === selectedRegion.id)
    if (!cur) return
    const to = safeFrameIndex + dir
    if (to < 0 || to >= cur.frames.length) return
    const next = [...cur.frames]
    const [item] = next.splice(safeFrameIndex, 1)
    if (!item) return
    next.splice(to, 0, item)
    updateRegion(selectedRegion.id, { frames: next })
    setFrameIndex(to)
  }

  const removeFrame = () => {
    const cur = selectedRegion && latestRegions().find((r) => r.id === selectedRegion.id)
    if (!cur) return
    const next = cur.frames.filter((_, k) => k !== safeFrameIndex)
    updateRegion(selectedRegion.id, { frames: next })
    setFrameIndex(Math.max(0, Math.min(safeFrameIndex, next.length - 1)))
  }

  const patchFrame = (regionId: string, index: number, patch: Partial<SpriteTouchFrame>) => {
    const region = latestRegions().find((r) => r.id === regionId)
    if (!region) return
    const frames = region.frames.map((f, i) => (i === index ? { ...f, ...patch } : f))
    updateRegion(regionId, { frames })
  }

  if (!spriteId) {
    return (
      <section className="glass rounded-[var(--radius-lg)] p-6">
        <div className="text-sm font-medium text-text">2D 立绘 · 触摸部位</div>
        <p className="mt-2 text-xs leading-relaxed text-text-muted">
          当前角色卡未绑定立绘集。请先到「角色模型 → 2D 立绘」选择一套立绘集，再回来配置触摸区域。
        </p>
      </section>
    )
  }

  return (
    <section className="glass rounded-[var(--radius-lg)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-text">触摸部位 · {sprite?.name ?? '立绘集'}</div>
          <div className="mt-0.5 text-xs leading-relaxed text-text-muted">
            摸这些区域会按配置的立绘序列切换，切到哪张就播哪张的台词；旁白与 AI 回应和 Live2D 共用规则。
            开启「让 AI 立即回应」时，摸这里只会让 AI 说话，<span className="text-text-2">不切立绘、也不播这里配置的台词</span>。
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {usingDefault && <span className="text-xs text-text-muted">默认分区</span>}
          {!usingDefault && <span className="text-xs text-primary-400">已自定义</span>}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => writeRegions(DEFAULT_REGIONS.map((r) => ({ ...r })))}>
          <Sparkles size={13} strokeWidth={1.75} />
          一键生成默认分区
        </Button>
        <Button
          variant="outline"
          size="sm"
          title="清空本立绘集的自定义区域（想恢复默认分区点左边的按钮）"
          onClick={() => {
            if (!spriteId) return
            pendingRef.current = null
            setDraft(null)
            if (!loadedRef.current) return
            void saveModelSettings({ spriteTouchBySprite: { [spriteId]: [] } }).catch(() => toast('重置失败'))
          }}
        >
          清空
        </Button>
        <Button variant="outline" size="sm" onClick={() => void capture()}>
          {refreshing ? '截图中…' : '按当前立绘重新截图'}
        </Button>
      </div>

      <div className="mt-3">
        <TouchRegionEditor
          snapshot={snapshotMatches ? snapshot : null}
          regions={regions}
          parts={undefined}
          selectedId={selectedId}
          refreshing={refreshing}
          onSelect={setSelectedId}
          onChange={previewRegion}
          onCommit={flushPending}
          onRefresh={() => void capture()}
          sideExtra={
            <div className="flex h-full min-h-[320px] flex-col">
              {selectedRegion ? (
                <div className="min-w-0 flex-1 space-y-3">
                  <div className="flex items-center gap-2">
                    <input
                      value={selectedRegion.label}
                      onChange={(e) => updateRegion(selectedRegion.id, { label: e.target.value.slice(0, 12) })}
                      className="min-w-0 flex-1 rounded-[var(--radius-sm)] border border-border bg-bg-panel px-2 py-1 text-xs text-text"
                    />
                    <button
                      title="删除这个部位"
                      onClick={() => {
                        writeRegions(latestRegions().filter((r) => r.id !== selectedRegion.id))
                        setSelectedId(null)
                      }}
                      className="rounded p-1 text-text-muted transition-colors hover:text-danger"
                    >
                      <Trash2 size={13} strokeWidth={1.75} />
                    </button>
                  </div>

                  <div>
                    <div className="flex items-center justify-between">
                      <div className="text-xs text-text-muted">立绘序列（按顺序切换）</div>
                      <span className="text-[11px] text-text-muted">{frameList.length} 帧</span>
                    </div>
                    <p className="mt-1 text-[11px] leading-relaxed text-text-muted">
                      首次使用某句台词需 1~2 秒合成，之后同一句走缓存。单帧保持建议 ≥1.5s，太短时下一帧会顶掉上一句语音。
                    </p>

                    {/* 帧按钮条：点一下切换下方单帧卡；按钮顺序就是演出顺序 */}
                    <div className="mt-2 flex flex-wrap gap-2">
                      {frameList.map((frame, i) => (
                        <button
                          key={i}
                          type="button"
                          title={frame.image ? `${labels[frame.image] ?? frame.image}（${frame.image}）` : '未选择图片'}
                          onClick={() => setFrameIndex(i)}
                          className={
                            'relative flex h-14 w-14 items-center justify-center overflow-hidden rounded-[var(--radius-sm)] border bg-bg transition-colors ' +
                            (i === safeFrameIndex
                              ? 'border-primary-400 ring-1 ring-primary-400/40'
                              : 'border-border hover:border-primary-400/60')
                          }
                        >
                          {frame.image ? (
                            <img
                              src={api.pet.spriteUrl(spriteId, frame.image)}
                              alt={labels[frame.image] ?? frame.image}
                              loading="lazy"
                              decoding="async"
                              draggable={false}
                              className="max-h-full max-w-full object-contain"
                            />
                          ) : (
                            <span className="text-[10px] text-text-muted">无图</span>
                          )}
                          <span
                            className={
                              'absolute left-0 top-0 rounded-br px-1 text-[10px] leading-4 ' +
                              (i === safeFrameIndex ? 'bg-primary-500 text-white' : 'bg-black/55 text-white')
                            }
                          >
                            {i + 1}
                          </span>
                        </button>
                      ))}
                      <button
                        type="button"
                        title="添加一帧"
                        onClick={addFrame}
                        className="flex h-14 w-14 items-center justify-center rounded-[var(--radius-sm)] border border-dashed border-border text-text-muted transition-colors hover:border-primary-400/60 hover:text-primary-300"
                      >
                        <Plus size={16} strokeWidth={1.75} />
                      </button>
                    </div>

                    {/* 单帧编辑卡：整条序列只有这一张，避免多帧把右栏撑高 */}
                    {currentFrame ? (
                      <div className="mt-3 rounded-[var(--radius-sm)] border border-border p-2">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] text-text-muted">
                            第 {safeFrameIndex + 1} / {frameList.length} 帧
                          </span>
                          <div className="flex items-center gap-0.5">
                            <button
                              type="button"
                              title="左移（提前播放）"
                              disabled={safeFrameIndex <= 0}
                              onClick={() => moveFrame(-1)}
                              className="rounded p-1 text-text-muted transition-colors hover:text-text disabled:opacity-30"
                            >
                              <ChevronLeft size={13} strokeWidth={2} />
                            </button>
                            <button
                              type="button"
                              title="右移（延后播放）"
                              disabled={safeFrameIndex >= frameList.length - 1}
                              onClick={() => moveFrame(1)}
                              className="rounded p-1 text-text-muted transition-colors hover:text-text disabled:opacity-30"
                            >
                              <ChevronRight size={13} strokeWidth={2} />
                            </button>
                            <button
                              type="button"
                              title="删除这一帧"
                              onClick={removeFrame}
                              className="rounded p-1 text-text-muted transition-colors hover:text-danger"
                            >
                              <Trash2 size={12} strokeWidth={1.75} />
                            </button>
                          </div>
                        </div>

                        <button
                          type="button"
                          title={
                            currentFrame.image
                              ? `${labels[currentFrame.image] ?? currentFrame.image}（${currentFrame.image}）`
                              : '选择图片'
                          }
                          onClick={() => setPicking({ regionId: selectedRegion.id, frameIndex: safeFrameIndex })}
                          className="mt-1 flex w-full min-w-0 items-center gap-2 rounded-[var(--radius-sm)] border border-border bg-bg-panel p-1 text-left transition-colors hover:border-primary-400/60"
                        >
                          {currentFrame.image ? (
                            <img
                              src={api.pet.spriteUrl(spriteId, currentFrame.image)}
                              alt={labels[currentFrame.image] ?? currentFrame.image}
                              loading="lazy"
                              decoding="async"
                              draggable={false}
                              className="h-9 w-9 shrink-0 rounded-[4px] bg-bg object-contain"
                            />
                          ) : (
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[4px] bg-bg text-[10px] text-text-muted">
                              无
                            </span>
                          )}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[11px] text-text-2">
                              {currentFrame.image ? (labels[currentFrame.image] ?? currentFrame.image) : '点击选择图片'}
                            </span>
                            <span className="block truncate text-[10px] text-text-muted">
                              {currentFrame.image || '—'}
                            </span>
                          </span>
                        </button>

                        <div className="mt-1.5">
                          <Slider
                            label="保持"
                            value={(currentFrame.holdMs ?? 1200) / 1000}
                            min={0.3}
                            max={10}
                            step={0.1}
                            defaultValue={1.2}
                            onChange={(v) =>
                              patchFrame(selectedRegion.id, safeFrameIndex, { holdMs: Math.round(v * 1000) })
                            }
                            format={(v) => `${v.toFixed(1)}s`}
                          />
                        </div>
                        <input
                          value={currentFrame.line ?? ''}
                          placeholder="这一张的台词（可空）"
                          onChange={(e) => patchFrame(selectedRegion.id, safeFrameIndex, { line: e.target.value })}
                          className="mt-1.5 w-full rounded-[var(--radius-sm)] border border-border bg-bg-panel px-2 py-1 text-[11px] text-text"
                        />
                      </div>
                    ) : (
                      <p className="mt-3 text-[11px] leading-relaxed text-text-muted">
                        还没有序列：点击这个部位只会写旁白，不会切立绘。点右上角「+」添加第一帧。
                      </p>
                    )}
                  </div>

                  <div className="flex items-center justify-between gap-3 border-t border-border pt-2">
                    <div>
                      <div className="text-xs text-text-2">演完回到原立绘</div>
                      <div className="mt-0.5 text-[11px] text-text-muted">
                        关闭＝停在最后一帧，直到下一次情绪/说话切图。
                      </div>
                    </div>
                    <Switch
                      checked={selectedRegion.restore !== false}
                      onChange={(v) => updateRegion(selectedRegion.id, { restore: v })}
                    />
                  </div>
                </div>
              ) : (
                <div className="flex-1 text-[11px] leading-relaxed text-text-muted">
                  在左侧图里点一个框（或上面的名字）来编辑它的立绘序列与台词。
                </div>
              )}

              <Button variant="outline" size="sm" className="mt-3 w-full" onClick={addRegion}>
                <Plus size={13} strokeWidth={1.75} />
                添加部位
              </Button>
            </div>
          }
        />
      </div>

      <SpriteImagePicker
        open={!!picking}
        spriteId={spriteId}
        images={images}
        labels={labels}
        current={pickingFrame?.image ?? ''}
        liveFile={snapshot?.spriteFile ?? null}
        onPick={(file) => {
          if (!picking) return
          patchFrame(picking.regionId, picking.frameIndex, { image: file })
        }}
        onClose={() => setPicking(null)}
      />

      {!snapshotMatches && !refreshing && (
        <p className="mt-2 text-[11px] leading-relaxed text-danger/90">
          {snapshot
            ? '桌宠窗当前显示的不是这套立绘，截图与坐标会对不上。请先在「角色模型」里把这套立绘设为当前形象，再点「按当前立绘重新截图」。'
            : '还没拿到立绘截图：请确认桌宠窗已启动且当前显示的是这套立绘，然后点「按当前立绘重新截图」。'}
        </p>
      )}
    </section>
  )
}
