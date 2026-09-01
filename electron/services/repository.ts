/**
 * 数据访问层 —— 三个窗口共享主进程中同一套数据读写逻辑，避免不一致。
 * 提供角色卡 / 记忆体 / 会话 / 模型 / 设置 的领域操作。
 * 所有变更通过 storage.mutateJson 在「每文件串行队列」内原子完成，避免并发丢更新。
 */
import { randomUUID } from 'crypto'
import type {
  AppSettings,
  CharacterCard,
  CharacterCardInput,
  CharacterPersona,
  CharacterSprite,
  ChatMessage,
  Live2DModelMeta,
  MemoryItem,
  ModelSettings,
  SessionDetail,
  SessionIndexItem,
} from '../../src/types'
import { CHARACTER_CARD_VERSION } from '../../src/types'
import { paths, readJson, writeJson, mutateJson, deleteFile, fileExists } from './storage'

export function genId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

/**
 * 校验资源 ID 是否为系统生成的合法格式。
 * 会话/模型 ID 会拼入文件路径，必须校验，防止渲染进程构造路径穿越 ID（如 ../../secure/apiKey）。
 */
export function assertValidResourceId(id: string, kind: 'session' | 'model' | 'sprite' | 'card' | 'mem'): void {
  if (typeof id !== 'string' || !new RegExp(`^${kind}_[0-9a-f]{12}$`).test(id)) {
    throw new Error('非法资源 ID')
  }
}

// ---------------- 角色卡 ----------------

const DEFAULT_CARDS: CharacterCard[] = []

/** 空人设（所有子字段默认空串/空数组），用于归一化缺失数据 */
const EMPTY_PERSONA: CharacterPersona = {
  anchor: '',
  inner: { desire: '', fear: '', conflict: '', selfView: '' },
  perception: { attention: '', emotion: '', worldview: '' },
  relation: { approach: '', intimacy: '', boundary: '', need: '' },
  you: { identity: '', bond: '', stance: '', memories: [] },
  language: { rhythm: '', words: '', neverSay: [], habits: '' },
  state: { daily: '', triggers: '', situations: '' },
  worldview: [],
  prohibitions: [],
  extra: '',
}

/** 归一化人设：用空结构补全缺失字段，保证旧数据/部分写入的数据结构完整 */
function normalizePersona(raw?: Partial<CharacterPersona> | null): CharacterPersona {
  const p: Partial<CharacterPersona> = raw ?? {}
  return {
    anchor: p.anchor ?? '',
    inner: {
      desire: p.inner?.desire ?? '',
      fear: p.inner?.fear ?? '',
      conflict: p.inner?.conflict ?? '',
      selfView: p.inner?.selfView ?? '',
    },
    perception: {
      attention: p.perception?.attention ?? '',
      emotion: p.perception?.emotion ?? '',
      worldview: p.perception?.worldview ?? '',
    },
    relation: {
      approach: p.relation?.approach ?? '',
      intimacy: p.relation?.intimacy ?? '',
      boundary: p.relation?.boundary ?? '',
      need: p.relation?.need ?? '',
    },
    you: {
      identity: p.you?.identity ?? '',
      bond: p.you?.bond ?? '',
      stance: p.you?.stance ?? '',
      memories: p.you?.memories ?? [],
    },
    language: {
      rhythm: p.language?.rhythm ?? '',
      words: p.language?.words ?? '',
      neverSay: p.language?.neverSay ?? [],
      habits: p.language?.habits ?? '',
    },
    state: {
      daily: p.state?.daily ?? '',
      triggers: p.state?.triggers ?? '',
      situations: p.state?.situations ?? '',
    },
    worldview: p.worldview ?? [],
    prohibitions: p.prohibitions ?? [],
    extra: p.extra ?? '',
  }
}

/**
 * 归一化角色卡：补全缺失字段，保证旧数据/部分写入的数据结构完整。
 * 新版结构废弃了 description/personality/scenario，改用 CharacterPersona（动漫角色复刻结构）。
 */
