/**
 * 角色模型面板：Cubism Core 引导 + Live2D 模型导入/管理 + 模型设置（缩放/位置/动画）。
 * 模型设置通过 zustand store 管理，变更后通过 IPC 广播到桌宠窗口实时生效。
 */
import { useEffect, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Maximize2,
  PersonStanding,
  Play,
  Plus,
  Smile,
} from 'lucide-react'
import { api } from '../../api'
import type { Live2DModelMeta, ModelAnimationSettings, BlinkMode, ExpressionMeta } from '../../types'
import {
  AccordionItem,
  Button,
  Card,
  ConfirmModal,
  Empty,
  Loading,
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
  /** 可用的动作组列表（从模型 model3.json 读取） */
  const [motionGroups, setMotionGroups] = useState<string[]>([])
  /** 可用的表情列表（从选中模型的 exp3.json 读取） */
  const [expressions, setExpressions] = useState<ExpressionMeta[]>([])

  const { settings, loaded, load, save } = useModelSettingsStore()

  const refresh = async () => {
    const [core, list] = await Promise.all([api.model.coreStatus(), api.model.list()])
    setCorePresent(core.present)
    setModels(list)
    setLoading(false)
    // 读取第一个模型的动作组（用于空闲动作下拉框）
    if (list.length > 0) {
      try {
        const groups = await api.model.motionGroups(list[0]!.id)
        setMotionGroups(groups)
      } catch {
        setMotionGroups([])
      }
    } else {
      setMotionGroups([])
    }
  }

  useEffect(() => {
    void refresh()
    void load()
  }, [load])

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

  /** 选择当前全局使用的 Live2D 模型 */
  const handleSelectModel = async (modelId: string) => {
    if (settings.selectedModelId === modelId) return
    try {
      await save({ selectedModelId: modelId })
      toast('已切换当前模型')
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
          <AccordionItem title="缩放与位置" icon={<Maximize2 size={15} strokeWidth={1.75} />}>
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
          <AccordionItem title="动画" icon={<Play size={15} strokeWidth={1.75} />}>
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
          <AccordionItem title="表情" icon={<Smile size={15} strokeWidth={1.75} />}>
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

      <ConfirmModal
        open={!!deleting}
        title="删除模型"
        message={`确定删除模型「${deleting?.name}」吗？其文件夹将被移除，绑定该模型的角色卡会解除绑定。`}
        confirmText="删除"
        danger
        onConfirm={() => void handleDelete()}
        onClose={() => setDeleting(null)}
      />
    </div>
  )
}
