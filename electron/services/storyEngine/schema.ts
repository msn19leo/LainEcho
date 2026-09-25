/**
 * 剧本 schema 校验（纯函数，零 Electron 依赖）。
 *
 * 一期 12 种事件（源自 LingChat schema 裁剪）：background / music / modify_character /
 * narration / player / dialogue / ai_dialogue / free_dialogue / choices / input / set_var / chapter_end。
 * 导入时全量校验并逐条报出（文件 + 原因），不抛异常——错误集中返回供 UI 展示。
 *
 * 注：设计文档原计划用 zod；为避免新增依赖改为手写校验器，产出物（校验报告结构）不变。
 * 条件求值器支持：裸变量真值 / == / != / >= / <= / > / <，以及 &&（全部满足）/ ||（任一满足）组合——
 * 吸取 LingChat "hp >= 5 静默恒假"的教训，凡无法解析的条件一律导入期明确报错，绝不静默跳过。
 */
import type {
  ScriptChapterDef,
  ScriptMeta,
  StandardEmotion,
  StoryAction,
  StoryAiJudge,
  StoryChapterBranch,
  StoryCondition,
  StoryConditionClause,
  StoryEvent,
} from '../../../src/types'

export const STANDARD_EMOTIONS = ['neutral', 'happy', 'sad', 'angry', 'surprised', 'shy'] as const

/** 校验错误（file = 剧本包内相对路径） */
export interface SchemaIssue {
  file: string
  message: string
}

/** 单个文件的校验结果 */
export interface SchemaResult<T> {
  value: T | null
  errors: SchemaIssue[]
}

const EVENT_TYPES = [
  'background', 'music', 'modify_character', 'narration', 'player', 'dialogue',
  'ai_dialogue', 'free_dialogue', 'choices', 'input', 'set_var', 'chapter_end',
] as const

type Unknown = Record<string, unknown>

function isObj(v: unknown): v is Unknown {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null
}

/** 校验 emotion 字段（必须是 6 标准情绪之一；缺省合法） */
function checkEmotion(raw: Unknown, file: string, index: number, errors: SchemaIssue[], field = 'emotion'): void {
  const v = raw[field]
  if (v === undefined) return
  if (typeof v === 'string' && (STANDARD_EMOTIONS as readonly string[]).includes(v)) return
  errors.push({
    file,
    message: `事件 #${index + 1}：${field} 必须是 ${STANDARD_EMOTIONS.join(' / ')} 之一，实际为「${String(v)}」`,
  })
}

/** condition 子句支持的全部比较运算符 */
const CONDITION_OPS = ['==', '!=', '>=', '<=', '>', '<'] as const
type ConditionOp = (typeof CONDITION_OPS)[number]

/** 解析子句值字面量：true/false → 布尔，数字 → number，其余 → 字符串 */
function parseConditionValue(raw: string): number | string | boolean {
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (raw !== '' && !Number.isNaN(Number(raw))) return Number(raw)
  return raw
}

/** 解析单个子句字符串："name"（裸真值）或 "name op value" */
function parseConditionClauseText(text: string): StoryConditionClause | null {
  // 运算符按长度优先匹配（>= / <= 先于 > / <），避免 "a >= 1" 被拆成 "a" + "> = 1"
  for (const op of CONDITION_OPS) {
    const idx = text.indexOf(op)
    if (idx > 0) {
      const name = text.slice(0, idx).trim()
      const valueRaw = text.slice(idx + op.length).trim()
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !valueRaw) return null
      return { var: name, op, value: parseConditionValue(valueRaw) }
    }
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) return { var: text }
  return null
}

/**
 * 校验 condition 字段。支持三种写法：
 *  1. 字符串："metBefore"、"closeness >= 3"、"a >= 1 && b == true"（&& / || 组合，不可混用）；
 *  2. 子句对象：{var, op?, value?}；
 *  3. 组合对象：{mode: 'all'|'any', clauses: [子句...]}。
 */