function normalizeCard(raw: Partial<CharacterCard>): CharacterCard {
  const now = Date.now()
  return {
    id: raw.id ?? genId('card'),
    name: raw.name ?? '未命名角色',
    version: raw.version ?? CHARACTER_CARD_VERSION,
    persona: normalizePersona(raw.persona),
    messageExample: raw.messageExample ?? '',
    modelId: raw.modelId ?? null,
    voiceId: raw.voiceId ?? null,
    ttsOverride: raw.ttsOverride ?? null,
    modelOverride: raw.modelOverride ?? null,
    // 形象呈现（2D 立绘）；旧卡缺省 → Live2D 模式、未绑立绘
    renderMode: raw.renderMode ?? null,
    spriteId: raw.spriteId ?? null,
    emotionMap: raw.emotionMap ?? null,
    live2dExpressionMap: raw.live2dExpressionMap ?? null,
    avatar: raw.avatar ?? null,
    createdAt: raw.createdAt ?? now,
    updatedAt: raw.updatedAt ?? now,
  }
}

export async function listCharacterCards(): Promise<CharacterCard[]> {
  const cards = await readJson<Partial<CharacterCard>[]>(paths.characterCardsFile, DEFAULT_CARDS)
  return cards.map(normalizeCard).sort((a, b) => b.createdAt - a.createdAt)
}

export async function getCharacterCard(id: string): Promise<CharacterCard | null> {
  const cards = await listCharacterCards()
  return cards.find((c) => c.id === id) ?? null
}

export async function createCharacterCard(input: CharacterCardInput): Promise<CharacterCard> {
  const now = Date.now()
  const card: CharacterCard = {
    id: genId('card'),
    version: CHARACTER_CARD_VERSION,
    name: input.name.trim() || '未命名角色',
    persona: normalizePersona(input.persona),
    messageExample: input.messageExample ?? '',
    modelId: input.modelId || null,
    voiceId: input.voiceId || null,
    ttsOverride: input.ttsOverride ?? null,
    modelOverride: input.modelOverride ?? null,
    renderMode: input.renderMode ?? null,
    spriteId: input.spriteId || null,
    emotionMap: input.emotionMap ?? null,
    live2dExpressionMap: input.live2dExpressionMap ?? null,
    avatar: input.avatar ?? null,
    createdAt: now,
    updatedAt: now,
  }
  await mutateJson(paths.characterCardsFile, DEFAULT_CARDS, (cards) => [card, ...cards])
  return card
}

export async function updateCharacterCard(id: string, patch: Partial<CharacterCardInput>): Promise<void> {
  await mutateJson(paths.characterCardsFile, DEFAULT_CARDS, (cards) => {
    let found = false
    const next = cards.map((c) => {
      if (c.id !== id) return c
      found = true
      return { ...c, ...patch, updatedAt: Date.now() }
    })
    if (!found) throw new Error('角色卡不存在')
    return next
  })
}

export async function removeCharacterCard(id: string): Promise<void> {
  await mutateJson(paths.characterCardsFile, DEFAULT_CARDS, (cards) => cards.filter((c) => c.id !== id))
}

// ---------------- 记忆体 ----------------

const DEFAULT_MEMORIES: MemoryItem[] = []

export async function listMemories(): Promise<MemoryItem[]> {
  return readJson<MemoryItem[]>(paths.memoryFile, DEFAULT_MEMORIES)
}

export async function addMemory(content: string): Promise<MemoryItem> {
  const text = content.trim()
  if (!text) throw new Error('记忆内容不能为空')
  const item: MemoryItem = { id: genId('mem'), content: text, createdAt: Date.now() }
  await mutateJson(paths.memoryFile, DEFAULT_MEMORIES, (items) => [item, ...items])
  return item
}

export async function updateMemory(id: string, content: string): Promise<void> {
  const text = content.trim()
  if (!text) throw new Error('记忆内容不能为空')
  await mutateJson(paths.memoryFile, DEFAULT_MEMORIES, (items) => {
    let found = false
    const next = items.map((m) => {
      if (m.id !== id) return m
      found = true
      return { ...m, content: text }
    })
    if (!found) throw new Error('记忆条目不存在')
    return next
  })
}

