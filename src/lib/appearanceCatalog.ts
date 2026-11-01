/**
 * 「外观」目录构建：把模型里的 exp3 表情整理成可切换的开关 / 单选项。
 *
 * 设计取向（2026-10-30 与用户确认）：**不猜语义**。
 * 试过按表达式名做关键词分类（黑衬衫→装扮、麦克风→道具…），但不同作者命名习惯差异太大
 * （key1..key10 可以是任何东西，MouthNormalButton 这类自定义名完全没有语义），
 * "猜错"比"不猜"更让人困惑。所以这里只做**结构**判断：
 *
 *   1. **全零表达式**视为"关闭态"（例如 竖食指关 只把 Movement3 写回 0、默认体型 只写 Clothes2=0），
 *      不列为可选项——"不选"就等于关掉，省掉重复入口；
 *   2. **两个表达式写同一个参数但值不同** → 互斥，合并成一排单选
 *      （圈圈眼/爱心眼/＞＜/屑屑眼 都在写 key3~key6，天然是一组）；
 *   3. 其余各成一枚独立开关，统一放进第一组「开关」。
 *
 * 分组标题一律中性（「开关」「单选 1」「单选 2」…），命名权交给用户：
 * 标题右侧的 ⋯ 可以重命名 / 隐藏整组，chip 悬停可隐藏单项。
 */
import type { ExpressionMeta, ExpressionParameter, ModelAppearanceLayout } from '../types'

export interface AppearanceItem {
  /** 表达式名（= model3.json 里的 Name，也是 exp3 文件名去后缀） */
  name: string
  /** 该表达式触碰的参数 */
  params: ExpressionParameter[]
}

export interface AppearanceGroup {
  /** 稳定 id：开关组固定 'switch'，单选组按"组内表达式名排序拼接"，不随参数顺序漂移 */
  id: string
  title: string
  kind: 'switch' | 'radio'
  items: AppearanceItem[]
  /** 标题被用户改过 */
  customized?: boolean
}

/** 该表达式是否等价于"关闭"（所有参数都写 0） */
function isNoopExpression(expr: ExpressionMeta): boolean {
  if (expr.parameters.length === 0) return true
  return expr.parameters.every((p) => p.Value === 0)
}

/** 两个表达式是否互斥：写到了同一个参数但值不同 */
function conflicts(a: AppearanceItem, b: AppearanceItem): boolean {
  for (const pa of a.params) {
    const pb = b.params.find((p) => p.Id === pa.Id)
    if (pb && Math.abs(pb.Value - pa.Value) > 1e-6) return true
  }
  return false
}

/**
 * 构建外观目录。
 * @param expressions 该模型已注册的 exp3 列表（来自 model:expression-list）
 * @param layout 该模型的标题自定义 / 隐藏项
 * @returns 第一组恒为「开关」（独立项），之后是若干「单选 N」
 */
export function buildAppearanceCatalog(
  expressions: ExpressionMeta[],
  layout?: ModelAppearanceLayout,
): AppearanceGroup[] {
  const hiddenItems = new Set(layout?.hiddenItems ?? [])
  const hiddenGroups = new Set(layout?.hiddenGroups ?? [])
  const groupOverrides = layout?.groups ?? {}

  const items: AppearanceItem[] = expressions
    .filter((e) => !isNoopExpression(e) && !hiddenItems.has(e.name))
    .map((e) => ({ name: e.name, params: e.parameters }))

  // 并查集：互斥的项并到同一组
  const parent = items.map((_, i) => i)
  const find = (i: number): number => {
    const p = parent[i] ?? i
    return p === i ? i : (parent[i] = find(p))
  }
  const union = (i: number, j: number) => {
    const ri = find(i)
    const rj = find(j)
    if (ri !== rj) parent[rj] = ri
  }
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]
      const b = items[j]
      if (a && b && conflicts(a, b)) union(i, j)
    }
  }

  // 按首次出现顺序收集分组（保持 model3.json 里的顺序，结果可预期）
  const order: number[] = []
  const buckets = new Map<number, AppearanceItem[]>()
  items.forEach((item, i) => {
    const root = find(i)
    const list = buckets.get(root)
    if (list) {
      list.push(item)
    } else {
      buckets.set(root, [item])
      order.push(root)
    }
  })

  const singles: AppearanceItem[] = []
  const radios: AppearanceGroup[] = []
  for (const root of order) {
    const list = buckets.get(root) ?? []
    if (list.length === 1) {
      const only = list[0]
      if (only) singles.push(only)
    } else {
      const id = `radio:${list.map((i) => i.name).sort().join('|')}`
      radios.push({ id, title: '', kind: 'radio', items: list })
    }
  }

  const groups: AppearanceGroup[] = []
  if (singles.length > 0) {
    groups.push({ id: 'switch', title: '开关', kind: 'switch', items: singles })
  }
  // 单选组按出现顺序编号：单选 1 / 单选 2 …
  radios.forEach((radio, index) => {
    groups.push({ ...radio, title: `单选 ${index + 1}` })
  })

  // 套用用户覆盖（改标题）→ 剔除被隐藏的整组
  return groups
    .map((group) => {
      const customTitle = groupOverrides[group.id]?.title?.trim()
      return { ...group, title: customTitle || group.title, customized: !!customTitle }
    })
    .filter((g) => !hiddenGroups.has(g.id))
}

/** 折叠标题右侧的摘要：`已选 3 项` */
export function describeAppearance(selected: string[]): string {
  return selected.length > 0 ? `已选 ${selected.length} 项` : ''
}

/**
 * 合并「外观持久层」与「状态临时层」。
 *
 * 规则（2026-10-30 与用户确认）：
 *  - 同一互斥组内：状态优先（互斥即覆盖），外观对应的单选项随之显示为状态选中的那个；
 *  - 不同组 / 独立开关：取并集（状态脸红不会关掉外观的裙子切换）；
 *  - 状态表情不在目录里（未注册的 exp3）：仍然应用，只是 UI 无法标记。
 */
export function mergeAppearanceSelection(
  catalog: AppearanceGroup[],
  userSelected: string[],
  stateName: string | null,
): string[] {
  const out: string[] = []
  for (const group of catalog) {
    if (group.kind === 'radio') {
      if (stateName && group.items.some((i) => i.name === stateName)) {
        out.push(stateName)
        continue
      }
      const picked = group.items.find((i) => userSelected.includes(i.name))
      if (picked) out.push(picked.name)
    } else {
      for (const item of group.items) {
        if (userSelected.includes(item.name)) out.push(item.name)
      }
      if (stateName && !out.includes(stateName) && group.items.some((i) => i.name === stateName)) {
        out.push(stateName)
      }
    }
  }
  if (stateName && !out.includes(stateName) && !catalog.some((g) => g.items.some((i) => i.name === stateName))) {
    out.push(stateName)
  }
  return out
}