function checkCondition(raw: Unknown, file: string, index: number, errors: SchemaIssue[], prefixOverride?: string): StoryCondition | null {
  const prefix = prefixOverride ?? `事件 #${index + 1}：condition`
  const c = raw['condition']
  if (c === undefined) return null

  // ---- 字符串形式 ----
  if (typeof c === 'string') {
    const trimmed = c.trim()
    if (!trimmed) return null
    const hasAnd = trimmed.includes('&&')
    const hasOr = trimmed.includes('||')
    if (hasAnd && hasOr) {
      errors.push({ file, message: `${prefix}「${trimmed}」不能混用 && 与 ||（可拆成组合对象 {mode, clauses}）` })
      return null
    }
    const parts = (hasAnd ? trimmed.split('&&') : trimmed.split('||')).map((p) => p.trim()).filter(Boolean)
    if (parts.length === 0) {
      errors.push({ file, message: `${prefix} 格式无法解析：「${trimmed}」` })
      return null
    }
    const clauses: StoryConditionClause[] = []
    let bad = false
    for (const p of parts) {
      const clause = parseConditionClauseText(p)
      if (!clause) {
        errors.push({ file, message: `${prefix} 子句「${p}」无法解析（需为 "变量名" 或 "变量名 ==/!=/>=/<=/>/< 值"）` })
        bad = true
        continue
      }
      clauses.push(clause)
    }
    if (bad || clauses.length === 0) return null
    if (clauses.length === 1) return clauses[0]!
    return hasAnd ? { mode: 'all', clauses } : { mode: 'any', clauses }
  }

  // ---- 对象形式 ----
  if (isObj(c)) {
    // 组合对象：{mode, clauses}
    if (c['clauses'] !== undefined || c['mode'] !== undefined) {
      const mode = c['mode'] ?? 'all'
      if (mode !== 'all' && mode !== 'any') {
        errors.push({ file, message: `${prefix}.mode 只支持 all（全部满足）/ any（任一满足），实际为「${String(mode)}」` })
        return null
      }
      const rawClauses = c['clauses']
      if (!Array.isArray(rawClauses) || rawClauses.length === 0) {
        errors.push({ file, message: `${prefix}.clauses 必须是非空数组` })
        return null
      }
      const clauses: StoryConditionClause[] = []
      let bad = false
      rawClauses.forEach((rc, i) => {
        const clause = checkClauseObject(rc, `${prefix}.clauses[${i}]`, file, errors)
        if (clause) clauses.push(clause)
        else bad = true
      })
      if (bad || clauses.length === 0) return null
      return { mode, clauses }
    }
    const clause = checkClauseObject(c, prefix, file, errors)
    return clause
  }

  errors.push({ file, message: `${prefix} 需为字符串或 {var, op?, value?} / {mode, clauses} 对象` })
  return null
}

/** 校验单个子句对象 {var, op?, value?} */
function checkClauseObject(c: unknown, prefix: string, file: string, errors: SchemaIssue[]): StoryConditionClause | null {
  if (!isObj(c) || !asString(c['var'])) {
    errors.push({ file, message: `${prefix} 需为 {var, op?, value?} 对象（var 为变量名）` })
    return null
  }
  const op = c['op']
  if (op !== undefined && !(CONDITION_OPS as readonly string[]).includes(String(op))) {
    // LingChat 教训：不认识的运算符会静默恒假，必须导入期报错
    errors.push({
      file,
      message: `${prefix}.op 仅支持 ${CONDITION_OPS.join(' / ')}，实际为「${String(op)}」`,
    })
    return null
  }
  return {
    var: String(c['var']),
    op: op as ConditionOp | undefined,
    value: c['value'] as number | string | boolean | undefined,
  }
}

