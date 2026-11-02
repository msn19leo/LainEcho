/**
 * 触摸互动：命中区构建与命中判定（纯函数）。
 *
 * 坐标约定：所有区域都是**相对角色包围盒的归一化值 0~1**，
 * (0,0)=包围盒左上，(1,1)=右下。这样换窗口尺寸 / 换缩放下配置都不用改。
 */
import type { TouchRegion } from '../types'

/** 部件名关键词 → 部位。模型作者起名风格差异很大，这里只做保守匹配 */
export const TOUCH_GROUPS: ReadonlyArray<{ id: string; label: string; keywords: readonly string[] }> = [
  { id: 'head', label: '头', keywords: ['头', 'head', '脸', 'face'] },
  { id: 'body', label: '身体', keywords: ['身体', 'body', '上身', 'torso', 'chest', 'shirt', 'coat'] },
  { id: 'leg', label: '腿', keywords: ['腿', 'leg', 'thigh', 'skirt', '裙'] },
  { id: 'foot', label: '脚', keywords: ['脚', 'foot', 'feet', '鞋', 'shoe', 'boot'] },
]

export interface NormalizedBox {
  x: number
  y: number
  w: number
  h: number
}

export interface PartBox extends NormalizedBox {
  id: string
  name: string
}

function unionBox(a: NormalizedBox | null, b: NormalizedBox): NormalizedBox {
  if (!a) return { ...b }
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  const x2 = Math.max(a.x + a.w, b.x + b.w)
  const y2 = Math.max(a.y + a.h, b.y + b.h)
  return { x, y, w: x2 - x, h: y2 - y }
}

function clampBox(b: NormalizedBox, padX = 0.02, padY = 0.02): NormalizedBox {
  const x = Math.max(-0.05, Math.min(1, b.x - padX))
  const y = Math.max(-0.05, Math.min(1, b.y - padY))
  const x2 = Math.max(x + 0.01, Math.min(1.05, b.x + b.w + padX))
  const y2 = Math.max(y + 0.01, Math.min(1.05, b.y + b.h + padY))
  return { x, y, w: x2 - x, h: y2 - y }
}

/**
 * 从部件包围盒推导默认命中区：每个部位取「命中关键词的所有部件」的并集。
 * 没有匹配部件的部位**直接不生成**（不做比例兜底，避免给出错误命中区）。
 */
export function buildTouchRegionsFromParts(parts: PartBox[]): TouchRegion[] {
  const out: TouchRegion[] = []
  for (const group of TOUCH_GROUPS) {
    let box: NormalizedBox | null = null
    for (const p of parts) {
      const name = (p.name || '').toLowerCase()
      if (!name) continue
      if (group.keywords.some((k) => name.includes(k.toLowerCase()))) box = unionBox(box, p)
    }
    if (!box) continue
    const clamped = clampBox(box)
    out.push({
      id: group.id,
      label: group.label,
      x: round(clamped.x),
      y: round(clamped.y),
      w: round(clamped.w),
      h: round(clamped.h),
      holdMs: 1800,
      lines: DEFAULT_LINES[group.id] ?? [],
    })
  }
  return out
}

/** 一键生成默认分区：按身高四等分，覆盖自动识别失败的情况 */
export function makeBandRegions(): TouchRegion[] {
  const bands: Array<{ id: string; label: string; y: number; h: number }> = [
    { id: 'head', label: '头', y: 0.0, h: 0.34 },
    { id: 'body', label: '身体', y: 0.34, h: 0.28 },
    { id: 'leg', label: '腿', y: 0.62, h: 0.28 },
    { id: 'foot', label: '脚', y: 0.9, h: 0.1 },
  ]
  return bands.map((b) => ({
    id: b.id,
    label: b.label,
    x: 0.12,
    y: b.y,
    w: 0.76,
    h: b.h,
    holdMs: 1800,
    lines: DEFAULT_LINES[b.id] ?? [],
  }))
}

/** 命中判定：返回面积最小的那个（脚画在腿上时，脚赢）。Live2D 与立绘区域共用 */
export function pickRegion<T extends { x: number; y: number; w: number; h: number }>(
  regions: readonly T[],
  u: number,
  v: number,
): T | null {
  let best: T | null = null
  for (const r of regions) {
    if (u < r.x || u > r.x + r.w || v < r.y || v > r.y + r.h) continue
    if (!best || r.w * r.h < best.w * best.h) best = r
  }
  return best
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}

/** 默认台词（只做起步用，用户可改；为空则只播动作/表情不出声） */
const DEFAULT_LINES: Record<string, string[]> = {
  head: ['呀…', '别摸头啦', '唔…'],
  body: ['痒…', '干嘛呀'],
  leg: ['别碰那里…', '喂！'],
  foot: ['别碰脚！', '哈哈…痒'],
}
