/**
 * 角色模型面板：Cubism Core 引导 + Live2D 模型导入/管理 + 模型设置（缩放/位置/动画）。
 * 模型设置通过 zustand store 管理，变更后通过 IPC 广播到桌宠窗口实时生效。
 */
import { useEffect, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Images,
  Maximize2,
  PersonStanding,
  Play,
  Plus,
  Smile,
} from 'lucide-react'
import { api } from '../../api'
import type { Live2DModelMeta, ModelAnimationSettings, BlinkMode, ExpressionMeta, CharacterSprite, StandardEmotion } from '../../types'
import { EmotionMapEditor, emotionMapToEditor, editorToEmotionMap } from '../../components/EmotionMapEditor'
import {
  AccordionItem,
  Button,
  Card,
  ConfirmModal,
  Empty,
  Field,
  Loading,
  Modal,
  SegmentedControl,
  Select,
  Slider,
  Switch,
} from '../../components/ui'
import { toast } from '../../components/toast'
import { cn, formatRelativeTime } from '../../lib/utils'
import {
  DEFAULT_VIEW,
  useModelSettingsStore,
} from '../../store/modelSettingsStore'

export function CharacterModelPanel() {
  const [corePresent, setCorePresent] = useState(false)
  const [models, setModels] = useState<Live2DModelMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)
  const [deleting, setDeleting] = useState<Live2DModelMeta | null>(null)
  /** 2D 立绘集列表 */
  const [sprites, setSprites] = useState<CharacterSprite[]>([])
  const [importingSprite, setImportingSprite] = useState(false)
  const [deletingSprite, setDeletingSprite] = useState<CharacterSprite | null>(null)
  /** 正在编辑情绪映射的立绘集（非空 = 弹窗打开） */
  const [emotionEditing, setEmotionEditing] = useState<CharacterSprite | null>(null)
  /** 情绪映射编辑草稿（空串 = 不配置） */
  const [emotionDraft, setEmotionDraft] = useState<Record<StandardEmotion, string>>(emotionMapToEditor(null))
  /** 说话立绘编辑草稿（空串 = 不配置） */
  const [speakingDraft, setSpeakingDraft] = useState('')
  /** 思考立绘编辑草稿（空串 = 不配置） */
  const [thinkingDraft, setThinkingDraft] = useState('')
  /** 可用的动作组列表（从模型 model3.json 读取） */
  const [motionGroups, setMotionGroups] = useState<string[]>([])
  /** 可用的表情列表（从选中模型的 exp3.json 读取） */
  const [expressions, setExpressions] = useState<ExpressionMeta[]>([])

  const { settings, loaded, load, save } = useModelSettingsStore()

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

  useEffect(() => {
    void refresh()
    void load()
    void loadSprites()
  }, [load])

  // 立绘集变化（导入/删除）时刷新
  useEffect(() => api.sprite.onChanged(() => void loadSprites()), [])

  /** 选中模型变化时，重新加载该模型的动作组（保证下拉框与实际展示的模型一致） */
  useEffect(() => {
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

  /** 导入立绘集（文件夹，含多张情绪切图） */
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

  /** 打开立绘集的"情绪 → 立绘图"映射 + 说话/思考立绘 编辑弹窗 */
  const openEmotionMap = (s: CharacterSprite) => {
    setEmotionEditing(s)
    setEmotionDraft(emotionMapToEditor(s.emotionMap))
    setSpeakingDraft(s.speakingImage ?? '')
    setThinkingDraft(s.thinkingImage ?? '')
  }

  /** 保存立绘集的展示资产（情绪映射 + 说话/思考立绘） */
  const handleSaveEmotionMap = async () => {
    if (!emotionEditing) return
    try {
      await api.sprite.update(emotionEditing.id, {
        emotionMap: editorToEmotionMap(emotionDraft),
        speakingImage: speakingDraft || null,
        thinkingImage: thinkingDraft || null,
      })
      toast('已保存')
      setEmotionEditing(null)
      await loadSprites()
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败', 'error')
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

  return (
    <div className="space-y-4">
      {/* Cubism Core */}
      <Card>
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
              下载 Cubism SDK for Web，并选择其中的 <code className="rounded-[var(--radius-sm)] bg-surface-2 px-2">live2dcubismcore.min.js</code> 文件。
            </p>
          </div>
          <Button variant={corePresent ? 'outline' : 'primary'} onClick={() => void handleImportCore()}>
            {corePresent ? '重新导入' : '导入运行库'}
          </Button>
        </div>
      </Card>

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
              <Card
                key={m.id}
                className={cn(
                  'flex items-center gap-3 py-3',
                  selected && 'ring-2 ring-[var(--primary-400)] ring-offset-2 ring-offset-[var(--bg-base)] shadow-[0_0_16px_var(--primary-glow)]',
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
                  variant="danger"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation()
                    setDeleting(m)
                  }}
                >
                  删除
                </Button>
              </Card>
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
                <div className="mt-3">
                  <div className="mb-2 text-xs font-medium text-text-muted">眨眼模式</div>
                  <SegmentedControl<BlinkMode>
                    value={settings.animation.blinkMode}
                    onChange={(v) => updateAnim('blinkMode', v)}
                    options={[
                      { value: 'auto', label: '内置' },
                      { value: 'force', label: '强制' },
                    ]}
                  />
                  <p className="mt-1.5 text-xs text-text-muted">
                    {settings.animation.blinkMode === 'auto'
                      ? '使用模型内置眨眼曲线。'
                      : '使用自定义眨眼计时器（适用于无眨眼曲线的模型）。'}
                  </p>
                </div>
              )}
            </div>

            {/* 空闲动作 */}
            <div className="py-2.5">
              <div className="mb-2 text-[13px] font-medium text-text-2">空闲动作</div>
              <Select
                value={settings.animation.idleAnimation}
                onChange={(e) => updateAnim('idleAnimation', e.target.value)}
              >
                <option value="">默认（随机）</option>
                {motionGroups.map((g) => (
                  <option key={g} value={g}>{g}</option>
                ))}
              </Select>
              {motionGroups.length === 0 && (
                <p className="mt-1 text-xs text-text-muted">未检测到可用动作组</p>
              )}
            </div>
          </AccordionItem>

          {/* 3. 表情 */}
          <AccordionItem title="表情" icon={<Smile size={15} strokeWidth={1.75} />} defaultOpen={false}>
            <div className="border-b border-border py-2.5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[13px] font-medium text-text-2">表情系统</div>
                  <div className="mt-0.5 text-xs leading-relaxed text-text-muted">
                    解析模型文件夹下的 exp3.json 文件，应用表情参数到 Live2D 模型。
                    支持 Add / Multiply / Overwrite 三种混合模式。
                  </div>
                </div>
                <Switch
                  checked={settings.animation.expressionEnabled}
                  onChange={(v) => updateAnim('expressionEnabled', v)}
                />
              </div>
              {settings.animation.expressionEnabled && (
                <div className="mt-3">
                  <div className="mb-2 text-xs font-medium text-text-muted">选择表情</div>
                  <Select
                    value={settings.animation.selectedExpression}
                    onChange={(e) => updateAnim('selectedExpression', e.target.value)}
                  >
                    <option value="">不应用表情</option>
                    {expressions.map((expr) => (
                      <option key={expr.name} value={expr.name}>
                        {expr.name}（{expr.parameters.length} 个参数）
                      </option>
                    ))}
                  </Select>
                  {expressions.length === 0 ? (
                    <p className="mt-1 text-xs text-text-muted">
                      当前模型未检测到可用的 exp3.json 表情文件
                    </p>
                  ) : (
                    <p className="mt-1 text-xs text-text-muted">
                      共 {expressions.length} 个表情可用
                    </p>
                  )}
                </div>
              )}
            </div>
          </AccordionItem>
        </>
      )}

      {/* ==================== 2D 立绘分区 ==================== */}
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-text">2D 立绘集（{sprites.length}）</span>
        <Button onClick={() => void handleImportSprite()} disabled={importingSprite}>
          <Images size={14} strokeWidth={2.25} />
          {importingSprite ? '导入中…' : '从文件夹导入'}
        </Button>
      </div>
      <p className="text-xs leading-relaxed text-text-muted">
        立绘集 = 一个含多张情绪切图的文件夹（png/jpg/webp）。导入后在「角色卡 → 外观」中把立绘集与情绪映射绑定到角色。
      </p>

      {sprites.length === 0 ? (
        <Card>
          <div className="flex items-center gap-3 py-2">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-md)]" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}>
              <Images size={17} strokeWidth={1.75} color="var(--primary-400)" />
            </div>
            <div className="flex-1 text-sm text-text-muted">还没有立绘集。导入包含情绪切图的文件夹即可。</div>
          </div>
        </Card>
      ) : (
        <div className="space-y-2">
          {sprites.map((s) => (
            <Card
              key={s.id}
              className={cn(
                'flex items-center gap-3 py-3',
                settings.selectedSpriteId === s.id &&
                  'ring-2 ring-[var(--primary-400)] ring-offset-2 ring-offset-[var(--bg-base)] shadow-[0_0_16px_var(--primary-glow)]',
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
                  {s.images.length} 张图 · {formatRelativeTime(s.createdAt)} 导入
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={(e) => { e.stopPropagation(); openEmotionMap(s) }}>
                <Smile size={14} strokeWidth={2} />
                情绪映射
              </Button>
              <Button variant="danger" size="sm" onClick={(e) => { e.stopPropagation(); setDeletingSprite(s) }}>
                删除
              </Button>
            </Card>
          ))}
        </div>
      )});

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

      {/* 情绪 → 立绘图 映射编辑弹窗 */}
      <Modal
        open={!!emotionEditing}
        onClose={() => setEmotionEditing(null)}
        title={`情绪映射 · ${emotionEditing?.name ?? ''}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEmotionEditing(null)}>
              取消
            </Button>
            <Button onClick={() => void handleSaveEmotionMap()}>保存</Button>
          </>
        }
      >
        <EmotionMapEditor
          title="情绪 → 立绘图映射"
          hint="AI 回复带有该立绘集的情绪时，切换到对应立绘图。缺项回退 neutral / 立绘集首图。"
          options={(emotionEditing?.images ?? []).map((i) => ({ value: i.filePath, label: i.filePath }))}
          map={emotionDraft}
          onChange={setEmotionDraft}
          placeholder="不配置（回退 neutral/首图）"
        />

        {/* 说话 / 思考 立绘 */}
        <Field label="说话立绘" hint="情绪为平静且正在说话时使用（口型场景）。">
          <Select value={speakingDraft} onChange={(e) => setSpeakingDraft(e.target.value)}>
            <option value="">不配置</option>
            {(emotionEditing?.images ?? []).map((i) => (
              <option key={i.filePath} value={i.filePath}>
                {i.filePath}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="思考立绘" hint="AI 开始准备回答到输出文本前使用。">
          <Select value={thinkingDraft} onChange={(e) => setThinkingDraft(e.target.value)}>
            <option value="">不配置</option>
            {(emotionEditing?.images ?? []).map((i) => (
              <option key={i.filePath} value={i.filePath}>
                {i.filePath}
              </option>
            ))}
          </Select>
        </Field>
      </Modal>
    </div>
  )
}