export async function removeMemory(id: string): Promise<void> {
  await mutateJson(paths.memoryFile, DEFAULT_MEMORIES, (items) => items.filter((m) => m.id !== id))
}

/**
 * 分段组装 system prompt（借鉴 airi resolveSystemPrompt）。
 * 把 人设结构（CharacterPersona）/ 示例对话 / 长期记忆 按顺序 join。
 *
 * 记忆/规则的增强处理（提高模型遵从度）：
 * 1. 前置：记忆置于 system prompt 开头，而非排在末尾（长 prompt 中后段指令遵从度更低）。
 * 2. 强约束标题：用「必须记住并严格遵守」这类独立 section 头，让 LLM 把它当硬规则而非普通句子。
 * 3. 措辞建议：记忆内容尽量写成肯定句（「回复中不出现 emoji」优于「不要发 emoji」），
 *    LLM 对「做什么」的遵从远高于「不做什么」。此处仅负责注入结构，不改写内容。
 * @param card 角色卡（取人设字段）
 * @param memories 全局记忆体
 */
/** 情绪演出指令段：约束 AI 输出结构化 JSON dialogue 数组（每项必带 emotion），供解析驱动桌宠形象按节拍切换立绘 */
export const EMOTION_PROMPT = `【输出格式（最高优先，绝对不可违背）】
你的【整条回复都必须且只能是】一个 JSON 对象，除此之外【一个字都不能多输出】——
不要任何解释、序号、问候、开场白、后记，也不要 markdown 代码块包裹，直接输出 JSON 本体。

必须返回的结构（严格照抄，键名一致）：
{"dialogue":[
  {"text":"台词或描写，可含（括号动作/心理）","emotion":"标准情绪"},
  {"text":"……","emotion":"标准情绪"}
]}

硬性规定：
- 只有一个顶层键 "dialogue"，它是数组，通常 2~6 项，每项是一个情绪/语义节奏。
- 每一项必须同时有 "text" 与 "emotion" 两个字段，缺一不可。"emotion" 不得缺省。
- "emotion" 只能取下列 6 个之一：
  neutral(平静) / happy(开心) / sad(难过) / angry(生气) / surprised(惊讶) / shy(害羞)
  匹配不到时：担心/紧张→sad，亲近/撒娇→happy。
- 心理活动、动作、环境、第三人称旁白等"不发声"的内容，必须写进 "text" 的（）内；台词与旁白可各占一项。
- 情绪转折就另起一项写对应 emotion；同情绪连续的多项会被系统自动合并，不会重复切换。
- 即使你想输出问候、解释或额外旁白，也都只能放进 "text"，绝不允许出现在 JSON 之外。

示例（你唯一允许的输出形态，前后无任何多余字符）：
{"dialogue":[
  {"text":"……你终于来了。","emotion":"shy"},
  {"text":"（心跳漏了一拍，站在原地）","emotion":"neutral"},
  {"text":"我等了好久，还以为你不来了……","emotion":"sad"},
  {"text":"不过、现在看到你，就都好了。","emotion":"happy"}
]}`

export function buildSystemPrompt(card: CharacterCard | null, memories: MemoryItem[]): string {
  const parts: string[] = []
  if (memories.length > 0) {
    const memLines = memories.map((m, i) => `${i + 1}. ${m.content}`).join('\n')
    parts.push(`## 用户长期记忆（必须记住并严格遵守）\n${memLines}`)
  }
  // 输出格式约束提到最前面，确保"只输出 JSON"不被后续散文示例带偏
  parts.push(EMOTION_PROMPT)
  parts.push(...buildPersonaSections(card?.persona))
  if (card?.messageExample?.trim()) {
    parts.push(`【示例对话】（下面示例是散文，仅用于参考角色的语气与分寸；你的回复仍必须严格按上方【输出格式】仅输出 JSON）\n${card.messageExample.trim()}`)
  }
  parts.push(PARAGRAPH_PROMPT)
  parts.push(NARRATION_PROMPT)
  return parts.join('\n\n')
}

