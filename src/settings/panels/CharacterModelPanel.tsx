/**
 * 角色模型面板：Cubism Core 引导 + Live2D 模型导入/管理 + 模型设置（缩放/位置/动画）。
 * 模型设置通过 zustand store 管理，变更后通过 IPC 广播到桌宠窗口实时生效。
 */
import { useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Images,
  Maximize2,
  Palette,
  Pencil,
  PersonStanding,
  Play,
  Plus,
  SlidersHorizontal,
  Smile,
} from 'lucide-react'
import { api } from '../../api'
import type { Live2DModelMeta, ModelAnimationSettings, ModelParameters, BlinkMode, ExpressionMeta, CharacterSprite, ModelProfile } from '../../types'
import { SpritePaletteEditor } from '../../components/SpritePaletteEditor'
import { ModelPaletteEditor } from '../../components/ModelPaletteEditor'
import {
  AccordionItem,
  Button,
  ConfirmModal,
  Empty,
  Field,
  Input,
  Loading,
  Modal,
  SegmentedControl,
  Slider,
  Switch,
} from '../../components/ui'
import { SelectMenu } from '../../components/DropdownMenu'
import { toast } from '../../components/toast'
import { cn, formatRelativeTime } from '../../lib/utils'
import { TabBar, type TabItem } from '../components/TabBar'
import { usePersistedTab } from '../components/usePersistedTab'
import {
  DEFAULT_PARAMETERS,
  DEFAULT_VIEW,
  resolveModelAppearance,
  resolveModelAppearanceLayout,
  resolveModelParameters,
  useModelSettingsStore,
} from '../../store/modelSettingsStore'
import { buildAppearanceCatalog, describeAppearance, mergeAppearanceSelection } from '../../lib/appearanceCatalog'
import { summarizeProfile } from '../../lib/modelProfile'
import { AppearanceSection, PoseSection } from './ModelParamsSection'

/** 二级 tab：Live2D 与 2D 立绘是两套互不相干的资源（导入口、参数、增删动作全不同） */
const MODEL_TAB_IDS = ['live2d', 'sprite'] as const
type ModelTab = (typeof MODEL_TAB_IDS)[number]
const MODEL_TABS: readonly TabItem<ModelTab>[] = [
  { id: 'live2d', label: 'Live2D 模型' },
  { id: 'sprite', label: '2D 立绘' },
]

