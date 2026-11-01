/**
 * 角色模型设置里的两块可折叠内容：
 *  - PoseSection：姿态滑杆（按模型能力表渲染：量程取模型真实值，缺失参数只做文字提示、不隐藏）
 *  - AppearanceSection：外观（表情开关 + 装扮 + 道具 + 动作）
 *
 * 两者都按"当前模型"渲染：姿态值来自 parametersByModel[modelId]，
 * 外观选中项来自 appearancesByModel[modelId]，分组覆盖来自 appearanceLayoutByModel[modelId]。
 */
import { useState } from 'react'
import { ChevronDown, MoreHorizontal, RotateCcw, X } from 'lucide-react'
import type { ExpressionMeta, ModelAppearanceLayout, ModelParameters, ModelProfile } from '../../types'
import { Button, Input, Modal, SegmentedControl, Slider, Switch } from '../../components/ui'
import { DropdownMenu, SelectMenu } from '../../components/DropdownMenu'
import { cn } from '../../lib/utils'
import { buildAppearanceCatalog } from '../../lib/appearanceCatalog'
import { type PoseGroup, type ResolvedSlider, resolveSliders } from '../../lib/modelProfile'

/** 一组姿态滑杆的通用包装：两列布局 */
function SliderGrid({ children, cols = 2 }: { children: React.ReactNode; cols?: 1 | 2 }) {
  return <div className={cn('mt-1 grid gap-x-5', cols === 2 ? 'grid-cols-2' : 'grid-cols-1')}>{children}</div>
}

/** 姿态参数是否偏离默认值（用于折叠标题上的"已改 N 项"） */
function countDirtyParameters(p: ModelParameters): number {
  const defaults: ModelParameters = {
    angleX: 0, angleY: 0, angleZ: 0,
    leftEyeOpen: 1, rightEyeOpen: 1, leftEyeSmile: 0,
    leftEyebrowLR: 0, rightEyebrowLR: 0, leftEyebrowY: 0, rightEyebrowY: 0,
    leftEyebrowAngle: 0, rightEyebrowAngle: 0, leftEyebrowForm: 0, rightEyebrowForm: 0,
    mouthOpen: 0, mouthForm: 0, cheek: 0,
    bodyAngleX: 0, bodyAngleY: 0, bodyAngleZ: 0, breath: 0,
  }
  return (Object.keys(defaults) as Array<keyof ModelParameters>).filter(
    (k) => Math.abs(p[k] - defaults[k]) > 0.001,
  ).length
}

/**
 * 姿态滑杆。
 *
 * 每根滑杆的「是否存在 / 量程 / 是否由物理驱动」全部来自模型能力表：
 *  - 模型没有的参数仍然显示（避免用户以为功能被砍），但在下方列一行"没有这些参数"的提示
 *  - 量程用模型自己的 min/max（阿库露的身体角度只有 ±10，写死的 ±30 有 2/3 拖了没反应）
 *  - 物理输出的参数标一个「物理」小标，提示实际写入的是它的上游控制器
 */