/**
 * 段落组织规范：约束 AI 用空行把回复分成若干语义段落，避免一段到底、缺乏呼吸感。
 * 每段落一个小节拍，段间留空行，让阅读（气泡）与语音逐句推进都更清晰。
 */
export const PARAGRAPH_PROMPT = `【节拍/分段规范（作用于上方 JSON 的 "text" 字段内部）】
- 把回复拆成 "dialogue" 数组里的若干 "text" 项：每句台词、或整段心理/动作/环境描写都作为独立一项，按先后排列，让阅读与语音逐条推进更清晰。
- 情绪有起伏就用不同项并写对应 emotion；台词与（括号旁白）可各自成为一项。
- text 内部如需细分节奏或留呼吸感，可用换行自然成段，但主要分段以 dialogue 的每一项为界（通常 2~6 项）。
参考节奏（下面每一项各自成为 dialogue 里的一项 text）：
（心跳好像突然停了一拍）

真、真的吗……

（慢慢转过头对上他的眼睛，声音带着一点颤抖）

我…我一直以为，你只是把我当成普通的青梅竹马……

所以…我们现在算是在一起了吗？

（问完这句话，整张脸埋进毯子里，只露出一双眼睛偷偷看他）

今晚的星星，我一辈子都不会忘记。`

/**
 * 演出/旁白规范：约束 AI 把心理活动、动作、环境等"可不可说出口"的内容统一放进圆括号。
 * 语音只朗读括号外的台词；括号内容供屏幕阅读/视觉表达，绝不朗读。
 * 强调"未括起来的整句都算台词"，并把常见反例写进去（含用户遇到的"心理独白未括"）。
 */
export const NARRATION_PROMPT = `【演出/旁白规范（作用于上方 JSON 的 "text" 字段内部）】
严格区分"台词"与"不可说出口"的内容：
- 台词：角色真正说出的话，不裹任何括号。
- 心理活动、内心独白、动作描写、环境/氛围描写、第三人称旁白：必须用圆括号（）完整包裹。
规则：
- 一个描述性句子即使是"心理感受/内心活动"，只要它不发出声音，就必须整句放进圆括号，例如：
  （心跳声大得好像整条路都能听见） 正确
  心跳声大得好像整条路都能听见   错误（会被误读）
  （虽然嘴上在找借口，但手指却悄悄收紧了） 正确
  虽然嘴上在找借口，但手指却悄悄收紧了   错误（会被误读）
- 括号内容仅供阅读与演出，绝不朗读；你的"台词"应简短、口语，是真正能用嘴唇说出来的话。
- 每项 "text" 的 "emotion" 字段即该节拍的立绘/表情；情绪转折时另起一项并写对应 emotion。`

/**
 * 将人设结构转换为按优先级排序的 system prompt 文本段。
 * 顺序（遵从度从高到低）：存在锚点 → 内心结构 → 感知方式 → 关系模式 → 语言质感 →
 * 状态系统 → 世界观碎片 → 禁止项 → 自由补充。
 * 只注入非空字段，避免 system prompt 因空白段膨胀。
 */