export function CharacterModelPanel() {
  /** 二级 tab：记在 localStorage，切面板/重启后回到原处 */
  const [tab, setTab] = usePersistedTab<ModelTab>('model-tab', MODEL_TAB_IDS, 'live2d')
  const [corePresent, setCorePresent] = useState(false)
  const [models, setModels] = useState<Live2DModelMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)
  const [deleting, setDeleting] = useState<Live2DModelMeta | null>(null)
  /** 2D 立绘集列表 */
  const [sprites, setSprites] = useState<CharacterSprite[]>([])
  const [importingSprite, setImportingSprite] = useState(false)
  const [deletingSprite, setDeletingSprite] = useState<CharacterSprite | null>(null)
  /** 正在编辑状态演出的立绘集（非空 = 弹窗打开）：词表 + 默认状态 + 说话/思考立绘 */
  const [emotionEditing, setEmotionEditing] = useState<CharacterSprite | null>(null)
  /** 状态演出草稿是否有未保存修改（关闭前需二次确认） */
  const [spriteDirty, setSpriteDirty] = useState(false)
  const [modelDirty, setModelDirty] = useState(false)
  /** 正在请求关闭、且存在未保存修改的弹窗（非空 = 显示确认框） */
  const [confirmLeave, setConfirmLeave] = useState<'sprite' | 'model' | null>(null)

  /** 立绘弹窗标题的编号数量（编辑器增删标签时实时回调同步，标题不滞后） */
  const [spriteWordCount, setSpriteWordCount] = useState<number | null>(null)
  /** 正在编辑状态词表的 Live2D 模型（非空 = 弹窗打开）：模型侧演出词表（一条标签 ↔ 一个表情） */
  const [paletteEditing, setPaletteEditing] = useState<Live2DModelMeta | null>(null)
  /** 模型词表词条数（弹窗标题展示；词表存在独立文件，打开弹窗时异步拉取） */
  const [paletteWordCount, setPaletteWordCount] = useState<number | null>(null)
  /** 可用的动作组列表（从模型 model3.json 读取） */
  const [motionGroups, setMotionGroups] = useState<string[]>([])
  /** 可用的表情列表（从选中模型的 exp3.json 读取） */
  const [expressions, setExpressions] = useState<ExpressionMeta[]>([])
  /** 资产扫描进行中 / 最近一次扫描结果提示 */
  const [scanning, setScanning] = useState(false)
  const [scanResult, setScanResult] = useState<string | null>(null)
  /** 当前由状态词表驱动的表情名（null = 无）：外观区据此标记/锁定该项 */
  const [stateExpression, setStateExpression] = useState<string | null>(null)
  /** 重命名弹窗目标：kind 区分 Live2D 模型 / 2D 立绘集，null = 弹窗关闭 */
  const [renaming, setRenaming] = useState<{ kind: 'model' | 'sprite'; id: string; name: string } | null>(null)
  const [renameDraft, setRenameDraft] = useState('')

  const { settings, loaded, load, save, updateLocal } = useModelSettingsStore()

  /** 当前编辑目标模型：优先全局选中，未选中时用列表第一个 */
  const currentModelId = settings.selectedModelId ?? models[0]?.id ?? null

  /** 当前模型的姿态参数（没有专属值 → 回落全局 parameters） */
  const modelParameters = resolveModelParameters(settings, currentModelId)

  /** 当前模型的能力表（存在性/量程/物理驱动）；null = 桌宠还没加载完，UI 退回兜底量程 */
  const [modelProfile, setModelProfile] = useState<ModelProfile | null>(null)

  useEffect(() => {
    if (!currentModelId) {
      setModelProfile(null)
      return
    }
    let alive = true
    void api.model
      .profile(currentModelId)
      .then((p) => {
        if (alive) setModelProfile(p)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [currentModelId])

  useEffect(() => {
    return api.model.onProfile((p) => {
      setModelProfile((cur) => (p.modelId === currentModelId ? p : cur))
    })
  }, [currentModelId])
  /** 当前模型选中的外观项（exp3 表情名） */
  const modelAppearance = resolveModelAppearance(settings, currentModelId)
  /** 当前模型的外观分组自定义（自动分类猜错时用户改过的结果） */
  const modelLayout = resolveModelAppearanceLayout(settings, currentModelId)
  /** 面板显示用：外观持久层 ∪ 状态临时层（状态项会以"·状态"样式出现） */
  const effectiveAppearance = mergeAppearanceSelection(
    buildAppearanceCatalog(expressions, modelLayout),
    modelAppearance,
    stateExpression,
  )

  /** 姿态滑杆：先写本地状态即时预览，再节流 150ms 落盘（拖动时不能每帧写文件） */
  const paramsFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingParamsRef = useRef<Record<string, ModelParameters>>({})
  const applyModelParameters = (patch: Partial<ModelParameters>) => {
    const modelId = currentModelId
    if (!modelId) return
    const next = { ...resolveModelParameters(useModelSettingsStore.getState().settings, modelId), ...patch }
    updateLocal({ parametersByModel: { [modelId]: next } })
    pendingParamsRef.current[modelId] = next
    if (paramsFlushRef.current) clearTimeout(paramsFlushRef.current)
    paramsFlushRef.current = setTimeout(() => {
      const pending = pendingParamsRef.current
      pendingParamsRef.current = {}
      void save({ parametersByModel: pending })
    }, 150)
  }

  /** 归零：只作用于当前模型 */
  const resetModelParameters = () => {
    const modelId = currentModelId
    if (!modelId) return
    updateLocal({ parametersByModel: { [modelId]: { ...DEFAULT_PARAMETERS } } })
    void save({ parametersByModel: { [modelId]: { ...DEFAULT_PARAMETERS } } })
  }

  /** 外观开关：离散操作，直接落盘 */
  const applyAppearance = (next: string[]) => {
    const modelId = currentModelId
    if (!modelId) return
    void save({ appearancesByModel: { [modelId]: next } })
  }

  /** 外观分组自定义（换类别 / 改名 / 隐藏） */
  const applyLayout = (next: import('../../types').ModelAppearanceLayout) => {
    const modelId = currentModelId
    if (!modelId) return
    void save({ appearanceLayoutByModel: { [modelId]: next } })
  }

  /** 加载指定模型的动作组（用于空闲动作下拉框）。不传 modelId 时按选中模型优先，其次列表第一个 */
  const loadMotionGroups = async (modelId?: string | null) => {
    if (!modelId) {
      setMotionGroups([])
      return
    }
    try {
      const groups = await api.model.motionGroups(modelId)
      setMotionGroups(groups)
    } catch {
      setMotionGroups([])
    }
  }

  const refresh = async () => {
    const [core, list] = await Promise.all([api.model.coreStatus(), api.model.list()])
    setCorePresent(core.present)
    setModels(list)
    setLoading(false)
    // 动作组取自当前选中模型（若尚未选中则用列表第一个）
    void loadMotionGroups(settings.selectedModelId ?? list[0]?.id)
  }

  /**
   * 扫描当前模型文件夹：自动识别 *.exp3.json / *.motion3.json 并合并写回 model3.json，
   * 然后用扫描返回的最新动作组刷新下拉框、重新拉取表情列表。
   * 主进程在新增条目时会广播 models-changed，桌宠窗自动重载模型使新资产生效。
   */
  const handleScanAssets = async () => {
    if (!currentModelId) {
      toast('没有可扫描的模型，请先导入并选中 Live2D 模型', 'error')
      return
    }
    setScanning(true)
    try {
      const r = await api.model.scanAssets(currentModelId)
      setMotionGroups(r.groups)
      void api.model.expressionList(currentModelId).then(setExpressions).catch(() => undefined)
      if (r.addedExpressions === 0 && r.addedMotions === 0) {
        setScanResult(
          r.reorganized
            ? `动作组已按文件名重组（现共 ${r.totalMotions} 个动作 / ${r.groups.length} 个组）。若空闲动作不播放，请重新选择动作组`
            : `未发现新文件。当前已有 ${r.totalExpressions} 个表情 / ${r.totalMotions} 个动作（${r.groups.length} 个组）`,
        )
      } else {
        setScanResult(`新增 ${r.addedExpressions} 个表情、${r.addedMotions} 个动作（现共 ${r.totalExpressions} 表情 / ${r.totalMotions} 动作，${r.groups.length} 个组）`)
        toast('扫描完成，已登记到 model3.json', 'success')
      }
    } catch (err) {
      setScanResult(null)
      toast(`扫描失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    } finally {
      setScanning(false)
    }
  }

  useEffect(() => {
    void refresh()
    void load()
    void loadSprites()
  }, [load])

  // 状态表情：挂载时取一次 + 订阅桌宠窗的上报（用于外观区标记"由状态控制"）
  useEffect(() => {
    void api.model.stateExpression().then(setStateExpression).catch(() => undefined)
    return api.model.onStateExpression((name) => setStateExpression(name))
  }, [])

  // 立绘集变化（导入/删除）时刷新
  useEffect(() => api.sprite.onChanged(() => void loadSprites()), [])

  /** 选中模型变化时，重新加载该模型的动作组（保证下拉框与实际展示的模型一致），并清除上次扫描结果提示 */
  useEffect(() => {
    setScanResult(null)
    if (models.length === 0) {
      setMotionGroups([])
      return
    }
    void loadMotionGroups(settings.selectedModelId ?? models[0]?.id)
  }, [models, settings.selectedModelId])

  /** 当选中模型变化时，加载该模型的表情列表 */
  useEffect(() => {
    if (models.length === 0) {
      setExpressions([])
      return
    }
    const modelId = settings.selectedModelId ?? models[0]?.id
    if (!modelId) {
      setExpressions([])
      return
    }
    void api.model.expressionList(modelId).then(setExpressions).catch(() => setExpressions([]))
  }, [models, settings.selectedModelId])

  const handleImportCore = async () => {
    try {
      const result = await api.model.importCore()
      if (result.present) {
        setCorePresent(true)
        toast('Cubism Core 已导入，桌宠将自动生效')
      } else {
        toast('已取消', 'info')
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : '导入失败', 'error')
    }
  }

  const handleImportFolder = async () => {
    setImporting(true)
    try {
      const meta = await api.model.importFromFolder()
      if (meta) {
        toast(`模型「${meta.name}」导入成功`)
        await refresh()
      } else {
        toast('已取消', 'info')
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : '导入失败', 'error')
    } finally {
      setImporting(false)
    }
  }

  const handleDelete = async () => {
    if (!deleting) return
    try {
      await api.model.remove(deleting.id)
      toast('已删除')
      setDeleting(null)
      await refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : '删除失败', 'error')
    }
  }

  /** 加载 2D 立绘集列表 */
  const loadSprites = async () => {
    try {
      setSprites(await api.sprite.list())
    } catch {
      setSprites([])
    }
  }

  /** 导入立绘集（文件夹，含多张状态切图） */
  const handleImportSprite = async () => {
    setImportingSprite(true)
    try {
      const meta = await api.sprite.importFromFolder()
      if (meta) {
        toast(`立绘集「${meta.name}」导入成功（${meta.images.length} 张图）`)
        await loadSprites()
      } else {
        toast('已取消', 'info')
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : '导入失败', 'error')
    } finally {
      setImportingSprite(false)
    }
  }

  /** 删除立绘集 */
  const handleDeleteSprite = async () => {
    if (!deletingSprite) return
    try {
      await api.sprite.remove(deletingSprite.id)
      toast('已删除')
      setDeletingSprite(null)
      await loadSprites()
    } catch (err) {
      toast(err instanceof Error ? err.message : '删除失败', 'error')
    }
  }

  /** 打开立绘集的"状态演出"编辑弹窗（词表 + 默认状态 + 说话/思考立绘） */
  const openEmotionMap = (s: CharacterSprite) => {
    setSpriteWordCount(s.emotions.length)
    setSpriteDirty(false)
    setEmotionEditing(s)
  }

  // 模型词表词条数：打开模型弹窗时异步拉取（词表在 data/model-palettes.json，meta 上无此数据）
  useEffect(() => {
    if (!paletteEditing) {
      setPaletteWordCount(null)
      return
    }
    let alive = true
    void api.model
      .getPalette(paletteEditing.id)
      .then((p) => {
        if (alive) setPaletteWordCount(p?.entries.length ?? 0)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [paletteEditing])

  /** 词表保存成功：刷新列表并同步弹窗内的立绘集快照（避免编辑器草稿被旧数据覆盖） */
  const handlePaletteSaved = async () => {
    await loadSprites()
    if (emotionEditing) {
      const fresh = (await api.sprite.list()).find((s) => s.id === emotionEditing.id)
      if (fresh) setEmotionEditing(fresh)
    }
  }

  /** 打开重命名弹窗（Live2D 模型卡片 / 2D 立绘集卡片共用） */
  const openRename = (kind: 'model' | 'sprite', id: string, name: string) => {
    setRenaming({ kind, id, name })
    setRenameDraft(name)
  }

  /**
   * 提交重命名：模型走 model:rename（仅展示名，不动磁盘目录），
   * 立绘集走 sprite:update({ name })；成功后分别刷新对应列表。
   */
  const handleRename = async () => {
    if (!renaming) return
    const name = renameDraft.trim()
    if (!name) {
      toast('名称不能为空', 'error')
      return
    }
    try {
      if (renaming.kind === 'model') {
        await api.model.rename(renaming.id, name)
        await refresh()
      } else {
        await api.sprite.update(renaming.id, { name })
        await loadSprites()
      }
      toast('已重命名')
      setRenaming(null)
    } catch (err) {
      toast(err instanceof Error ? err.message : '重命名失败', 'error')
    }
  }

  /** 选择当前全局使用的 Live2D 模型（互斥：清除全局立绘选中） */
  const handleSelectModel = async (modelId: string) => {
    if (settings.selectedModelId === modelId) return
    try {
      await save({ selectedModelId: modelId, selectedSpriteId: null })
      toast('已切换当前模型')
    } catch (err) {
      toast(err instanceof Error ? err.message : '切换失败', 'error')
    }
  }

  /** 选择当前全局使用的 2D 立绘集（互斥：清除全局模型选中），并驱动桌面切为立绘 */
  const handleSelectSprite = async (spriteId: string) => {
    if (settings.selectedSpriteId === spriteId) return
    try {
      await save({ selectedSpriteId: spriteId, selectedModelId: null })
      toast('已切换当前立绘集')
    } catch (err) {
      toast(err instanceof Error ? err.message : '切换失败', 'error')
    }
  }

  // ---- 参数更新辅助函数 ----

  /** 更新单个动画设置 */
  const updateAnim = <K extends keyof ModelAnimationSettings>(key: K, value: ModelAnimationSettings[K]) => {
    void save({ animation: { ...settings.animation, [key]: value } })
  }

  /** 更新缩放/位置 */
  const updateView = (key: 'scale' | 'x' | 'y', value: number) => {
    void save({ view: { ...settings.view, [key]: value } })
  }

  /** 更新 2D 立绘集的缩放/位置 */
  const updateSpriteView = (key: 'scale' | 'x' | 'y', value: number) => {
    void save({ spriteView: { ...settings.spriteView, [key]: value } })
  }

  /** tab 角标：标记「桌面此刻用的是哪一套」。模型与立绘互斥，所以最多只有一个点 */
  const tabBadge = (id: ModelTab) => {
    const active = id === 'live2d' ? !!settings.selectedModelId : !!settings.selectedSpriteId
    return active ? (
      <span title="桌面当前使用" className="h-1.5 w-1.5 rounded-full bg-[var(--primary-400)]" />
    ) : undefined
  }

  return (
    <div className="space-y-4">
      {/* 二级 tab：分开管理两套模型资源 */}
      <TabBar
        tabs={MODEL_TABS.map((t) => ({ ...t, badge: tabBadge(t.id) }))}
        value={tab}
        onChange={setTab}
      />

      {tab === 'live2d' && (
        <>
          {/* Cubism Core */}
          <div className="rounded-[var(--radius-lg)] border border-border bg-card/70 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-sm font-semibold text-text">
                  Cubism Core 运行库
                  {corePresent ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-normal text-success ring-1 ring-success/30">
                      <CheckCircle2 size={11} /> 已就绪
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-normal text-warning ring-1 ring-warning/30">
                      <AlertCircle size={11} /> 未导入
                    </span>
                  )}
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-text-muted">
                  Live2D Cubism Core（live2dcubismcore.min.js）是官方闭源 SDK，无法随应用分发，需您手动导入。
                  请前往{' '}
                  <a
                    className="text-accent underline hover:text-accent-2"
                    href="https://www.live2d.com/sdk/download/web/"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Live2D 官网
                  </a>{' '}
                  下载 Cubism SDK for Web（推荐 <code className="rounded-[var(--radius-sm)] bg-surface-2 px-1">CubismSdkForWeb-5-r.4</code>），解压后在{' '}
                  <code className="rounded-[var(--radius-sm)] bg-surface-2 px-1">Core/</code> 中选择其中的{' '}
                  <code className="rounded-[var(--radius-sm)] bg-surface-2 px-1">live2dcubismcore.min.js</code> 文件。
                </p>
                <p className="mt-1 text-[11px] leading-relaxed text-text-muted">
                  注意：不推荐 5-r.5 及更高版本，其携带的 Core 6 与内置渲染库不兼容，会导致模型无法显示。
                </p>
              </div>
              <Button variant={corePresent ? 'outline' : 'primary'} onClick={() => void handleImportCore()}>
                {corePresent ? '重新导入' : '导入运行库'}
              </Button>
            </div>
          </div>

          {/* 模型列表 */}
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-text">Live2D 模型（{models.length}）</span>
            <Button onClick={() => void handleImportFolder()} disabled={importing}>
              <Plus size={14} strokeWidth={2.25} />
              {importing ? '导入中…' : '从文件夹导入'}
            </Button>
          </div>

          {loading ? (
            <Loading />
          ) : models.length === 0 ? (
            <Empty text="还没有模型。选择包含 xxx.model3.json 的文件夹导入（会复制到应用数据目录）" />
          ) : (
            <div className="space-y-2">
              {models.map((m) => {
                const selected = settings.selectedModelId === m.id
                return (
                  <div
                    key={m.id}
                    className={cn(
                      'flex cursor-pointer items-center gap-3 rounded-[var(--radius-lg)] border border-border px-4 py-2.5 transition-colors hover:bg-card-hover',
                      selected && 'border-[var(--primary-400)] bg-primary-500/10',
                    )}
                    onClick={() => void handleSelectModel(m.id)}
                  >
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-md)]" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}>
                      <PersonStanding size={17} strokeWidth={1.75} color="var(--primary-400)" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <div className="truncate text-sm font-medium text-text">{m.name}</div>
                        {selected && (
                          <span className="inline-flex shrink-0 items-center rounded-full bg-[var(--primary-400)]/15 px-2 py-0.5 text-[10px] text-[var(--primary-400)] ring-1 ring-[var(--primary-400)]/30">
                            当前选择
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 truncate text-xs text-text-muted selectable">
                        {m.model3Path} · {formatRelativeTime(m.createdAt)} 导入
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation()
                        setModelDirty(false)
                        setPaletteEditing(m)
                      }}
                    >
                      <Smile size={13} strokeWidth={2} />
                      状态演出
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation()
                        openRename('model', m.id, m.name)
                      }}
                    >
                      <Pencil size={13} strokeWidth={2} />
                      重命名
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation()
                        setDeleting(m)
                      }}
                    >
                      删除
                    </Button>
                  </div>
                )
              })}
            </div>
          )}

                {/* ==================== 模型设置分区 ==================== */}

          {!loaded ? (
            <Loading text="加载模型设置…" />
          ) : (
            <>
              {/* 1. 缩放与位置 */}
              <AccordionItem title="缩放与位置" icon={<Maximize2 size={15} strokeWidth={1.75} />} defaultOpen={false}>
                <Slider
                  label="缩放"
                  value={settings.view.scale}
                  min={0.1}
                  max={3}
                  step={0.01}
                  defaultValue={DEFAULT_VIEW.scale}
                  onChange={(v) => updateView('scale', v)}
                  format={(v) => v.toFixed(2)}
                />
                <Slider
                  label="X"
                  value={settings.view.x}
                  min={-500}
                  max={500}
                  step={1}
                  defaultValue={0}
                  onChange={(v) => updateView('x', v)}
                  format={(v) => v.toFixed(0)}
                />
                <Slider
                  label="Y"
                  value={settings.view.y}
                  min={-500}
                  max={500}
                  step={1}
                  defaultValue={0}
                  onChange={(v) => updateView('y', v)}
                  format={(v) => v.toFixed(0)}
                />
              </AccordionItem>

              {/* 2. 动画 */}
              <AccordionItem title="动画" icon={<Play size={15} strokeWidth={1.75} />} defaultOpen={false}>
                {/* 鼠标跟踪 */}
                <div className="border-b border-border py-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-[13px] font-medium text-text-2">鼠标跟踪</div>
                      <div className="mt-0.5 text-xs leading-relaxed text-text-muted">
                        模型头部和眼球跟随光标移动。光标停止后恢复空闲眼神。
                      </div>
                    </div>
                    <Switch checked={settings.animation.mouseTracking} onChange={(v) => updateAnim('mouseTracking', v)} />
                  </div>
                  {settings.animation.mouseTracking && (
                    <div className="mt-3 space-y-1">
                      <div className="mb-1 text-xs font-medium text-text-muted">眼睛偏移 (%)</div>
                      <Slider
                        label="X"
                        value={settings.animation.eyeOffsetX}
                        min={-100}
                        max={100}
                        step={1}
                        defaultValue={0}
                        onChange={(v) => updateAnim('eyeOffsetX', v)}
                        format={(v) => v.toFixed(0)}
                      />
                      <Slider
                        label="Y"
                        value={settings.animation.eyeOffsetY}
                        min={-100}
                        max={100}
                        step={1}
                        defaultValue={0}
                        onChange={(v) => updateAnim('eyeOffsetY', v)}
                        format={(v) => v.toFixed(0)}
                      />
                    </div>
                  )}
                </div>

                {/* 空闲眼神 */}
                <div className="border-b border-border py-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-[13px] font-medium text-text-2">空闲眼神动画</div>
                      <div className="mt-0.5 text-xs leading-relaxed text-text-muted">
                        无光标焦点时随机看向四周，模拟自然眼球运动。
                      </div>
                    </div>
                    <Switch checked={settings.animation.idleEyeMovement} onChange={(v) => updateAnim('idleEyeMovement', v)} />
                  </div>
                </div>

                {/* 眨眼 */}
                <div className="border-b border-border py-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-[13px] font-medium text-text-2">眨眼</div>
                      <div className="mt-0.5 text-xs leading-relaxed text-text-muted">
                        让模型自主眨眼。
                      </div>
                    </div>
                    <Switch checked={settings.animation.enableBlink} onChange={(v) => updateAnim('enableBlink', v)} />
                  </div>
                  {settings.animation.enableBlink && (
                    <p className="mt-1.5 text-xs leading-relaxed text-text-muted">
                      眨眼由应用自己的计时器驱动。模型内置的眨眼曲线会让手动「眼睛开合」失效，已停用。
                    </p>
                  )}
                </div>

              </AccordionItem>

              {/* 3. 外观：表情 / 装扮 / 道具 / 动作（合并原「表情」区） */}
              <AccordionItem
                title="外观"
                icon={<Palette size={15} strokeWidth={1.75} />}
                defaultOpen={false}
                badge={describeAppearance(effectiveAppearance) || undefined}
              >
                <AppearanceSection
                  enabled={settings.animation.expressionEnabled}
                  selected={effectiveAppearance}
                  persistent={modelAppearance}
                  expressions={expressions}
                  layout={modelLayout}
                  stateExpression={stateExpression}
                  onDismissState={() => void api.pet.dismissStateExpression()}
                  motionGroups={motionGroups}
                  idleAnimation={settings.animation.idleAnimation}
                  scanning={scanning}
                  scanResult={scanResult}
                  canScan={!!currentModelId}
                  onEnabledChange={(v) => updateAnim('expressionEnabled', v)}
                  onSelectedChange={applyAppearance}
                  onLayoutChange={applyLayout}
                  onIdleAnimationChange={(v) => updateAnim('idleAnimation', v)}
                  onQuickMotion={(g) => void api.model.playMotion(g)}
                  onScan={handleScanAssets}
                />
              </AccordionItem>

              {/* 4. 姿态：原先 20 个参数没有 UI，这里按模型给滑杆 */}
              <AccordionItem
                title="姿态"
                icon={<SlidersHorizontal size={15} strokeWidth={1.75} />}
                defaultOpen={false}
                badge={summarizeProfile(modelProfile) ?? (currentModelId ? '仅当前模型' : undefined)}
              >
                <PoseSection
                  parameters={modelParameters}
                  profile={modelProfile}
                  onChange={applyModelParameters}
                  onReset={resetModelParameters}
                />
              </AccordionItem>
            </>
          )}
        </>
      )}

      {tab === 'sprite' && (
        <>
          {/* ==================== 2D 立绘分区 ==================== */}
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-text">2D 立绘集（{sprites.length}）</span>
            <Button onClick={() => void handleImportSprite()} disabled={importingSprite}>
              <Images size={14} strokeWidth={2.25} />
              {importingSprite ? '导入中…' : '从文件夹导入'}
            </Button>
          </div>
          <p className="text-xs leading-relaxed text-text-muted">
            立绘集 = 一个含多张状态切图的文件夹（png/jpg/webp）。导入后在「角色卡 → 外观」中把立绘集与状态映射绑定到角色。
          </p>

          {sprites.length === 0 ? (
            <div className="rounded-[var(--radius-lg)] border border-border bg-card/70 p-4">
              <div className="flex items-center gap-3 py-2">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-md)]" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}>
                  <Images size={17} strokeWidth={1.75} color="var(--primary-400)" />
                </div>
                <div className="flex-1 text-sm text-text-muted">还没有立绘集。导入包含状态切图的文件夹即可。</div>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {sprites.map((s) => (
                <div
                  key={s.id}
                  className={cn(
                    'flex cursor-pointer items-center gap-3 rounded-[var(--radius-lg)] border border-border px-4 py-2.5 transition-colors hover:bg-card-hover',
                    settings.selectedSpriteId === s.id && 'border-[var(--primary-400)] bg-primary-500/10',
                  )}
                  onClick={() => void handleSelectSprite(s.id)}
                >
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-md)]" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}>
                    <Images size={17} strokeWidth={1.75} color="var(--primary-400)" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <div className="truncate text-sm font-medium text-text">{s.name}</div>
                      {settings.selectedSpriteId === s.id && (
                        <span className="inline-flex shrink-0 items-center rounded-full bg-[var(--primary-400)]/15 px-2 py-0.5 text-[10px] text-[var(--primary-400)] ring-1 ring-[var(--primary-400)]/30">
                          当前选择
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 truncate text-xs text-text-muted selectable">
                      {s.images.length} 张图 · 编号 {s.emotions.length} · {formatRelativeTime(s.createdAt)} 导入
                    </div>
                  </div>
                  <Button variant="outline" size="sm" onClick={(e) => { e.stopPropagation(); openRename('sprite', s.id, s.name) }}>
                    <Pencil size={13} strokeWidth={2} />
                    重命名
                  </Button>
                  <Button variant="outline" size="sm" onClick={(e) => { e.stopPropagation(); openEmotionMap(s) }}>
                    <Smile size={14} strokeWidth={2} />
                    状态映射
                  </Button>
                  <Button variant="danger" size="sm" onClick={(e) => { e.stopPropagation(); setDeletingSprite(s) }}>
                    删除
                  </Button>
                </div>
              ))}
            </div>
          )}

          {/* ==================== 2D 立绘缩放与位置 ==================== */}
          {loaded && (
            <AccordionItem title="立绘缩放与位置" icon={<Maximize2 size={15} strokeWidth={1.75} />} defaultOpen={false}>
              <Slider
                label="缩放"
                value={settings.spriteView.scale}
                min={0.1}
                max={3}
                step={0.01}
                defaultValue={DEFAULT_VIEW.scale}
                onChange={(v) => updateSpriteView('scale', v)}
                format={(v) => v.toFixed(2)}
              />
              <Slider
                label="X"
                value={settings.spriteView.x}
                min={-500}
                max={500}
                step={1}
                defaultValue={0}
                onChange={(v) => updateSpriteView('x', v)}
                format={(v) => v.toFixed(0)}
              />
              <Slider
                label="Y"
                value={settings.spriteView.y}
                min={-500}
                max={500}
                step={1}
                defaultValue={0}
                onChange={(v) => updateSpriteView('y', v)}
                format={(v) => v.toFixed(0)}
              />
            </AccordionItem>
          )}
        </>
      )}

      <ConfirmModal
        open={!!deleting}
        title="删除模型"
        message={`确定删除模型「${deleting?.name}」吗？其文件夹将被移除，绑定该模型的角色卡会解除绑定。`}
        confirmText="删除"
        danger
        onConfirm={() => void handleDelete()}
        onClose={() => setDeleting(null)}
      />

      <ConfirmModal
        open={!!deletingSprite}
        title="删除立绘集"
        message={`确定删除立绘集「${deletingSprite?.name}」吗？其文件夹将被移除，绑定该立绘集的角色卡将不再显示立绘。`}
        confirmText="删除"
        danger
        onConfirm={() => void handleDeleteSprite()}
        onClose={() => setDeletingSprite(null)}
      />

      {/* 状态演出编辑弹窗：状态词表（唯一状态配置入口）+ 说话/思考立绘（所见即所得图片标注，需宽弹窗） */}
      <Modal
        open={!!emotionEditing}
        onClose={() => (spriteDirty ? setConfirmLeave('sprite') : setEmotionEditing(null))}
        title={`状态演出 · ${emotionEditing?.name ?? ''}（编号 ${spriteWordCount ?? emotionEditing?.emotions.length ?? 0}）`}
        width={860}
      >
        {emotionEditing && (
          <SpritePaletteEditor
            sprite={emotionEditing}
            onSaved={() => void handlePaletteSaved()}
            onEntriesChange={setSpriteWordCount}
            onDirtyChange={setSpriteDirty}
          />
        )}
      </Modal>

      {/* 模型状态词表编辑弹窗（Live2D 模型卡入口）：一条标签 ↔ 一个表情（与立绘集词表双轨对等） */}
      <Modal
        open={!!paletteEditing}
        onClose={() => (modelDirty ? setConfirmLeave('model') : setPaletteEditing(null))}
        title={`状态演出 · ${paletteEditing?.name ?? ''}${paletteWordCount != null ? `（编号 ${paletteWordCount}）` : ''}`}
        width={640}
      >
        {paletteEditing && (
          <ModelPaletteEditor
            model={paletteEditing}
            onClose={() => setPaletteEditing(null)}
            onSaved={() => undefined}
            onDirtyChange={setModelDirty}
          />
        )}
      </Modal>

      {/* 未保存修改的关闭确认：右上角 X / 点遮罩 / Esc 都走这里 */}
      <ConfirmModal
        open={confirmLeave !== null}
        title="放弃未保存的修改？"
        message="状态演出有改动尚未保存，关闭后这些修改会丢失。"
        confirmText="放弃修改"
        cancelText="继续编辑"
        danger
        onConfirm={() => {
          if (confirmLeave === 'sprite') {
            setEmotionEditing(null)
            setSpriteDirty(false)
          } else if (confirmLeave === 'model') {
            setPaletteEditing(null)
            setModelDirty(false)
          }
        }}
        onClose={() => setConfirmLeave(null)}
      />

      {/* 重命名弹窗（Live2D 模型 / 2D 立绘集共用）：回车提交 */}
      <Modal
        open={!!renaming}
        onClose={() => setRenaming(null)}
        title={renaming?.kind === 'model' ? '重命名模型' : '重命名立绘集'}
        width={380}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRenaming(null)}>
              取消
            </Button>
            <Button onClick={() => void handleRename()}>确认</Button>
          </>
        }
      >
        <Field label="名称" hint="仅更改展示名称，不影响磁盘目录与文件。">
          <Input
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            placeholder="输入新名称"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleRename()
            }}
          />
        </Field>
      </Modal>
    </div>
  )
}