/** 校验 actions 数组（choices 选项 / input 事件） */
function checkActions(raw: Unknown, file: string, index: number, errors: SchemaIssue[]): StoryAction[] | undefined {
  const actions = raw['actions']
  if (actions === undefined) return undefined
  if (!Array.isArray(actions)) {
    errors.push({ file, message: `事件 #${index + 1}：actions 必须是数组` })
    return undefined
  }
  const out: StoryAction[] = []
  actions.forEach((a, i) => {
    if (!isObj(a) || (a['type'] !== 'set_var' && a['type'] !== 'add_line')) {
      errors.push({ file, message: `事件 #${index + 1} actions[${i}]：type 必须是 set_var / add_line` })
      return
    }
    if (a['type'] === 'set_var') {
      if (!asString(a['name'])) {
        errors.push({ file, message: `事件 #${index + 1} actions[${i}]：set_var 缺少 name` })
        return
      }
      if (a['value'] === undefined) {
        errors.push({ file, message: `事件 #${index + 1} actions[${i}]：set_var 缺少 value` })
        return
      }
      const op = a['op'] ?? '='
      if (op !== '=' && op !== '+=' && op !== '-=') {
        errors.push({ file, message: `事件 #${index + 1} actions[${i}]：set_var.op 仅支持 = / += / -=` })
        return
      }
      out.push({ type: 'set_var', name: String(a['name']), op, value: a['value'] as number | string | boolean })
      return
    }
    if (!asString(a['content'])) {
      errors.push({ file, message: `事件 #${index + 1} actions[${i}]：add_line 缺少 content` })
      return
    }
    out.push({ type: 'add_line', content: String(a['content']) })
  })
  return out.length > 0 ? out : undefined
}