export function buildPersonaSections(persona?: Partial<CharacterPersona> | null): string[] {
  if (!persona) return []
  const parts: string[] = []

  if (persona.anchor?.trim()) parts.push(`【存在锚点】\n${persona.anchor.trim()}`)

  const inner: string[] = []
  if (persona.inner?.desire?.trim()) inner.push(`核心渴望：${persona.inner.desire.trim()}`)
  if (persona.inner?.fear?.trim()) inner.push(`内在恐惧：${persona.inner.fear.trim()}`)
  if (persona.inner?.conflict?.trim()) inner.push(`核心矛盾：${persona.inner.conflict.trim()}`)
  if (persona.inner?.selfView?.trim()) inner.push(`自我认知状态：${persona.inner.selfView.trim()}`)
  if (inner.length > 0) parts.push(`【内心结构】\n${inner.join('\n')}`)

  const perception: string[] = []
  if (persona.perception?.attention?.trim()) perception.push(`注意什么：${persona.perception.attention.trim()}`)
  if (persona.perception?.emotion?.trim()) perception.push(`情绪处理机制：${persona.perception.emotion.trim()}`)
  if (persona.perception?.worldview?.trim()) perception.push(`对外部世界的态度：${persona.perception.worldview.trim()}`)
  if (perception.length > 0) parts.push(`【感知方式】\n${perception.join('\n')}`)

  const relation: string[] = []
  if (persona.relation?.approach?.trim()) relation.push(`靠近人的方式：${persona.relation.approach.trim()}`)
  if (persona.relation?.intimacy?.trim()) relation.push(`亲密建立的节奏：${persona.relation.intimacy.trim()}`)
  if (persona.relation?.boundary?.trim()) relation.push(`她/他的边界：${persona.relation.boundary.trim()}`)
  if (persona.relation?.need?.trim()) relation.push(`对"被需要"的态度：${persona.relation.need.trim()}`)
  if (relation.length > 0) parts.push(`【关系模式】\n${relation.join('\n')}`)

  const you: string[] = []
  if (persona.you?.identity?.trim()) you.push(`你是谁：${persona.you.identity.trim()}`)
  if (persona.you?.bond?.trim()) you.push(`你们之间的关系：${persona.you.bond.trim()}`)
  if (persona.you?.stance?.trim()) you.push(`AI 角色怎么看你：${persona.you.stance.trim()}`)
  const memories = (persona.you?.memories ?? []).filter((s) => s.trim())
  if (memories.length > 0) you.push(`特殊约定或记忆：\n${memories.map((s) => `- ${s.trim()}`).join('\n')}`)
  if (you.length > 0) parts.push(`【你的身份】\n${you.join('\n')}`)

  const language: string[] = []
  if (persona.language?.rhythm?.trim()) language.push(`说话节奏：${persona.language.rhythm.trim()}`)
  if (persona.language?.words?.trim()) language.push(`用词特征：${persona.language.words.trim()}`)
  const neverSay = (persona.language?.neverSay ?? []).filter((s) => s.trim())
  if (neverSay.length > 0) language.push(`绝不会说出口的（出戏表达）：\n${neverSay.map((s) => `- ${s.trim()}`).join('\n')}`)
  if (persona.language?.habits?.trim()) language.push(`特殊语言行为：${persona.language.habits.trim()}`)
  if (language.length > 0) parts.push(`【语言质感】\n${language.join('\n')}`)

  const state: string[] = []
  if (persona.state?.daily?.trim()) state.push(`日常状态：${persona.state.daily.trim()}`)
  if (persona.state?.triggers?.trim()) state.push(`触发变化的开关：\n${persona.state.triggers.trim()}`)
  if (persona.state?.situations?.trim()) state.push(`不同情境下的状态变化：\n${persona.state.situations.trim()}`)
  if (state.length > 0) parts.push(`【状态系统】\n${state.join('\n')}`)

  const worldview = (persona.worldview ?? []).filter((s) => s.trim())
  if (worldview.length > 0) parts.push(`【世界观碎片】\n${worldview.map((s) => `- ${s.trim()}`).join('\n')}`)

  const prohibitions = (persona.prohibitions ?? []).filter((s) => s.trim())
  if (prohibitions.length > 0) {
    parts.push(`【禁止项（必须严格遵守，最高优先级）】\n${prohibitions.map((s) => `- ${s.trim()}`).join('\n')}`)
  }

  if (persona.extra?.trim()) parts.push(`【补充设定】\n${persona.extra.trim()}`)

  return parts
}

// ---------------- 会话 ----------------

const DEFAULT_SESSION_INDEX: SessionIndexItem[] = []

