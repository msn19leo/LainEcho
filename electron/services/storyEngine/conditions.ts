/**
 * 剧本条件求值器（纯函数，零 Electron 依赖；引擎运行期使用）。
 *
 * 支持：子句（裸变量真值 / == / != / >= / <= / > / <）与 all（全部满足）/ any（任一满足）组合。
 * LingChat "hp >= 5 静默恒假"教训的运行期防线：数值比较遇到非数值时恒为 false，
 * 但必须留下警告日志（schema 导入期校验已尽量拦截，此处兜底变量在运行期才出现的场景）。
 */
import type { StoryCondition, StoryConditionClause, StoryConditionGroup } from '../../../src/types'

/** 宽松相等：目标值为数字按 Number 比较，布尔按真假比较，其余严格相等 */
function looseEqual(actual: unknown, expected: unknown): boolean {
  if (typeof expected === 'number') return Number(actual) === expected
  if (typeof expected === 'boolean') return Boolean(actual) === expected
  return actual === expected
}

/** 条件子句求值：裸变量真值 / == / != / >= / <= / > / <（数值优先，非数值比较恒为 false 并警告） */
function evalClause(clause: StoryConditionClause, vars: Record<string, unknown>): boolean {
  const v = vars[clause.var]
  const op = clause.op
  if (op === '==' || op === '!=') {
    const equal = looseEqual(v, clause.value)
    return op === '==' ? equal : !equal
  }
  if (op === '>=' || op === '<=' || op === '>' || op === '<') {
    const a = typeof v === 'number' ? v : Number(v)
    const b = typeof clause.value === 'number' ? clause.value : Number(clause.value)
    if (Number.isNaN(a) || Number.isNaN(b)) {
      console.warn('[story] 数值比较遇到非数值（恒为 false）：%s %s %j（当前值 %j）', clause.var, op, clause.value, v)
      return false
    }
    if (op === '>=') return a >= b
    if (op === '<=') return a <= b
    if (op === '>') return a > b
    return a < b
  }
  return Boolean(v)
}

/** 条件求值：子句或 all/any 组合（schema 导入期保证 clauses 非空） */
export function evalCondition(cond: StoryCondition, vars: Record<string, unknown>): boolean {
  if ('clauses' in cond && Array.isArray(cond.clauses)) {
    const group = cond as StoryConditionGroup
    const results = group.clauses.map((c) => evalClause(c, vars))
    return group.mode === 'any' ? results.some(Boolean) : results.every(Boolean)
  }
  return evalClause(cond as StoryConditionClause, vars)
}
