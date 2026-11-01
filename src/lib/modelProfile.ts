/**
 * Live2D 模型能力表（ModelProfile）——纯函数层。
 *
 * 背景：姿态面板写的是 Cubism 标准参数名，但"这个名字在某个模型里归谁管"完全由模型自己决定：
 *  - 有的模型根本没有这个参数（写入静默失败）
 *  - 有的是物理输出（physics3.json 的 Output，每帧被重算，写了等于没写）
 *  - 有的是 SDK 眨眼目标（引擎每帧在 core.update 之前写一遍）
 * 所以需要现场采集一份"这台模型的能力表"，UI 据此决定滑杆是否出现、量程多少、要不要改写驱动参数。
 *
 * 采集者：桌宠窗（只有它真的加载了模型，能读到 core 的 parameters 表）；
 * 消费者：设置窗（滑杆渲染） + 桌宠窗自身（写入时选目标参数）。
 */
import type { ModelParameters, ModelParamRange, ModelProfile } from '../types'

export type PoseGroup = 'head' | 'eye' | 'brow' | 'mouth' | 'body'

export interface PoseSliderDef {
  /** 对应 ModelParameters 里的字段 */
  key: keyof ModelParameters
  /** Cubism 参数 id */
  id: string
  label: string
  group: PoseGroup
  /** 兜底量程（模型能力表缺失时用） */
  min: number
  max: number
  step: number
  /** 显示格式：角度带 °，其余两位小数 */
  format: 'deg' | 'unit'
  /** 主面板 6 个主滑杆 */
  primary?: boolean
  /** 同时写这些字段（"眼睛开合"一次写左右眼） */
  alsoWrites?: Array<keyof ModelParameters>
}

/**
 * 姿态面板的全部滑杆。顺序即渲染顺序。
 * 量程写的是"通用兜底值"，真实量程一律从 ModelProfile.params[id] 取。
 */
export const POSE_SLIDERS: readonly PoseSliderDef[] = [
  { key: 'angleX', id: 'ParamAngleX', label: '头部左右', group: 'head', min: -30, max: 30, step: 1, format: 'deg', primary: true },
  { key: 'angleY', id: 'ParamAngleY', label: '头部俯仰', group: 'head', min: -30, max: 30, step: 1, format: 'deg', primary: true },
  { key: 'angleZ', id: 'ParamAngleZ', label: '头部倾斜', group: 'head', min: -30, max: 30, step: 1, format: 'deg', primary: true },
  {
    key: 'leftEyeOpen',
    id: 'ParamEyeLOpen',
    label: '眼睛开合',
    group: 'eye',
    min: 0,
    max: 1,
    step: 0.01,
    format: 'unit',
    primary: true,
    alsoWrites: ['rightEyeOpen'],
  },
  { key: 'mouthOpen', id: 'ParamMouthOpenY', label: '嘴巴开合', group: 'mouth', min: 0, max: 1, step: 0.01, format: 'unit', primary: true },
  { key: 'breath', id: 'ParamBreath', label: '呼吸', group: 'body', min: 0, max: 1, step: 0.01, format: 'unit', primary: true },

  { key: 'leftEyeOpen', id: 'ParamEyeLOpen', label: '左眼开合', group: 'eye', min: 0, max: 1, step: 0.01, format: 'unit' },
  { key: 'rightEyeOpen', id: 'ParamEyeROpen', label: '右眼开合', group: 'eye', min: 0, max: 1, step: 0.01, format: 'unit' },
  { key: 'leftEyeSmile', id: 'ParamEyeSmile', label: '眼笑', group: 'eye', min: 0, max: 1, step: 0.01, format: 'unit' },
  { key: 'cheek', id: 'ParamCheek', label: '脸颊红晕', group: 'eye', min: 0, max: 1, step: 0.01, format: 'unit' },

  { key: 'leftEyebrowLR', id: 'ParamBrowLX', label: '左眉左右', group: 'brow', min: -1, max: 1, step: 0.01, format: 'unit' },
  { key: 'rightEyebrowLR', id: 'ParamBrowRX', label: '右眉左右', group: 'brow', min: -1, max: 1, step: 0.01, format: 'unit' },
  { key: 'leftEyebrowY', id: 'ParamBrowLY', label: '左眉上下', group: 'brow', min: -1, max: 1, step: 0.01, format: 'unit' },
  { key: 'rightEyebrowY', id: 'ParamBrowRY', label: '右眉上下', group: 'brow', min: -1, max: 1, step: 0.01, format: 'unit' },
  { key: 'leftEyebrowAngle', id: 'ParamBrowLAngle', label: '左眉角度', group: 'brow', min: -1, max: 1, step: 0.01, format: 'unit' },
  { key: 'rightEyebrowAngle', id: 'ParamBrowRAngle', label: '右眉角度', group: 'brow', min: -1, max: 1, step: 0.01, format: 'unit' },
  { key: 'leftEyebrowForm', id: 'ParamBrowLForm', label: '左眉形状', group: 'brow', min: -1, max: 1, step: 0.01, format: 'unit' },
  { key: 'rightEyebrowForm', id: 'ParamBrowRForm', label: '右眉形状', group: 'brow', min: -1, max: 1, step: 0.01, format: 'unit' },

  { key: 'mouthForm', id: 'ParamMouthForm', label: '嘴形', group: 'mouth', min: -1, max: 1, step: 0.01, format: 'unit' },

  { key: 'bodyAngleX', id: 'ParamBodyAngleX', label: '身体左右', group: 'body', min: -30, max: 30, step: 1, format: 'deg' },
  { key: 'bodyAngleY', id: 'ParamBodyAngleY', label: '身体俯仰', group: 'body', min: -30, max: 30, step: 1, format: 'deg' },
  { key: 'bodyAngleZ', id: 'ParamBodyAngleZ', label: '身体倾斜', group: 'body', min: -30, max: 30, step: 1, format: 'deg' },
]