export async function listSessions(): Promise<SessionIndexItem[]> {
  const list = await readJson<SessionIndexItem[]>(paths.sessionsIndexFile, DEFAULT_SESSION_INDEX)
  return list.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getSession(id: string): Promise<SessionDetail> {
  assertValidResourceId(id, 'session')
  const data = await readJson<SessionDetail | null>(paths.sessionFile(id), null)
  if (data) return data
  // 文件缺失：尝试从索引恢复基本信息，返回空会话
  const index = await listSessions()
  const entry = index.find((s) => s.id === id)
  return { id, characterCardId: entry?.characterCardId ?? '', messages: [] }
}

/** 清理历史遗留的空会话（从未发送过消息），避免空会话在 Data 面板堆积 */
export async function pruneEmptySessions(): Promise<void> {
  const index = await readJson<SessionIndexItem[]>(paths.sessionsIndexFile, DEFAULT_SESSION_INDEX)
  const empties = index.filter((s) => s.messageCount === 0)
  if (empties.length === 0) return
  await mutateJson(paths.sessionsIndexFile, DEFAULT_SESSION_INDEX, (list) =>
    list.filter((s) => s.messageCount !== 0),
  )
  await Promise.all(empties.map((s) => deleteFile(paths.sessionFile(s.id))))
}

export async function createSession(characterCardId: string): Promise<SessionIndexItem> {
  assertValidResourceId(characterCardId, 'card')
  const card = await getCharacterCard(characterCardId)
  // 惰性创建：每次新建前先清理遗留空会话（含历史数据）
  await pruneEmptySessions()
  const now = Date.now()
  const item: SessionIndexItem = {
    id: genId('session'),
    title: '新会话',
    characterCardId,
    characterCardName: card?.name ?? '未命名角色',
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
  }
  await mutateJson(paths.sessionsIndexFile, DEFAULT_SESSION_INDEX, (index) => [item, ...index])

  // 新会话初始为空消息列表（已废弃角色卡开场白自动注入）
  const detail: SessionDetail = { id: item.id, characterCardId, messages: [] }
  await writeJson(paths.sessionFile(item.id), detail)
  return item
}

/** 根据首条用户消息自动生成标题（前 20 字） */
export function deriveTitle(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === 'user')
  if (!first) return '新会话'
  const t = first.content.trim().replace(/\s+/g, ' ')
  return t.slice(0, 20) || '新会话'
}

export async function appendSessionMessages(id: string, extra: ChatMessage[]): Promise<SessionDetail> {
  assertValidResourceId(id, 'session')
  const session = await mutateJson<SessionDetail | null>(paths.sessionFile(id), null, (cur) => {
    const base = cur ?? { id, characterCardId: '', messages: [] }
    return { ...base, messages: [...base.messages, ...extra] }
  })

  // 更新索引（title / messageCount / updatedAt）
  const detail = session as SessionDetail
  const card = await getCharacterCard(detail.characterCardId)
  await mutateJson(paths.sessionsIndexFile, DEFAULT_SESSION_INDEX, (index) => {
    const idx = index.findIndex((s) => s.id === id)
    if (idx === -1) return index
    const existing = index[idx] as SessionIndexItem
    const next: SessionIndexItem = {
      ...existing,
      title: existing.title === '新会话' ? deriveTitle(detail.messages) : existing.title,
      characterCardName: card?.name ?? existing.characterCardName,
      messageCount: detail.messages.length,
      updatedAt: Date.now(),
    }
    index[idx] = next
    return index
  })
  return detail
}

export async function removeSession(id: string): Promise<void> {
  assertValidResourceId(id, 'session')
  await mutateJson(paths.sessionsIndexFile, DEFAULT_SESSION_INDEX, (index) => index.filter((s) => s.id !== id))
  await deleteFile(paths.sessionFile(id))
}