/** 校验单个事件 */
export function validateEvent(raw: unknown, file: string, index: number, errors: SchemaIssue[]): StoryEvent | null {
  if (!isObj(raw) || typeof raw['type'] !== 'string') {
    errors.push({ file, message: `事件 #${index + 1}：缺少 type 字段` })
    return null
  }
  const type = raw['type']
  if (!(EVENT_TYPES as readonly string[]).includes(type)) {
    errors.push({ file, message: `事件 #${index + 1}：未知事件类型「${type}」（一期支持：${EVENT_TYPES.join(' / ')}）` })
    return null
  }
  const cond = checkCondition(raw, file, index, errors)
  const ev = { ...raw, condition: cond ?? undefined } as Unknown

  let out: StoryEvent | null
  switch (type) {
    case 'background': {
      if (!asString(ev['image'])) {
        errors.push({ file, message: `事件 #${index + 1}（background）：缺少 image` })
        return null
      }
      const duration = ev['duration']
      if (duration !== undefined && typeof duration !== 'number') {
        errors.push({ file, message: `事件 #${index + 1}（background）：duration 必须是数字（秒）` })
        return null
      }
      out = { type, image: String(ev['image']), duration: duration as number | undefined }
      break
    }
    case 'music': {
      const file2 = asString(ev['file'])
      const stop = ev['stop'] === true
      if (!file2 && !stop) {
        errors.push({ file, message: `事件 #${index + 1}（music）：需要 file 或 stop: true` })
        return null
      }
      out = { type, file: file2 ?? undefined, loop: ev['loop'] === true, stop: stop || undefined }
      break
    }
    case 'modify_character': {
      if (!asString(ev['emotion'])) {
        errors.push({ file, message: `事件 #${index + 1}（modify_character）：缺少 emotion` })
        return null
      }
      checkEmotion(ev, file, index, errors)
      out = { type, emotion: String(ev['emotion']) as StoryEvent extends never ? never : import('../../../src/types').StandardEmotion }
      break
    }
    case 'narration':
    case 'player': {
      if (!asString(ev['text'])) {
        errors.push({ file, message: `事件 #${index + 1}（${type}）：缺少 text` })
        return null
      }
      out = { type, text: String(ev['text']) } as StoryEvent
      break
    }
    case 'dialogue': {
      if (!asString(ev['text'])) {
        errors.push({ file, message: `事件 #${index + 1}（dialogue）：缺少 text` })
        return null
      }
      checkEmotion(ev, file, index, errors)
      out = {
        type,
        character: asString(ev['character']) ?? undefined,
        text: String(ev['text']),
        emotion: typeof ev['emotion'] === 'string' ? (ev['emotion'] as StandardEmotion) : undefined,
      }
      break
    }
    case 'ai_dialogue': {
      if (!asString(ev['prompt'])) {
        errors.push({ file, message: `事件 #${index + 1}（ai_dialogue）：缺少 prompt（导演指令）` })
        return null
      }
      out = { type, prompt: String(ev['prompt']) }
      break
    }
    case 'free_dialogue': {
      const maxRounds = ev['maxRounds']
      if (maxRounds !== undefined && (typeof maxRounds !== 'number' || maxRounds < 1)) {
        errors.push({ file, message: `事件 #${index + 1}（free_dialogue）：maxRounds 必须是 ≥1 的数字` })
        return null
      }
      out = {
        type,
        maxRounds: (typeof maxRounds === 'number' ? maxRounds : 3),
        endHint: asString(ev['endHint']) ?? undefined,
      }
      break
    }
    case 'choices': {
      const options = ev['options']
      if (!Array.isArray(options) || options.length === 0) {
        errors.push({ file, message: `事件 #${index + 1}（choices）：options 必须是非空数组` })
        return null
      }
      const opts: Array<{ text: string; actions?: StoryAction[] }> = []
      options.forEach((o, i) => {
        if (!isObj(o) || !asString(o['text'])) {
          errors.push({ file, message: `事件 #${index + 1}（choices）：options[${i}] 缺少 text` })
          return
        }
        opts.push({ text: String(o['text']), actions: checkActions(o, file, index, errors) })
      })
      if (opts.length === 0) return null
      out = { type, options: opts, allowFree: ev['allowFree'] === true }
      break
    }
    case 'input':
      out = { type, actions: checkActions(ev, file, index, errors) }
      break
    case 'set_var': {
      if (!asString(ev['name'])) {
        errors.push({ file, message: `事件 #${index + 1}（set_var）：缺少 name` })
        return null
      }
      if (ev['value'] === undefined) {
        errors.push({ file, message: `事件 #${index + 1}（set_var）：缺少 value` })
        return null
      }
      const op = ev['op'] ?? '='
      if (op !== '=' && op !== '+=' && op !== '-=') {
        errors.push({ file, message: `事件 #${index + 1}（set_var）：op 仅支持 = / += / -=` })
        return null
      }
      out = { type, name: String(ev['name']), op, value: ev['value'] as number | string | boolean }
      break
    }
    case 'chapter_end': {
      const next = asString(ev['nextChapter'])
      // 分支表：按序求值，首个 when 满足者生效；均不满足走 nextChapter（缺省完结）
      let branches: StoryChapterBranch[] | undefined
      const rawBranches = ev['branches']
      if (rawBranches !== undefined) {
        if (!Array.isArray(rawBranches) || rawBranches.length === 0) {
          errors.push({ file, message: `事件 #${index + 1}（chapter_end）：branches 必须是非空数组` })
        } else {
          branches = []
          rawBranches.forEach((b, i) => {
            if (!isObj(b) || !asString(b['nextChapter'])) {
              errors.push({ file, message: `事件 #${index + 1}（chapter_end）：branches[${i}] 缺少 nextChapter` })
              return
            }
            const when = checkCondition({ condition: b['when'] }, file, index, errors)
            if (!when) {
              errors.push({ file, message: `事件 #${index + 1}（chapter_end）：branches[${i}].when 缺失或无法解析` })
              return
            }
            branches!.push({ when, nextChapter: String(b['nextChapter']) })
          })
          if (branches.length === 0) branches = undefined
        }
      }
      // AI 判定分支：章末由 LLM 依据整局对话表现选一个选项跳转
      let aiJudge: StoryAiJudge | undefined
      const rawJudge = ev['aiJudge']
      if (rawJudge !== undefined) {
        if (!isObj(rawJudge)) {
          errors.push({ file, message: `事件 #${index + 1}（chapter_end）：aiJudge 必须是对象` })
        } else if (!asString(rawJudge['prompt'])) {
          errors.push({ file, message: `事件 #${index + 1}（chapter_end）：aiJudge 缺少 prompt（判定提示词）` })
        } else if (!Array.isArray(rawJudge['options']) || rawJudge['options'].length === 0) {
          errors.push({ file, message: `事件 #${index + 1}（chapter_end）：aiJudge.options 必须是非空数组` })
        } else {
          const options: StoryAiJudge['options'] = []
          ;(rawJudge['options'] as unknown[]).forEach((o, i) => {
            if (!isObj(o) || !asString(o['id']) || !asString(o['nextChapter'])) {
              errors.push({ file, message: `事件 #${index + 1}（chapter_end）：aiJudge.options[${i}] 需含 id / label / nextChapter` })
              return
            }
            options.push({
              id: String(o['id']),
              label: asString(o['label']) ?? String(o['id']),
              nextChapter: String(o['nextChapter']),
            })
          })
          if (options.length > 0) {
            aiJudge = { prompt: String(rawJudge['prompt']), varName: asString(rawJudge['varName']) ?? undefined, options }
          }
        }
      }
      out = { type, nextChapter: next ?? undefined, branches, aiJudge }
      break
    }
    default:
      return null
  }
  // 归一化事件必须携带归一化后的 condition（修复：此前 switch 直接 return 导致条件在导入后丢失、
  // 运行期 evalCondition 永远拿不到 condition，"不满足则跳过"从未生效）
  return { ...out, condition: cond ?? undefined } as StoryEvent
}