/** 一个滑杆在当前模型上的最终形态 */
export interface ResolvedSlider extends PoseSliderDef {
  /** 模型是否存在该参数（能力表缺失时视为 true，退回旧行为） */
  available: boolean
  /** 真实量程 */
  range: ModelParamRange
  /** 该参数是物理输出时，真正该写的驱动参数（如 AngleX） */
  driver?: string
}

/** 从模型 core 参数表 + model3.json + physics3.json 组装能力表（纯函数，方便单测/离线复用） */
export function buildModelProfile(input: {
  modelId: string
  paramIds: readonly string[]
  minimumValues: ArrayLike<number>
  maximumValues: ArrayLike<number>
  defaultValues: ArrayLike<number>
  model3?: { Groups?: Array<{ Name?: string; Ids?: string[] }> } | null
  physics?: {
    PhysicsSettings?: Array<{
      Input?: Array<{ Source?: { Id?: string }; Weight?: number }>
      Output?: Array<{ Destination?: { Id?: string }; Weight?: number; Scale?: number }>
    }>
  } | null
}): ModelProfile {
  const params: Record<string, ModelParamRange> = {}
  for (let i = 0; i < input.paramIds.length; i++) {
    params[input.paramIds[i]!] = {
      min: input.minimumValues[i] ?? 0,
      max: input.maximumValues[i] ?? 1,
      def: input.defaultValues[i] ?? 0,
    }
  }

  const physicsOutputs: string[] = []
  const drivers: Record<string, string> = {}
  for (const setting of input.physics?.PhysicsSettings ?? []) {
    const outs = setting.Output ?? []
    const ins = setting.Input ?? []
    for (const o of outs) {
      const id = o.Destination?.Id
      if (id && !physicsOutputs.includes(id)) physicsOutputs.push(id)
    }
    // 只有"单进单出且权重拉满"才认为是可反推的直通链路；多输入混合无法用一个参数替代
    if (outs.length === 1 && ins.length === 1) {
      const out = outs[0]!
      const inp = ins[0]!
      const outId = out.Destination?.Id
      const inId = inp.Source?.Id
      const wIn = inp.Weight ?? 100
      const wOut = out.Weight ?? 100
      if (outId && inId && outId !== inId && wIn >= 99 && wOut >= 99) {
        // 同一输出被多条链路驱动时放弃（无法确定唯一驱动）
        if (drivers[outId] && drivers[outId] !== inId) delete drivers[outId]
        else drivers[outId] = inId
      }
    }
  }

  const groups = input.model3?.Groups ?? []
  const groupIds = (name: string): string[] => {
    const g = groups.find((x) => (x.Name ?? '').toLowerCase() === name.toLowerCase())
    return Array.isArray(g?.Ids) ? g!.Ids!.filter((x): x is string => typeof x === 'string') : []
  }

  return {
    modelId: input.modelId,
    params,
    drivers,
    physicsOutputs,
    eyeBlink: groupIds('EyeBlink'),
    lipSync: groupIds('LipSync'),
    createdAt: Date.now(),
  }
}

/** 参数在能力表里的量程；能力表缺失时返回 null（调用方回退到兜底量程） */
export function paramRange(profile: ModelProfile | null | undefined, id: string): ModelParamRange | null {
  if (!profile) return null
  return profile.params[id] ?? null
}

/** 该参数实际该写哪个 id：物理输出 → 写驱动；其余写自己 */
export function writeTarget(profile: ModelProfile | null | undefined, id: string): string {
  return profile?.drivers?.[id] ?? id
}

/** 解析出当前模型下每个滑杆的可用性 / 量程 / 驱动 */
export function resolveSliders(profile: ModelProfile | null | undefined): ResolvedSlider[] {
  return POSE_SLIDERS.map((def) => {
    const range = paramRange(profile, def.id)
    return {
      ...def,
      available: profile ? range !== null : true,
      range: range ?? { min: def.min, max: def.max, def: def.key === 'leftEyeOpen' || def.key === 'rightEyeOpen' ? 1 : 0 },
      driver: profile?.drivers?.[def.id],
    }
  })
}

/** 姿态区折叠标题的摘要：可用项 / 总数 */
export function summarizeProfile(profile: ModelProfile | null | undefined): string | null {
  if (!profile) return null
  const seen = new Set<string>()
  let total = 0
  let ok = 0
  for (const s of POSE_SLIDERS) {
    if (seen.has(s.id)) continue
    seen.add(s.id)
    total += 1
    if (profile.params[s.id]) ok += 1
  }
  return ok === total ? '本模型全部可用' : `本模型 ${ok}/${total} 项可用`
}