/** 修改会话标题（不更新 updatedAt，避免重命名打乱列表排序） */
export async function renameSession(id: string, title: string): Promise<void> {
  assertValidResourceId(id, 'session')
  const t = title.trim()
  if (!t) throw new Error('标题不能为空')
  await mutateJson(paths.sessionsIndexFile, DEFAULT_SESSION_INDEX, (index) => {
    let found = false
    const next = index.map((s) => {
      if (s.id !== id) return s
      found = true
      return { ...s, title: t }
    })
    if (!found) throw new Error('会话不存在')
    return next
  })
}

// ---------------- Live2D 模型 ----------------

const DEFAULT_MODELS: Live2DModelMeta[] = []

export async function listModels(): Promise<Live2DModelMeta[]> {
  return readJson<Live2DModelMeta[]>(paths.modelsIndexFile, DEFAULT_MODELS)
}

export async function addModel(meta: Live2DModelMeta): Promise<Live2DModelMeta> {
  await mutateJson(paths.modelsIndexFile, DEFAULT_MODELS, (list) => [meta, ...list])
  return meta
}

export async function removeModel(modelId: string): Promise<void> {
  assertValidResourceId(modelId, 'model')
  await mutateJson(paths.modelsIndexFile, DEFAULT_MODELS, (list) => list.filter((m) => m.id !== modelId))
  // 递归删除模型目录（可能含子目录/纹理）
  await deleteFile(paths.modelDir(modelId))
  // 角色卡若绑定该模型，解除绑定
  await mutateJson(paths.characterCardsFile, DEFAULT_CARDS, (cards) =>
    cards.map((c) => (c.modelId === modelId ? { ...c, modelId: null, updatedAt: Date.now() } : c)),
  )
}

// ---------------- 2D 立绘 ----------------

const DEFAULT_SPRITES: CharacterSprite[] = []

export async function listSprites(): Promise<CharacterSprite[]> {
  return readJson<CharacterSprite[]>(paths.spritesIndexFile, DEFAULT_SPRITES)
}

export async function addSprite(meta: CharacterSprite): Promise<CharacterSprite> {
  await mutateJson(paths.spritesIndexFile, DEFAULT_SPRITES, (list) => [meta, ...list])
  return meta
}

export async function removeSprite(spriteId: string): Promise<void> {
  assertValidResourceId(spriteId, 'sprite')
  await mutateJson(paths.spritesIndexFile, DEFAULT_SPRITES, (list) => list.filter((s) => s.id !== spriteId))
  // 递归删除立绘资源目录
  await deleteFile(paths.spriteDir(spriteId))
}

/** 更新立绘集的展示资产：情绪→立绘图映射 / 说话立绘 / 思考立绘 */
export async function updateSprite(
  spriteId: string,
  patch: Partial<Pick<CharacterSprite, 'emotionMap' | 'speakingImage' | 'thinkingImage'>>,
): Promise<void> {
  assertValidResourceId(spriteId, 'sprite')
  await mutateJson(paths.spritesIndexFile, DEFAULT_SPRITES, (list) =>
    list.map((s) => (s.id === spriteId ? { ...s, ...patch } : s)),
  )
}

// ---------------- 设置 ----------------

const DEFAULT_SETTINGS: AppSettings = {
  baseURL: '',
  model: '',
  temperature: 0.8,
  maxTokens: 1024,
  stream: true,
  theme: 'dark',
}

export async function getSettings(): Promise<AppSettings> {
  const saved = await readJson<Partial<AppSettings> | null>(paths.settingsFile, null)
  return { ...DEFAULT_SETTINGS, ...(saved ?? {}) }
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const result = await mutateJson<Partial<AppSettings> | null>(paths.settingsFile, null, (current) => {
    const base = current ?? {}
    const next: Partial<AppSettings> = { ...base }
    // 仅合并白名单字段，避免污染
    if (patch.baseURL !== undefined) next.baseURL = patch.baseURL
    if (patch.model !== undefined) next.model = patch.model
    if (patch.temperature !== undefined) next.temperature = patch.temperature
    if (patch.maxTokens !== undefined) next.maxTokens = patch.maxTokens
    if (patch.stream !== undefined) next.stream = patch.stream
    if (patch.theme !== undefined) next.theme = patch.theme
    return next
  })
  return { ...DEFAULT_SETTINGS, ...result }
}