/** 校验 story.yaml 元信息 */
export function validateMeta(raw: unknown, file: string): SchemaResult<ScriptMeta> {
  const errors: SchemaIssue[] = []
  if (!isObj(raw)) {
    return { value: null, errors: [{ file, message: 'story.yaml 内容必须是 YAML 映射' }] }
  }
  const id = asString(raw['id'])
  if (!id || !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(id)) {
    errors.push({ file, message: `id 必须是 2-64 位的小写字母/数字/连字符/下划线，实际为「${String(raw['id'])}」` })
  }
  const title = asString(raw['title'])
  if (!title) errors.push({ file, message: '缺少 title（剧本名）' })
  const startChapter = asString(raw['startChapter'])
  if (!startChapter) errors.push({ file, message: '缺少 startChapter（起始章节文件名，不含 .yaml 后缀）' })
  const version = raw['version'] ?? 1
  if (typeof version !== 'number') errors.push({ file, message: 'version 必须是数字' })
  let characterCardId: string | null = null
  const chars = raw['characters']
  if (chars !== undefined) {
    if (Array.isArray(chars)) {
      const first = chars[0]
      if (isObj(first) && asString(first['cardId'])) characterCardId = String(first['cardId'])
    } else {
      errors.push({ file, message: 'characters 必须是数组（一期单角色）' })
    }
  }
  if (errors.length > 0) return { value: null, errors }
  return {
    value: {
      id: id!,
      title: title!,
      summary: asString(raw['summary']) ?? undefined,
      cover: asString(raw['cover']) ?? undefined,
      characters: characterCardId ? [{ cardId: characterCardId }] : undefined,
      startChapter: startChapter!,
      version: typeof version === 'number' ? version : 1,
    },
    errors,
  }
}

/** 校验章节文件（chapters/*.yaml） */
export function validateChapter(raw: unknown, file: string): SchemaResult<ScriptChapterDef> {
  const errors: SchemaIssue[] = []
  if (!isObj(raw)) {
    return { value: null, errors: [{ file, message: '章节内容必须是 YAML 映射' }] }
  }
  const name = asString(raw['name']) ?? file.split('/').pop() ?? '未命名章节'
  const eventsRaw = raw['events']
  if (!Array.isArray(eventsRaw)) {
    return { value: null, errors: [{ file, message: '缺少 events 数组' }] }
  }
  const events: StoryEvent[] = []
  eventsRaw.forEach((e, i) => {
    const ev = validateEvent(e, file, i, errors)
    if (ev) events.push(ev)
  })
  // 章节级进入条件（7.5）：复用事件条件模型，报错前缀用「章节 enterWhen」区分于事件 condition
  let enterWhen: StoryCondition | undefined
  if (raw['enterWhen'] !== undefined) {
    const c = checkCondition({ condition: raw['enterWhen'] }, file, 0, errors, '章节 enterWhen')
    if (c) enterWhen = c
  }
  const fallbackChapter = asString(raw['fallbackChapter']) ?? undefined
  return { value: { name, events, enterWhen, fallbackChapter }, errors }
}
