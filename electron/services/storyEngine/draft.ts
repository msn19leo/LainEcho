/**
 * AI 辅助写剧本（设计文档 7.4）：复用角色卡 ai-generate 的成熟模式——
 * IPC 生成 → 草稿回显给用户审阅编辑（不直接入库）→ schema 校验通过后手动导入剧本库。
 *
 * 草稿为单文件 YAML（元信息 + chapters 内联，每个章节带 file 标识供 chapter_end 引用）；
 * 导入时按 file 拆分为 story.yaml + chapters/<file>.yaml，走 schema 全量校验。
 */
import { promises as fs } from 'fs'
import path from 'path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { CharacterCard, StoryEvent, StoryImportReport } from '../../../src/types'
import { sendChatCompletion } from '../aiClient'
import { readApiKey } from '../crypto'
import { getCharacterCard, getSettings } from '../repository'
import { paths } from '../storage'
import { validateChapter, validateMeta, type SchemaIssue } from './schema'

/** 草稿章节结构（file = 章节文件标识，导入后成为 chapters/<file>.yaml） */
interface DraftChapter {
  file: string
  name?: string
  events?: unknown[]
}

/** 剥离思考块与 markdown 代码围栏，取出纯 YAML 正文 */
function stripToFenceFreeYaml(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '')
    .replace(/^\s*```(?:ya?ml)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim()
}

/**
 * 修复 LLM 最常见的行内紧凑映射笔误：`- type: music, file: bgm.mp3, loop: true`
 * （YAML 报错 "Nested mappings are not allowed in compact mappings"）→ 重写为块状（每个键独占一行）。
 * 切分只在引号外的逗号处进行，且逗号后必须紧跟 `key:` 形态——值内的一般逗号不受影响。
 */
function normalizeCompactMappings(draft: string): string {
  const out: string[] = []
  for (const line of draft.split('\n')) {
    const m = /^(\s*-\s+)([A-Za-z_][A-Za-z0-9_]*:\s*)(.*)$/.exec(line)
    if (!m) {
      out.push(line)
      continue
    }
    const parts = splitCompactParts(m[3]!)
    if (parts.length <= 1) {
      out.push(line)
      continue
    }
    const base = m[1]!.replace(/-\s+$/, '') // 首键续行对齐（"- " 占两列）
    out.push(`${m[1]}${m[2]}${parts[0]}`)
    for (const p of parts.slice(1)) out.push(`${base}  ${p}`)
  }
  return out.join('\n')
}

/** 在引号外的逗号处切分紧凑映射值；切分点后必须紧跟 key: 形态，否则该逗号属于值本身 */
function splitCompactParts(text: string): string[] {
  const parts: string[] = []
  let cur = ''
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i)
    if (quote) {
      cur += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
      continue
    }
    if (ch === ',' && /^[A-Za-z_][A-Za-z0-9_]*:(?:\s|$)/.test(text.slice(i + 1).trimStart())) {
      parts.push(cur.trim())
      cur = ''
      while (i + 1 < text.length && /\s/.test(text.charAt(i + 1))) i++ // 吞掉逗号后空白
      continue
    }
    cur += ch
  }
  parts.push(cur.trim())
  return parts.filter((p) => p.length > 0)
}

/** 修复章节漏写 name 键：`- file: chXX` 的下一行是更深缩进的裸文本（本应是章节名）时补成 `name: 裸文本` */
function normalizeChapterName(draft: string): string {
  const lines = draft.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    out.push(line)
    const m = /^(\s*-\s+)file:\s*(\S.*)$/.exec(line)
    if (!m) continue
    const next = lines[i + 1]
    if (next === undefined) continue
    // 裸文本 = 有缩进、无 `- ` 前缀、整行不含 `key:` 结构（name:/events: 等带冒号的行不受影响）
    const nm = /^(\s+)([^:\s-][^:]*)$/.exec(next)
    const dashIndent = m[1]!.length - m[1]!.trimStart().length
    if (nm && nm[1]!.length > dashIndent) {
      out.push(`${nm[1]}name: ${nm[2]!.trim()}`)
      i++
    }
  }
  return out.join('\n')
}

/** 标准 6 情绪（与 schema STANDARD_EMOTIONS 一致） */
const STANDARD_EMOTIONS = ['neutral', 'happy', 'sad', 'angry', 'surprised', 'shy'] as const
type StandardEmotion = (typeof STANDARD_EMOTIONS)[number]

/** LLM 常见的非标准情绪写法 → 标准情绪（修复管线用；先精确匹配，未命中再按关键词猜测，兜底 neutral） */
const EMOTION_ALIASES: Record<string, StandardEmotion> = {
  // happy（含"喜极而泣"类复合词）
  smile: 'happy', smiling: 'happy', laugh: 'happy', laughing: 'happy', giggle: 'happy', joy: 'happy', joyful: 'happy',
  glad: 'happy', cheerful: 'happy', excited: 'happy', excitedly: 'happy', warm: 'happy', gentle: 'happy', softly: 'happy',
  tender: 'happy', moved: 'happy', touched: 'happy', relieved: 'happy', sweet: 'happy', crying_happy: 'happy',
  happy_crying: 'happy', tearful_smile: 'happy', happy_tears: 'happy',
  // sad
  cry: 'sad', crying: 'sad', tears: 'sad', tearful: 'sad', upset: 'sad', down: 'sad', blue: 'sad', lonely: 'sad',
  depressed: 'sad', gloomy: 'sad', sorrow: 'sad', sorrowful: 'sad', hurt: 'sad', disappointed: 'sad',
  // angry
  mad: 'angry', furious: 'angry', annoyed: 'angry', pouty: 'angry', grumpy: 'angry',
  // surprised
  shock: 'surprised', shocked: 'surprised', startled: 'surprised', astonished: 'surprised', amazed: 'surprised', wow: 'surprised',
  // shy
  blush: 'shy', blushing: 'shy', embarrassed: 'shy', bashful: 'shy', flustered: 'shy',
  // neutral
  calm: 'neutral', serious: 'neutral', blank: 'neutral', normal: 'neutral', none: 'neutral', flat: 'neutral', default: 'neutral',
}

/** 关键词猜测（别名表未命中时）：复合词按意图优先级匹配（如 crying_happy 归 happy） */
function guessEmotion(raw: string): StandardEmotion {
  const s = raw.toLowerCase()
  if (/happy|smile|laugh|joy|glad|warm|moved|touch/.test(s)) return 'happy'
  if (/sad|cry|tear|sorrow|down|blue|lonely/.test(s)) return 'sad'
  if (/angry|mad|furious|annoy|pout/.test(s)) return 'angry'
  if (/surpris|shock|startl|amaz/.test(s)) return 'surprised'
  if (/shy|blush|embarrass|fluster/.test(s)) return 'shy'
  return 'neutral'
}

/** 修复非标准 emotion 值（LLM 常自创 crying_happy / smile 等）→ 归一化到标准 6 情绪 */
function normalizeEmotions(draft: string): string {
  const out: string[] = []
  for (const line of draft.split('\n')) {
    const m = /^(\s*emotion:\s*)(.+?)\s*$/.exec(line)
    if (!m) {
      out.push(line)
      continue
    }
    const raw = m[2]!.replace(/^["']|["']$/g, '').trim()
    if ((STANDARD_EMOTIONS as readonly string[]).includes(raw)) {
      out.push(line)
      continue
    }
    const mapped = EMOTION_ALIASES[raw.toLowerCase()] ?? guessEmotion(raw)
    out.push(`${m[1]}"${mapped}"`)
    console.warn('[story] 草稿 emotion 修复：「%s」→「%s」', raw, mapped)
  }
  return out.join('\n')
}

/** 草稿修复管线：行内紧凑映射 → 章节缺 name → 非标准 emotion（生成物常见笔误，先修再校验） */
export function normalizeDraftYaml(draft: string): string {
  return normalizeEmotions(normalizeChapterName(normalizeCompactMappings(draft)))
}

/** 压缩角色卡人设为生成提示词可用的简介（存在字段才输出） */
function describeCard(card: CharacterCard): string {
  const p = card.persona
  const lines: string[] = [`角色名：${card.name}`]
  if (p?.anchor?.trim()) lines.push(`存在锚点：${p.anchor.trim()}`)
  if (p?.inner?.desire?.trim()) lines.push(`核心渴望：${p.inner.desire.trim()}`)
  if (p?.inner?.fear?.trim()) lines.push(`内在恐惧：${p.inner.fear.trim()}`)
  if (p?.relation?.approach?.trim()) lines.push(`靠近人的方式：${p.relation.approach.trim()}`)
  if (p?.you?.identity?.trim()) lines.push(`与对话者的关系：${p.you.identity.trim()}`)
  if (p?.you?.bond?.trim()) lines.push(`关系背景：${p.you.bond.trim()}`)
  if (p?.language?.rhythm?.trim()) lines.push(`说话节奏：${p.language.rhythm.trim()}`)
  if (p?.language?.words?.trim()) lines.push(`用词特征：${p.language.words.trim()}`)
  if (p?.state?.daily?.trim()) lines.push(`日常状态：${p.state.daily.trim()}`)
  return lines.join('\n')
}

/** 组装生成提示词（事件 schema 全部以块状示例钉版——行内紧凑写法是非法 YAML，严禁模仿） */
function buildGeneratePrompt(premise: string, card: CharacterCard | null): string {
  const cardBlock = card ? `\n【参考角色】\n剧本主角按下面的角色卡人设编写（台词风格与关系背景要贴合）：\n${describeCard(card)}\n` : ''
  return `你是 galgame 剧本作者。为 LainEcho 剧情演出系统撰写一部完整的短篇剧本，输出一个 YAML 文档。
${cardBlock}
【创作梗概】
${premise}

【硬性格式（违反任何一条都会被拒绝）】
1. 只输出 YAML 本体：不要 markdown 代码块、不要任何解释或后记。
2. 顶层键：id（2-64 位小写字母/数字/连字符，如 starlight-night）、title（剧本名）、summary（一句话简介）、chapters（数组，2~4 章）。
3. 每个 chapter 必须恰好包含 file / name / events 三个键，缺一不可：
   - file: ch01        （章节标识，形如 ch01 / ch02，全剧本唯一）
     name: 章节名       （章节的中文名，必须写在 name: 后面）
     events:            （事件数组，按演出顺序）
4. 【最重要】每个事件、每个选项的每个键必须各自独占一行（块状写法）。绝对禁止把多个键值对挤在一行里用逗号分隔——
   非法：- type: music, file: bgm.mp3, loop: true
   合法：
   - type: music
     file: bgm.mp3
     loop: true
5. text / prompt / summary 的值里如果出现英文冒号加空格，必须给整个值加英文双引号。
6. emotion 字段只能取六个标准情绪之一：neutral / happy / sad / angry / surprised / shy。
   禁止自创情绪词（如 crying_happy、smile、excited 都是非法的）；想表达"喜极而泣"用 happy 加括号描写。

【事件类型（只能用以下 12 种；所有事件都可带 condition: "条件"）】
- type: background
  image: bg_school.webp
- type: music
  file: bgm_daily.mp3
  loop: true
- type: music
  stop: true
- type: modify_character
  emotion: happy
- type: narration
  text: 旁白文本（无语音，铺氛围）
- type: player
  text: 玩家独白（不调 AI）
- type: dialogue
  character: MAIN
  text: 预设台词
  emotion: shy
- type: ai_dialogue
  prompt: 导演指令（角色自由回复）
- type: free_dialogue
  maxRounds: 2
  endHint: 自由轮结束时的收尾旁白
- type: choices
  options:
    - text: 选项一
      actions:
        - type: set_var
          name: closeness
          op: +=
          value: 1
    - text: 选项二
- type: input
- type: set_var
  name: closeness
  op: "="
  value: 0
- type: chapter_end
  nextChapter: ch02

【chapter_end 分支结局（可选）】
按序求值，首个满足条件的分支生效；都不满足走 nextChapter；两者都缺省 = 完结：
- type: chapter_end
  nextChapter: ch02
  branches:
    - when: closeness >= 2
      nextChapter: ch03
    - when: metBefore == true
      nextChapter: ch04

【condition 条件写法（不要用其他写法）】
"变量名"（真值）/ "变量名 == 值" / "变量名 != 值" / "变量名 >= 数字" / "变量名 <= 数字" / "变量名 > 数字" / "变量名 < 数字"，
可用 && （全部满足）或 ||（任一满足）组合，如 "closeness >= 3 && metBefore"。&& 与 || 不可混用。

【写作要求】
- 节奏：每章 6~14 个事件；narration 铺垫氛围 → dialogue/ai_dialogue 推进对话 → choices/free_dialogue 制造参与感。
- 台词要短、口语、符合角色；旁白克制；（括号）内容表示动作心理。
- 数值变量（如 closeness）在前面 set_var 初始化，choices 里用 += 增减，章末按数值分支结局。

现在输出 YAML：`
}

/** 生成结果：草稿文本 + 校验报告（同 StoryImportReport 结构） */
export interface DraftGenerateResult {
  ok: boolean
  draft?: string
  errors: Array<{ file: string; message: string }>
  error?: string
}

/**
 * 生成剧本草稿：梗概（+可选参考角色卡）→ LLM 非流式产出 → 回传草稿文本。
 * 生成即做 schema 校验并把报告一并返回（草稿可编辑后重新导入再校验）。
 */
export async function generateStoryDraft(params: { premise: string; cardId?: string | null }): Promise<DraftGenerateResult> {
  const premise = params.premise?.trim() ?? ''
  if (!premise) return { ok: false, errors: [{ file: '', message: '请先填写剧本梗概' }] }
  try {
    const settings = await getSettings()
    const apiKey = await readApiKey()
    if (!apiKey) return { ok: false, errors: [], error: '未配置 API Key，请先在「设置 → AI API 配置」中填写' }
    const card = params.cardId ? await getCharacterCard(params.cardId).catch(() => null) : null
    const raw = await sendChatCompletion(
      [
        { role: 'system', content: '你是资深的 galgame 剧本作者，严格按用户给出的格式契约输出 YAML 剧本，不输出任何多余内容。' },
        { role: 'user', content: buildGeneratePrompt(premise, card) },
      ],
      {
        model: settings.model,
        baseURL: settings.baseURL,
        apiKey,
        temperature: 0.8,
        stream: false,
        // 整部剧本 YAML 一次产出：给足输出预算（思考型模型的 reasoning 同样计入）
        maxTokensOverride: Math.max(settings.maxTokens ?? 0, 8192),
      },
    )
    const draft = normalizeDraftYaml(stripToFenceFreeYaml(raw))
    if (!draft) return { ok: false, errors: [], error: '模型返回为空，请调整梗概后重试' }
    // 生成即校验：错误随草稿一并回显（用户可编辑修正后再导入）
    const errors = validateDraft(draft)
    return { ok: true, draft, errors }
  } catch (err) {
    console.warn('[story] 剧本草稿生成失败：', err instanceof Error ? err.message : err)
    return { ok: false, errors: [], error: err instanceof Error ? err.message : String(err) }
  }
}

/** 校验草稿：元信息 + 逐章 schema + 章节引用完整性（file 唯一 / nextChapter 可达） */
export function validateDraft(draft: string): Array<{ file: string; message: string }> {
  let raw: unknown
  try {
    raw = parseYaml(draft)
  } catch (err) {
    return [{ file: '草稿', message: `YAML 解析失败：${err instanceof Error ? err.message : String(err)}` }]
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return [{ file: '草稿', message: '草稿必须是 YAML 映射' }]
  }
  const obj = raw as Record<string, unknown>
  const errors: SchemaIssue[] = []

  const chaptersRaw = obj['chapters']
  if (!Array.isArray(chaptersRaw) || chaptersRaw.length === 0) {
    return [{ file: '草稿', message: '缺少 chapters 数组（至少 1 章）' }]
  }
  const chapters: DraftChapter[] = []
  chaptersRaw.forEach((c, i) => {
    if (typeof c !== 'object' || c === null || Array.isArray(c)) {
      errors.push({ file: `chapters[${i}]`, message: '章节必须是映射（file / name / events）' })
      return
    }
    const file = String((c as Record<string, unknown>)['file'] ?? '').trim()
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(file)) {
      errors.push({ file: `chapters[${i}]`, message: `章节缺少合法的 file 标识（小写字母/数字/连字符，如 ch01），实际为「${file}」` })
      return
    }
    chapters.push(c as DraftChapter)
  })
  const files = new Set(chapters.map((c) => c.file!))
  if (files.size !== chapters.length) {
    errors.push({ file: '草稿', message: '章节 file 标识重复' })
  }

  // 元信息：startChapter = 第一章（导入规则，与设计文档「顺序演出」一致）
  const metaRaw = { ...obj, startChapter: chapters[0]?.file, version: 1 }
  const metaResult = validateMeta(metaRaw, 'story.yaml')
  errors.push(...metaResult.errors)

  // 逐章 schema 校验
  const normalizedChapters: Array<{ file: string; events: StoryEvent[] }> = []
  for (const c of chapters) {
    const result = validateChapter({ name: c.name, events: c.events }, `chapters/${c.file}`)
    errors.push(...result.errors)
    if (result.value) normalizedChapters.push({ file: c.file!, events: result.value.events })
  }

  // 章节引用完整性：chapter_end 的 nextChapter / branches / aiJudge 必须指向已声明的章节
  for (const ch of normalizedChapters) {
    for (const ev of ch.events) {
      if (ev.type !== 'chapter_end') continue
      const targets = [
        ev.nextChapter,
        ...(ev.branches ?? []).map((b) => b.nextChapter),
        ...(ev.aiJudge?.options ?? []).map((o) => o.nextChapter),
      ].filter((t): t is string => typeof t === 'string' && t.length > 0)
      for (const t of targets) {
        if (!files.has(t)) {
          errors.push({ file: `chapters/${ch.file}`, message: `chapter_end 引用了不存在的章节「${t}」（可用章节：${[...files].join('、')}）` })
        }
      }
    }
  }

  // 按（文件, 原因）去重，避免同类错误刷屏
  const seen = new Set<string>()
  return errors.filter((e) => {
    const key = `${e.file}|${e.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * 导入草稿：修复常见笔误（紧凑映射/缺章节名）→ 全量校验 → 拆分写入 data/stories/<id>/
 * （story.yaml + chapters/<file>.yaml）。同 id 剧本已存在时拒绝（防 AI 重跑误覆盖已有剧本）。
 */
export async function importStoryDraft(draft: string): Promise<{ ok: boolean; scriptId?: string; errors: Array<{ file: string; message: string }>; error?: string }> {
  const normalized = normalizeDraftYaml(draft)
  const errors = validateDraft(normalized)
  if (errors.length > 0) return { ok: false, errors }
  let raw: ReturnType<typeof parseYaml>
  raw = parseYaml(normalized) as ReturnType<typeof parseYaml>
  const obj = raw as Record<string, unknown>
  const id = String(obj['id'])
  const chapters = (obj['chapters'] as unknown[]).map((c) => c as Record<string, unknown>)
  const startChapter = String(chapters[0]!['file'])

  const dest = path.join(paths.storiesDir, id)
  if (await fs.access(dest).then(() => true, () => false)) {
    return { ok: false, errors: [], error: `剧本「${id}」已存在，请修改草稿 id 后重试（或先删除旧剧本）` }
  }

  const metaYaml = stringifyYaml({ id, title: obj['title'], summary: obj['summary'], startChapter, version: 1 })
  await fs.mkdir(path.join(dest, 'chapters'), { recursive: true })
  await fs.writeFile(path.join(dest, 'story.yaml'), metaYaml, 'utf-8')
  for (const ch of chapters) {
    // file 名合法性已由 validateDraft 保证（^[a-z0-9][a-z0-9_-]{0,63}$），直接拼接安全
    const body = { name: ch['name'], events: ch['events'] }
    await fs.writeFile(path.join(dest, 'chapters', `${ch['file']}.yaml`), stringifyYaml(body), 'utf-8')
  }
  console.log('[story] AI 草稿已导入：%s（%s，%d 章）', id, obj['title'], chapters.length)
  return { ok: true, scriptId: id, errors: [] }
}

/** 报告结构对齐（供 IPC 层复用类型） */
export type DraftImportReport = StoryImportReport & { scriptId?: string }