/** Cubism Core 是否已就绪 */
export async function isCorePresent(): Promise<boolean> {
  return fileExists(paths.coreFile)
}

// ---------------- 模型设置 ----------------

/** 模型设置默认值（与前端 DEFAULT_MODEL_SETTINGS 保持一致） */
const DEFAULT_MODEL_SETTINGS: ModelSettings = {
  parameters: {
    angleX: 0, angleY: 0, angleZ: 0,
    leftEyeOpen: 1, rightEyeOpen: 1, leftEyeSmile: 0,
    leftEyebrowLR: 0, rightEyebrowLR: 0,
    leftEyebrowY: 0, rightEyebrowY: 0,
    leftEyebrowAngle: 0, rightEyebrowAngle: 0,
    leftEyebrowForm: 0, rightEyebrowForm: 0,
    mouthOpen: 0, mouthForm: 0,
    cheek: 0,
    bodyAngleX: 0, bodyAngleY: 0, bodyAngleZ: 0,
    breath: 0,
  },
  animation: {
    mouseTracking: true,
    eyeOffsetX: 0, eyeOffsetY: 0,
    idleEyeMovement: true,
    enableBlink: true,
    blinkMode: 'force',
    idleAnimation: '',
    renderScale: 2,
    maxFps: 0,
    dropShadow: true,
    expressionEnabled: false,
    selectedExpression: '',
  },
  view: { scale: 1, x: 0, y: 0 },
  selectedModelId: null,
  selectedSpriteId: null,
}

/** 读取模型设置，缺失字段用默认值补全 */
export async function getModelSettings(): Promise<ModelSettings> {
  const saved = await readJson<Partial<ModelSettings> | null>(paths.modelSettingsFile, null)
  if (!saved) return DEFAULT_MODEL_SETTINGS
  return {
    parameters: { ...DEFAULT_MODEL_SETTINGS.parameters, ...(saved.parameters ?? {}) },
    animation: { ...DEFAULT_MODEL_SETTINGS.animation, ...(saved.animation ?? {}) },
    view: { ...DEFAULT_MODEL_SETTINGS.view, ...(saved.view ?? {}) },
    selectedModelId: saved.selectedModelId ?? DEFAULT_MODEL_SETTINGS.selectedModelId,
    selectedSpriteId: saved.selectedSpriteId ?? DEFAULT_MODEL_SETTINGS.selectedSpriteId,
  }
}

/** 深度合并保存模型设置（部分更新） */
export async function saveModelSettings(patch: Partial<ModelSettings>): Promise<ModelSettings> {
  const result = await mutateJson<Partial<ModelSettings> | null>(paths.modelSettingsFile, null, (current) => {
    const base = current ?? {}
    const next: Partial<ModelSettings> = { ...base }
    if (patch.parameters) next.parameters = { ...(base.parameters ?? {}), ...patch.parameters }
    if (patch.animation) next.animation = { ...(base.animation ?? {}), ...patch.animation }
    if (patch.view) next.view = { ...(base.view ?? {}), ...patch.view }
    if (patch.selectedModelId !== undefined) next.selectedModelId = patch.selectedModelId
    if (patch.selectedSpriteId !== undefined) next.selectedSpriteId = patch.selectedSpriteId
    return next
  })
  return {
    parameters: { ...DEFAULT_MODEL_SETTINGS.parameters, ...(result?.parameters ?? {}) },
    animation: { ...DEFAULT_MODEL_SETTINGS.animation, ...(result?.animation ?? {}) },
    view: { ...DEFAULT_MODEL_SETTINGS.view, ...(result?.view ?? {}) },
    selectedModelId: result?.selectedModelId ?? DEFAULT_MODEL_SETTINGS.selectedModelId,
    selectedSpriteId: result?.selectedSpriteId ?? DEFAULT_MODEL_SETTINGS.selectedSpriteId,
  }
}