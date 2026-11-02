/**
 * 角色互动面板：互动模式 / 触摸部位 / AI 回应。
 *
 * 布局：左侧是可视化编辑器（角色截图 + 可拖拽的命中区），
 * 右侧显示「当前选中部位」的编辑项与「添加部位」——不再把每个部位的卡片堆在下面。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FolderOpen, Plus, RotateCcw, Sparkles, Trash2 } from 'lucide-react'
import type { ExpressionMeta, ModelProfile, TouchRegion } from '../../types'
import { api } from '../../api'
import { toast } from '../../components/toast'
import { Button, SegmentedControl, Slider, Switch } from '../../components/ui'
import { useSettingsStore } from '../../store/settingsStore'
import { useCharacterStore } from '../../store/characterStore'
import { SpriteTouchPanel } from './SpriteTouchPanel'
import { resolveModelTouchRegions, useModelSettingsStore } from '../../store/modelSettingsStore'
import { makeBandRegions } from '../../lib/touch'
import { TouchRegionEditor } from './TouchRegionEditor'

export function InteractionPanel() {
  const { settings, save } = useSettingsStore()
  const modelSettings = useModelSettingsStore((s) => s.settings)
  /** 必须等它加载完：否则 settings 是默认值（touchByModel 为空），
   *  面板会显示自动识别的区域，用户一拖就把磁盘上的配置覆盖成自动值 */
  const modelLoaded = useModelSettingsStore((s) => s.loaded)
  const loadModelSettings = useModelSettingsStore((s) => s.load)
  const saveModelSettings = useModelSettingsStore((s) => s.save)
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([])
  const [profile, setProfile] = useState<ModelProfile | null>(null)
  const [motionGroups, setMotionGroups] = useState<string[]>([])
  const [exprMeta, setExprMeta] = useState<ExpressionMeta[]>([])
  const [snapshot, setSnapshot] = useState<{
    image: string
    width: number
    height: number
    bounds: { x: number; y: number; w: number; h: number }
    mode?: 'live2d' | 'sprite'
    spriteId?: string | null
  } | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const currentModelId = modelSettings.selectedModelId ?? models[0]?.id ?? null
  const currentModelName = models.find((m) => m.id === currentModelId)?.name ?? '—'

  /** 触摸配置对象：Live2D 模型 / 2D 立绘，两张独立的卡，数据与编辑器不共用 */
  const [touchTab, setTouchTab] = useState<'live2d' | 'sprite'>('live2d')
  const tabTouchedRef = useRef(false)
  const cards = useCharacterStore((s) => s.cards)
  const currentCardId = useCharacterStore((s) => s.currentCardId)
  const currentCard = cards.find((c) => c.id === currentCardId) ?? null
  /**
   * 立绘 tab 编辑哪一套：必须与桌宠窗的 resolvePerformanceTarget 完全一致——
   * 只有卡片明确处于 sprite 模式时才认它的绑定，否则回落全局选中。
   * （多兜一层 card.spriteId 会让"设置里编辑 A、桌宠显示 B"，点上去自然没反应。）
   */
  const effectiveSpriteId =
    (currentCard?.renderMode === 'sprite' ? currentCard.spriteId?.trim() || null : null) ??
    modelSettings.selectedSpriteId ??
    null

  // 首次进入跟随当前展示形象；用户手动切过之后不再抢
  useEffect(() => {
    if (tabTouchedRef.current) return
    const mode =
      currentCard?.renderMode === 'sprite'
        ? 'sprite'
        : currentCard?.renderMode === 'live2d'
          ? 'live2d'
          : modelSettings.selectedSpriteId && !modelSettings.selectedModelId
            ? 'sprite'
            : 'live2d'
    setTouchTab(mode)
  }, [currentCard?.renderMode, modelSettings.selectedModelId, modelSettings.selectedSpriteId])
  const touch = settings.touch

  useEffect(() => {
    if (!modelLoaded) void loadModelSettings()
  }, [modelLoaded, loadModelSettings])

  useEffect(() => {
    void api.model
      .list()
      .then((list) => setModels(list.map((m) => ({ id: m.id, name: m.name }))))
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!currentModelId) return
    let alive = true
    void api.model.profile(currentModelId).then((p) => alive && setProfile(p)).catch(() => undefined)
    const off = api.model.onProfile((p) => {
      if (alive && p.modelId === currentModelId) setProfile(p)
    })
    void api.model.motionGroups(currentModelId).then((g) => alive && setMotionGroups(g)).catch(() => undefined)
    void api.model
      .expressionList(currentModelId)
      .then((list) => {
        if (alive) setExprMeta(list)
      })
      .catch(() => undefined)
    return () => {
      alive = false
      off()
    }
  }, [currentModelId])

  const capture = useCallback(async () => {
    setRefreshing(true)
    try {
      const snap = await api.touch.snapshot()
      if (snap) setSnapshot(snap)
    } catch {
      // 桌宠窗没开 / 模型没加载：保持占位
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void capture()
  }, [currentModelId, capture])

  const override = resolveModelTouchRegions(modelSettings, currentModelId)
  const autoRegions = profile?.regions ?? []
  /** 编辑中的区域（草稿）。只有它存在时才覆盖持久层/自动识别 */
  const [draftRegions, setDraftRegions] = useState<TouchRegion[] | null>(null)
  const regions = draftRegions ?? override ?? autoRegions
  // 草稿期间也算「已自定义」，否则标题会闪回"自动识别"
  const usingAuto = override === null && draftRegions === null

  /**
   * 保存链路的三条硬约束（曾导致"重启后恢复默认"）：
   *  1. 基底取 ref 里的最新值，不依赖渲染闭包——连续编辑时会拿旧数组覆盖新数组；
   *  2. 落盘用"立即写 / 松手即写"，不挂 300ms 防抖——关设置窗或重启会直接杀掉定时器；
   *  3. 切模型、卸载前把待写草稿补写一次。
   */
  const regionsRef = useRef<TouchRegion[]>(regions)
  regionsRef.current = regions
  const currentModelIdRef = useRef<string | null>(currentModelId)
  currentModelIdRef.current = currentModelId
  /** 尚未落盘的区域（null = 没有待写） */
  const pendingRef = useRef<TouchRegion[] | null>(null)
  const flushRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastModelRef = useRef<string | null>(currentModelId)

  /** 未加载完绝不能写：此时 override 一定是 null，写进去的就是自动识别结果 */
  const loadedRef = useRef(modelLoaded)
  loadedRef.current = modelLoaded

  const persist = (modelId: string, next: TouchRegion[]) => {
    if (!loadedRef.current) {
      console.warn('[touch] 模型设置尚未加载完成，跳过这次写入（避免用自动识别覆盖已保存的配置）')
      return
    }
    void saveModelSettings({ touchByModel: { [modelId]: next } }).catch((err) => {
      console.error('[touch] 保存命中区失败', err)
    })
  }

  /** 把待写草稿立即落盘 */
  const flushPending = () => {
    if (flushRef.current) {
      clearTimeout(flushRef.current)
      flushRef.current = null
    }
    const modelId = currentModelIdRef.current
    const next = pendingRef.current
    if (!modelId || !next) return
    pendingRef.current = null
    persist(modelId, next)
  }

  /** 只改界面（拖动中每帧调用）；不落盘，松手时由编辑器的 onCommit 立即写一次 */
  const previewRegion = (id: string, patch: Partial<TouchRegion>) => {
    const next = regionsRef.current.map((r) => (r.id === id ? { ...r, ...patch } : r))
    regionsRef.current = next
    setDraftRegions(next)
    pendingRef.current = next
  }

  /** 离散操作（动作/表情/名字/台词/时长）：改完立即落盘 */
  const updateRegion = (id: string, patch: Partial<TouchRegion>) => {
    previewRegion(id, patch)
    flushPending()
  }

  /** 整份替换（新增/删除/一键生成/恢复自动）：立即落盘 */
  const writeRegions = (next: TouchRegion[]) => {
    regionsRef.current = next
    setDraftRegions(next)
    pendingRef.current = next
    flushPending()
  }

  // 切模型：先把上一只模型的草稿补写，再切到新模型
  useEffect(() => {
    const prev = lastModelRef.current
    if (prev === currentModelId) return
    const pending = pendingRef.current
    if (prev && pending) {
      // 必须用上一只模型的 id 写，不能用新的
      persist(prev, pending)
      pendingRef.current = null
    }
    if (flushRef.current) {
      clearTimeout(flushRef.current)
      flushRef.current = null
    }
    lastModelRef.current = currentModelId
    setDraftRegions(null)
    setSelectedId(null)
  }, [currentModelId])

  // 组件卸载（关闭设置窗）：尽力把最后一次编辑写出去
  useEffect(() => {
    return () => {
      const modelId = currentModelIdRef.current
      const pending = pendingRef.current
      if (modelId && pending) persist(modelId, pending)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const addRegion = () => {
    const id = `custom-${Date.now().toString(36)}`
    writeRegions([
      ...regionsRef.current,
      {
        id,
        label: `部位 ${regionsRef.current.length + 1}`,
        x: 0.3,
        y: 0.3,
        w: 0.4,
        h: 0.2,
        holdMs: 1800,
        motions: [],
        expressions: [],
        lines: [],
      },
    ])
    setSelectedId(id)
  }

  const patchTouch = (patch: Partial<typeof touch>) => {
    void save({ touch: { ...touch, ...patch } })
  }

  /** 表情互斥表：两个表情若对同一参数写了不同值，就视为互斥（和外观区口径一致） */
  const conflicts = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const a of exprMeta) {
      const set = new Set<string>()
      for (const b of exprMeta) {
        if (a.name === b.name) continue
        const hit = a.parameters.some((pa) =>
          b.parameters.some((pb) => pb.Id === pa.Id && Math.abs(pb.Value - pa.Value) > 1e-6),
        )
        if (hit) set.add(b.name)
      }
      map.set(a.name, set)
    }
    return map
  }, [exprMeta])

  const selectedRegion = regions.find((r) => r.id === selectedId) ?? null
  const motions = selectedRegion
    ? selectedRegion.motions ?? (selectedRegion.motion ? [selectedRegion.motion] : [])
    : []
  const exprs = selectedRegion
    ? selectedRegion.expressions ?? (selectedRegion.expression ? [selectedRegion.expression] : [])
    : []

  const summaries = useMemo(() => {
    if (!currentModelId) return '先导入并选择一个 Live2D 模型'
    if (regions.length === 0) return '该模型自动识别为空，可点「一键生成默认分区」'
    return `${regions.map((r) => r.label).join(' / ')}　${usingAuto ? '（自动识别）' : '（已自定义）'}`
  }, [currentModelId, regions, usingAuto])

  /** 右侧：选中部位的编辑区 + 添加按钮 */
  const sidePanel = (
    <div className="flex h-full min-h-[320px] flex-col">
      {selectedRegion ? (
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex items-center gap-2">
            <input
              value={selectedRegion.label}
              onChange={(e) => updateRegion(selectedRegion.id, { label: e.target.value.slice(0, 12) })}
              className="min-w-0 flex-1 rounded-[var(--radius-sm)] border border-border bg-bg-panel px-2 py-1 text-xs text-text"
              placeholder="部位名称"
              title="改名会同步到图上的标签与上方部位列表"
            />
            <Button
              variant="ghost"
              size="sm"
              title="删除该部位"
              onClick={() => {
                writeRegions(regionsRef.current.filter((r) => r.id !== selectedRegion.id))
                setSelectedId(null)
              }}
            >
              <Trash2 size={13} strokeWidth={1.75} />
            </Button>
          </div>

          <div>
            <div className="text-xs text-text-muted">动作（点击顺序即播放顺序，数字是播放次序）</div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {motionGroups.length === 0 && <span className="text-[11px] text-text-muted">该模型没有动作组</span>}
              {motionGroups.map((g) => {
                const idx = motions.indexOf(g)
                const active = idx >= 0
                return (
                  <ChipToggle
                    key={g}
                    active={active}
                    badge={active ? String(idx + 1) : undefined}
                    title={active ? '再点一次取消' : '点击加入，按点击顺序播放'}
                    onClick={() =>
                      updateRegion(selectedRegion.id, {
                        motions: active ? motions.filter((x) => x !== g) : [...motions, g],
                        motion: undefined,
                      })
                    }
                  >
                    {g}
                  </ChipToggle>
                )
              })}
            </div>
          </div>

          <div>
            <div className="text-xs text-text-muted">表情（可叠加；与已选表情互斥的会置灰）</div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {exprMeta.length === 0 && <span className="text-[11px] text-text-muted">该模型没有表情文件</span>}
              {exprMeta.map((e) => {
                const active = exprs.includes(e.name)
                const blocked = !active && exprs.some((sel) => sel !== e.name && conflicts.get(sel)?.has(e.name))
                return (
                  <ChipToggle
                    key={e.name}
                    active={active}
                    disabled={blocked}
                    title={blocked ? '与已选表情互斥（写同一参数）' : active ? '再点一次取消' : '点击选中'}
                    onClick={() =>
                      updateRegion(selectedRegion.id, {
                        expressions: active ? exprs.filter((x) => x !== e.name) : [...exprs, e.name],
                        expression: undefined,
                      })
                    }
                  >
                    {e.name}
                  </ChipToggle>
                )
              })}
            </div>
          </div>

          <div>
            <div className="text-[11px] text-text-muted">表情保持时长（到点自动回落）</div>
            <Slider
              value={selectedRegion.holdMs ?? 1800}
              min={300}
              max={8000}
              step={100}
              defaultValue={1800}
              onChange={(v) => updateRegion(selectedRegion.id, { holdMs: v })}
              format={(v) => `${(v / 1000).toFixed(1)}s`}
            />
            <label className="mt-1 flex items-center justify-between gap-2 text-[11px] text-text-muted">
              动作播完回到空闲
              <Switch
                checked={selectedRegion.restoreIdle !== false}
                onChange={(v) => updateRegion(selectedRegion.id, { restoreIdle: v })}
              />
            </label>
          </div>

          <label className="block text-xs text-text-muted">
            台词（每行一句，随机播；留空则不出声）
            <textarea
              className="mt-1 h-16 w-full resize-none rounded-[var(--radius-sm)] border border-border bg-bg-panel px-2 py-1 text-xs text-text"
              value={(selectedRegion.lines ?? []).join('\n')}
              onChange={(e) =>
                // 必须原样保留换行：之前的 trim+filter(Boolean) 会把刚敲下的空行立刻删掉，
                // 表现为“按 Enter 不换行”。空行在播放时才过滤。
                updateRegion(selectedRegion.id, { lines: e.target.value.split('\n') })
              }
              onBlur={(e) => {
                // 失焦时再收敛：去掉行首尾空格与多余空行，避免 JSON 里堆一堆空串
                const clean = e.target.value
                  .split('\n')
                  .map((x) => x.trim())
                  .filter(Boolean)
                // 内容没变就不写：否则"点一下再点走"也会触发保存，把自动识别结果固化成自定义
                const cur = selectedRegion.lines ?? []
                if (clean.length === cur.length && clean.every((v, i) => v === cur[i])) return
                updateRegion(selectedRegion.id, { lines: clean })
              }}
            />
          </label>
        </div>
      ) : (
        <div className="flex-1 text-[11px] leading-relaxed text-text-muted">
          在左侧图里点一个框（或上面列表里的名字）来编辑它的动作、表情和台词。
        </div>
      )}

      <Button variant="outline" size="sm" className="mt-3 w-full" onClick={addRegion}>
        <Plus size={13} strokeWidth={1.75} />
        添加部位
      </Button>
    </div>
  )

  // 模型设置还没加载完：先不要渲染编辑器。此时 override 一定为 null，
  // 页面显示的是"自动识别"的临时值，一操作就会把它当成用户配置写盘。
  if (!modelLoaded) {
    return (
      <div className="glass rounded-[var(--radius-lg)] p-6 text-xs text-text-muted">
        正在加载当前模型的部位配置…
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <section className="glass rounded-[var(--radius-lg)] p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-text">互动模式</div>
            <div className="mt-0.5 text-xs text-text-muted">
              开启后桌宠窗右上角出现拖动与退出按钮，鼠标可以直接摸角色。桌宠窗上的按钮与这里双向同步。
            </div>
          </div>
          <Switch checked={touch.enabled} onChange={(v) => patchTouch({ enabled: v })} />
        </div>

        <div className="mt-3 flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-text">触摸语音</div>
            <div className="mt-0.5 text-xs text-text-muted">
              用角色声线念一句台词；AI 正在说话时静默跳过。首次触发需 1~2 秒合成，之后同一句直接读本地缓存。
            </div>
          </div>
          <Switch checked={touch.voice} onChange={(v) => patchTouch({ voice: v })} />
        </div>

        <div className="mt-3 flex items-center justify-between gap-4">
          <div>
            <div className="text-sm font-medium text-text">旁白写进会话历史</div>
            <div className="mt-0.5 text-xs text-text-muted">
              {touch.aiReply
                ? '已由「让 AI 立即回应」强制开启：那一轮对话需要这条旁白作为输入，必然写入历史。关闭「立即回应」后可自行选择。'
                : '开启后每次触摸都会写一条「（角色被摸了摸头）」到会话历史，AI 下次对话时能看到；关闭则不给 AI 任何提示。'}
            </div>
          </div>
          {/* 只改显示不改存储：立即回应期间显示为开且禁用，
              底层 saveNarration 保留用户原选择，关掉立即回应后自动恢复 */}
          <Switch
            checked={touch.aiReply ? true : touch.saveNarration}
            disabled={touch.aiReply}
            onChange={(v) => patchTouch({ saveNarration: v })}
          />
        </div>

        <div className="mt-3 flex items-center justify-between gap-4">
          <div>
            <div className="text-sm font-medium text-text">让 AI 立即回应</div>
            <div className="mt-0.5 text-xs leading-relaxed text-text-muted">
              开启＝触摸后当场回一句（会调用一次模型）；关闭＝只靠上面的旁白让 AI 事后知道。
              <br />
              2D 立绘：开启后不再切立绘、也不播触摸台词，避免和思考图/多段语音抢；Live2D：动作与表情照常。
            </div>
          </div>
          <Switch checked={touch.aiReply} onChange={(v) => patchTouch({ aiReply: v })} />
        </div>

        <div className="mt-3">
          <div className="mb-1 text-xs font-medium text-text-muted">同一部位冷却</div>
          <Slider
            value={touch.cooldownMs}
            min={200}
            max={5000}
            step={100}
            defaultValue={1200}
            onChange={(v) => patchTouch({ cooldownMs: v })}
            format={(v) => `${(v / 1000).toFixed(1)}s`}
          />
        </div>
      </section>

      {/* 触摸配置对象：切换的是两张独立的卡（数据、编辑器、截图都互不共用） */}
      <div className="flex items-center justify-between gap-3 px-1">
        <span className="text-xs text-text-muted">触摸配置对象</span>
        <SegmentedControl<'live2d' | 'sprite'>
          value={touchTab}
          onChange={(v) => {
            tabTouchedRef.current = true
            setTouchTab(v)
          }}
          options={[
            { value: 'live2d', label: 'Live2D 模型' },
            { value: 'sprite', label: '2D 立绘' },
          ]}
        />
      </div>

      {touchTab === 'live2d' && (
      <section className="glass rounded-[var(--radius-lg)] p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-text">触摸部位 · {currentModelName}</div>
            <div className="mt-0.5 text-xs text-text-muted">{summaries}</div>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!currentModelId}
              title="按角色包围盒四等分生成头 / 身体 / 腿 / 脚四个区域。自动识别为空时用它起步。"
              onClick={() => {
                writeRegions(makeBandRegions())
                setSelectedId(null)
              }}
            >
              <Sparkles size={13} strokeWidth={1.75} />
              一键生成默认分区
            </Button>
            {!usingAuto && (
              <Button
                variant="outline"
                size="sm"
                disabled={!currentModelId}
                title="丢弃当前自定义，回到按部件名自动识别的结果"
                onClick={() => {
                  if (!currentModelId) return
                  setSelectedId(null)
                  void saveModelSettings({ touchByModel: { [currentModelId]: [] } })
                }}
              >
                <RotateCcw size={13} strokeWidth={1.75} />
                恢复自动
              </Button>
            )}
          </div>
        </div>

        {/* 部位速选：框拖到图外时也能点到 */}
        {regions.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {regions.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setSelectedId(r.id)}
                className={
                  'rounded-full border px-2 py-0.5 text-[11px] transition-colors ' +
                  (r.id === selectedId
                    ? 'border-primary-400/70 bg-primary-500/15 text-primary-200'
                    : 'border-border text-text-2 hover:border-primary-400/60')
                }
              >
                {r.label}
              </button>
            ))}
          </div>
        )}

        {snapshot && snapshot.mode === 'sprite' && (
          <p className="mt-2 text-[11px] leading-relaxed text-danger/90">
            桌宠窗当前显示的是 2D 立绘，这张截图不能用来编辑 Live2D 区域。请先在「角色模型」里切换到 Live2D 模型，再点截图。
          </p>
        )}

        <div className="mt-3">
          {/* 拖动中每帧只改内存、松手由 onCommit 写一次：这里若传 updateRegion，
              每个 pointermove 都会落盘（日志里那上百次写入就是这么来的） */}
          <TouchRegionEditor
            snapshot={snapshot && snapshot.mode !== 'sprite' ? snapshot : null}
            regions={regions}
            parts={profile?.parts}
            selectedId={selectedId}
            refreshing={refreshing}
            onSelect={setSelectedId}
            onChange={previewRegion}
            onCommit={flushPending}
            onRefresh={() => void capture()}
            sideExtra={sidePanel}
          />
        </div>

      </section>
      )}

      {touchTab === 'sprite' && <SpriteTouchPanel spriteId={effectiveSpriteId} />}

      <section className="glass rounded-[var(--radius-lg)] p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-text">触摸语音缓存</div>
            <div className="mt-0.5 text-xs leading-relaxed text-text-muted">
              合成结果落盘保存，退出应用不会清空；同一句台词只合成一次。缓存与剧情语音共用，上限约 500MB，超出后按最久未使用淘汰。
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              variant="outline"
              size="sm"
              title="在文件管理器里打开语音缓存目录"
              onClick={() => {
                void api.story.voiceCacheOpen().catch(() => toast('打开失败'))
              }}
            >
              <FolderOpen size={13} strokeWidth={1.75} />
              打开文件夹
            </Button>
            <Button
              variant="outline"
              size="sm"
              title="清空全部语音缓存（含剧情语音），下次会重新合成"
              onClick={() => {
                void api.story
                  .voiceCacheClean({ all: true })
                  .then((n) => toast(`已清理 ${n} 个语音缓存文件`))
                  .catch(() => toast('清理失败'))
              }}
            >
              清理缓存
            </Button>
          </div>
        </div>
      </section>
    </div>
  )
}

/** 复选胶囊：选中高亮，可带序号徽标；disabled 时置灰不可点 */
function ChipToggle({
  active,
  disabled,
  badge,
  title,
  onClick,
  children,
}: {
  active: boolean
  disabled?: boolean
  badge?: string
  title?: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={
        'flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors ' +
        (active
          ? 'border-primary-400/70 bg-primary-500/15 text-primary-200'
          : disabled
            ? 'cursor-not-allowed border-border text-text-muted opacity-40'
            : 'border-border text-text-2 hover:border-primary-400/60 hover:text-primary-300')
      }
    >
      {badge && (
        <span className="flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary-500/30 px-1 text-[10px] text-primary-100">
          {badge}
        </span>
      )}
      {children}
    </button>
  )
}