export function PoseSection({
  parameters,
  profile,
  onChange,
  onReset,
}: {
  parameters: ModelParameters
  /** 当前模型的能力表；null = 模型还没加载（退回兜底量程，全部显示） */
  profile: ModelProfile | null
  onChange: (patch: Partial<ModelParameters>) => void
  onReset: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const sliders = resolveSliders(profile)
  const dirty = countDirtyParameters(parameters)
  const primary = sliders.filter((s) => s.primary)
  const detail = sliders.filter((s) => !s.primary)
  const drivers = sliders.filter((s) => s.driver)
  // 不支持的项按 id 去重（"眼睛开合"与"左眼开合"共用 ParamEyeLOpen）
  const missing = Array.from(new Map(sliders.filter((s) => !s.available).map((s) => [s.id, s.label])).entries())

  const groupTitle: Record<PoseGroup, string> = {
    eye: '眼睛',
    brow: '眉毛',
    mouth: '嘴巴',
    body: '身体',
    head: '头部',
  }
  const detailGroups: PoseGroup[] = ['eye', 'brow', 'mouth', 'body']

  const renderSlider = (s: ResolvedSlider) => {
    const extra = s.alsoWrites ?? []
    const value = extra.length > 0 ? Math.min(parameters[s.key], ...extra.map((k) => parameters[k])) : parameters[s.key]
    return (
      <Slider
        key={`${s.id}-${s.label}`}
        label={s.label}
        badge={
          s.driver ? (
            <span
              className="rounded bg-primary-500/12 px-1 py-px text-[10px] font-normal text-primary-400"
              title={`该参数由物理驱动，实际写入 ${s.driver}`}
            >
              物理
            </span>
          ) : undefined
        }
        value={value}
        min={s.range.min}
        max={s.range.max}
        step={s.step}
        defaultValue={s.range.def}
        onChange={(v) => {
          const patch = { [s.key]: v } as Partial<ModelParameters>
          for (const k of extra) patch[k] = v
          onChange(patch)
        }}
        format={s.format === 'deg' ? (v) => `${v.toFixed(0)}°` : (v) => v.toFixed(2)}
      />
    )
  }

  return (
    <div>
      <div className="flex items-start justify-between gap-3 border-b border-border py-2.5">
        <div>
          <div className="text-[13px] font-medium text-text-2">基础姿态</div>
          <div className="mt-0.5 text-xs leading-relaxed text-text-muted">
            数值只作用于当前模型。头部角度与鼠标跟踪叠加：鼠标不动时保持这里设定的姿势。
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {dirty > 0 && <span className="text-xs text-primary-400">已改 {dirty} 项</span>}
          <Button variant="outline" size="sm" onClick={onReset} disabled={dirty === 0}>
            归零
          </Button>
        </div>
      </div>

      <SliderGrid>{primary.map(renderSlider)}</SliderGrid>

      {profilesNotes(profile, missing, drivers)}

      <button
        onClick={() => setExpanded((v) => !v)}
        className="mt-2 flex items-center gap-1 text-xs text-text-muted transition-colors hover:text-text-2"
      >
        <ChevronDown size={12} strokeWidth={2} className={cn('transition-transform', expanded && 'rotate-180')} />
        {expanded ? '收起细节' : '更多（左右眼 / 眉毛 / 嘴形 / 身体）'}
      </button>

      {expanded && (
        <div className="mt-1 border-t border-border pt-1">
          {detailGroups.map((g) => {
            const list = detail.filter((s) => s.group === g)
            if (list.length === 0) return null
            return (
              <div key={g}>
                <div className="mt-2 text-xs font-medium text-text-muted">{groupTitle[g]}</div>
                <SliderGrid>{list.map(renderSlider)}</SliderGrid>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** 能力表相关的两行说明：模型未加载 / 不支持项 / 物理驱动项 */
function profilesNotes(
  profile: ModelProfile | null,
  missing: Array<[string, string]>,
  drivers: ResolvedSlider[],
): React.ReactNode {
  if (!profile) {
    return (
      <p className="mt-2 text-xs leading-relaxed text-text-muted">
        模型尚未加载，量程暂用默认值；桌宠加载完成后会自动按该模型的真实参数表刷新。
      </p>
    )
  }
  return (
    <>
      {missing.length > 0 && (
        <p className="mt-2 text-xs leading-relaxed text-text-muted">
          本模型没有这些参数：{missing.map(([, label]) => label).join('、')}（调了不会有反应）
        </p>
      )}
      {drivers.length > 0 && (
        <p className="mt-2 text-xs leading-relaxed text-text-muted">
          标「物理」的项会被物理每帧重算，因此写入的是它的上游控制器（如 ParamAngleX → AngleX）。
        </p>
      )}
    </>
  )
}

/** 外观开关的一枚胶囊按钮（hover 出现隐藏按钮） */
function Chip({
  active,
  label,
  onClick,
  onHide,
  stateDriven,
}: {
  active: boolean
  label: string
  onClick: () => void
  onHide?: () => void
  /** 由状态词表驱动：高亮 + "·状态"标记，点击=取消该状态表情 */
  stateDriven?: boolean
}) {
  return (
    <span className="group/chip relative inline-flex">
      <button
        onClick={onClick}
        title={stateDriven ? '由当前状态词表驱动，点击可取消' : undefined}
        className={cn(
          stateDriven && 'ring-1 ring-primary-400/70',
          'rounded-[var(--radius-sm)] border px-2.5 py-1 text-xs font-medium transition-colors',
          active
            ? 'border-primary-400/60 bg-brand-gradient text-[var(--on-brand)]'
            : 'border-border bg-surface-2 text-text-muted hover:text-text',
        )}
      >
        {label}
        {stateDriven && <span className="ml-1 opacity-80">·状态</span>}
      </button>
      {onHide && (
        <button
          onClick={onHide}
          title="隐藏这一项（不删除模型里的表情）"
          className="absolute -right-1.5 -top-1.5 hidden rounded-full border border-border bg-[var(--bg-panel)] p-0.5 text-text-muted hover:text-danger group-hover/chip:block"
        >
          <X size={9} strokeWidth={3} />
        </button>
      )}
    </span>
  )
}

export function AppearanceSection({
  enabled,
  selected,
  persistent,
  expressions,
  layout,
  stateExpression,
  onDismissState,
  motionGroups,
  idleAnimation,
  scanning,
  scanResult,
  canScan,
  onEnabledChange,
  onSelectedChange,
  onLayoutChange,
  onIdleAnimationChange,
  onQuickMotion,
  onScan,
}: {
  enabled: boolean
  /** 显示用（外观 ∪ 状态） */
  selected: string[]
  /** 用户持久保存的外观选中项（写入用） */
  persistent: string[]
  expressions: ExpressionMeta[]
  layout: ModelAppearanceLayout
  /** 当前由状态词表驱动的表情（null = 无） */
  stateExpression: string | null
  /** 取消当前状态表情 */
  onDismissState: () => void
  motionGroups: string[]
  idleAnimation: string
  scanning: boolean
  scanResult: string | null
  canScan: boolean
  onEnabledChange: (v: boolean) => void
  onSelectedChange: (next: string[]) => void
  onLayoutChange: (next: ModelAppearanceLayout) => void
  onIdleAnimationChange: (v: string) => void
  onQuickMotion: (group: string) => void
  onScan: () => void
}) {
  const catalog = buildAppearanceCatalog(expressions, layout)
  const [renaming, setRenaming] = useState<{ groupId: string; title: string } | null>(null)

  const overrideCount =
    Object.keys(layout.groups ?? {}).length + (layout.hiddenGroups?.length ?? 0) + (layout.hiddenItems?.length ?? 0)

  /** 写一条分组标题覆盖 */
  const patchGroupTitle = (groupId: string, title: string) => {
    const groups = { ...(layout.groups ?? {}) }
    groups[groupId] = { ...(groups[groupId] ?? {}), title }
    onLayoutChange({ ...layout, groups })
  }
  const hideGroup = (groupId: string) => {
    onLayoutChange({ ...layout, hiddenGroups: [...new Set([...(layout.hiddenGroups ?? []), groupId])] })
  }
  const hideItem = (name: string) => {
    onLayoutChange({ ...layout, hiddenItems: [...new Set([...(layout.hiddenItems ?? []), name])] })
  }

  const toggle = (name: string, groupId: string) => {
    const radio = catalog.find((g) => g.id === groupId)
    if (!enabled) onEnabledChange(true)
    // 状态驱动的项：点击 = 取消该状态表情（并把它从持久层里也摘掉，避免"看着关不掉"）
    if (name === stateExpression) {
      onDismissState()
      if (persistent.includes(name)) onSelectedChange(persistent.filter((n) => n !== name))
      return
    }
    // 写入一律基于 persistent（持久层），显示才用 selected（合成结果）
    if (radio && radio.kind === 'radio') {
      const others = persistent.filter((n) => !radio.items.some((i) => i.name === n))
      onSelectedChange(persistent.includes(name) ? others : [...others, name])
      return
    }
    onSelectedChange(persistent.includes(name) ? persistent.filter((n) => n !== name) : [...persistent, name])
  }

  return (
    <div>
      <div className="flex items-start justify-between gap-3 border-b border-border py-2.5">
        <div>
          <div className="text-[13px] font-medium text-text-2">启用表情与装扮</div>
          <div className="mt-0.5 text-xs leading-relaxed text-text-muted">
            解析模型文件夹下的 exp3.json：写同一个参数的不同表情会自动合并成一排单选，其余作为独立开关。
            分组只按参数关系划分、不猜用途，标题可点右侧 ⋯ 重命名。
            “说某句话时露出的表情”仍在状态词表里配置。
          </div>
        </div>
        <Switch checked={enabled} onChange={onEnabledChange} />
      </div>

      {!enabled && <p className="py-2.5 text-xs text-text-muted">已关闭：下面的选择不会生效到模型上。</p>}

      {enabled && catalog.length === 0 && (
        <p className="py-2.5 text-xs text-text-muted">
          当前模型未检测到可用的 exp3.json 表情文件。可点下方「扫描模型文件夹」重新识别。
        </p>
      )}

      {enabled &&
        catalog.map((group) => (
          <div key={group.id} className="border-b border-border py-2.5">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="min-w-0 text-xs font-medium text-text-muted">
                <span className="text-text-2">{group.title}</span>
                {group.kind === 'radio' && <span className="ml-1 opacity-70">（互斥）</span>}
                {group.customized && <span className="ml-1 text-primary-400/80">· 已自定义</span>}
              </div>
              <DropdownMenu
                align="end"
                trigger={<MoreHorizontal size={14} strokeWidth={2} />}
                buttonClassName="rounded p-1 text-text-muted transition-colors hover:text-text"
                items={[
                  {
                    key: 'rename',
                    label: group.customized ? '重命名…（已自定义）' : '重命名…',
                    onSelect: () => setRenaming({ groupId: group.id, title: group.title }),
                  },
                  { key: 'hide', label: '隐藏此组', danger: true, onSelect: () => hideGroup(group.id) },
                ]}
              />
            </div>

            {group.kind === 'radio' ? (
              (() => {
                const stateDriven = !!stateExpression && group.items.some((i) => i.name === stateExpression)
                return (
                  <>
                    <SegmentedControl<string>
                      value={selected.find((n) => group.items.some((i) => i.name === n)) ?? ''}
                      onChange={(v) => {
                        if (!enabled) onEnabledChange(true)
                        // 状态占用该组时，改选 = 取消该状态表情（否则状态会一直压在上面）
                        if (stateDriven) onDismissState()
                        const others = persistent.filter((n) => !group.items.some((i) => i.name === n))
                        onSelectedChange(v === '' ? others : [...others, v])
                      }}
                      options={[
                        { value: '', label: '无' },
                        // 与开关保持一致：状态驱动的那一项也带 "·状态" 后缀
                        ...group.items.map((i) => ({
                          value: i.name,
                          label: i.name === stateExpression ? `${i.name}·状态` : i.name,
                        })),
                      ]}
                    />
                    {stateDriven && (
                      <p className="mt-1.5 text-xs text-text-muted">当前由状态词表驱动（{stateExpression}）；改选任意项会取消该状态</p>
                    )}
                  </>
                )
              })()
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {group.items.map((item) => (
                  <Chip
                    key={item.name}
                    label={item.name}
                    active={selected.includes(item.name)}
                    stateDriven={item.name === stateExpression}
                    onClick={() => toggle(item.name, group.id)}
                    onHide={() => hideItem(item.name)}
                  />
                ))}
              </div>
            )}
          </div>
        ))}

      {enabled && overrideCount > 0 && (
        <div className="flex items-center justify-between gap-2 border-b border-border py-2">
          <span className="text-xs text-text-muted">本模型有 {overrideCount} 项分组自定义（含隐藏项）</span>
          <Button variant="outline" size="sm" onClick={() => onLayoutChange({})}>
            恢复自动分组
          </Button>
        </div>
      )}

      <div className="py-2.5">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[13px] font-medium text-text-2">动作</span>
          <Button variant="outline" size="sm" onClick={onScan} disabled={scanning || !canScan}>
            {scanning ? '扫描中…' : '扫描模型文件夹'}
          </Button>
        </div>
        <div className="mb-2 text-xs text-text-muted">空闲动作（循环播放）</div>
        <SelectMenu
          value={idleAnimation}
          onChange={onIdleAnimationChange}
          options={[{ value: '', label: '不应用动作' }, ...motionGroups.map((g) => ({ value: g, label: g }))]}
        />
        {motionGroups.length === 0 ? (
          <p className="mt-1 text-xs text-text-muted">未检测到可用动作组，请先扫描模型文件夹</p>
        ) : (
          <>
            <div className="mb-2 mt-3 text-xs text-text-muted">一键播放（不改变上面的空闲动作）</div>
            <div className="flex flex-wrap gap-1.5">
              {motionGroups.map((g) => (
                <Chip key={g} label={g} active={false} onClick={() => onQuickMotion(g)} />
              ))}
            </div>
          </>
        )}
        {scanResult && <p className="mt-2 text-xs text-primary-500">{scanResult}</p>}
        <p className="mt-2 flex items-start gap-1 text-xs text-text-muted">
          <RotateCcw size={12} strokeWidth={2} className="mt-0.5 shrink-0" />
          扫描会自动识别 *.exp3.json / *.motion3.json 并登记到 model3.json（原文件自动备份）。
        </p>
      </div>

      <Modal
        open={!!renaming}
        onClose={() => setRenaming(null)}
        title="重命名分组"
        footer={
          <>
            <Button variant="outline" onClick={() => setRenaming(null)}>
              取消
            </Button>
            <Button
              onClick={() => {
                if (renaming) patchGroupTitle(renaming.groupId, renaming.title.trim())
                setRenaming(null)
              }}
            >
              保存
            </Button>
          </>
        }
      >
        <Input
          value={renaming?.title ?? ''}
          onChange={(e) => setRenaming((r) => (r ? { ...r, title: e.target.value } : r))}
          placeholder="例如：换装 / 眼型 / 手持道具"
        />
        <p className="mt-2 text-xs text-text-muted">留空则恢复默认标题。</p>
      </Modal>
    </div>
  )
}
