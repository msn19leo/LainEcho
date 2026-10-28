/**
 * 数据访问层 —— 三个窗口共享主进程中同一套数据读写逻辑，避免不一致。
 * 提供角色卡 / 记忆体 / 会话 / 模型 / 设置 的领域操作。
 * 所有变更通过 storage.mutateJson 在「每文件串行队列」内原子完成，避免并发丢更新。
 */
import { randomUUID } from 'crypto'
import type {
  ApiProfile,
  AppSettings,
  CharacterCard,
  CharacterCardInput,
  CharacterPersona,
  ChatMessage,
  EmotionPaletteRef,
  Live2DModelMeta,
  MemoryCategory,
  MemoryItem,
  ModelPalette,
  ModelSettings,
  SessionDetail,
  SessionIndexItem,
  TTSModelCard,
  TTSModelCardInput,
  VisionSettings,
} from '../../src/types'
import { CHARACTER_CARD_VERSION, BUILTIN_DEFAULT_EMOTION, BUILTIN_DEFAULT_GLOSS, builtinPalette, paletteFromSprite } from '../../src/types'
import type { CharacterSprite, SpritePaletteEntry } from '../../src/types'
import { removeSessionImages } from './chatImages'
import { paths, readJson, writeJson, mutateJson, deleteFile, fileExists } from './storage'
import { buildSystemParts } from './prompt/sections'
import { composeSystemPrompt } from './prompt/composer'

// 提示词段落符号已平移至 services/prompt/（纯函数模块），此处保留旧引用路径的导出
export { PARAGRAPH_PROMPT, NARRATION_PROMPT, buildPersonaSections, normalizeMemoryPerspective } from './prompt/sections'

export function genId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

/**
 * 校验资源 ID 是否为系统生成的合法格式。
 * 会话/模型 ID 会拼入文件路径，必须校验，防止渲染进程构造路径穿越 ID（如 ../../secure/apiKey）。
 */
export function assertValidResourceId(id: string, kind: 'session' | 'model' | 'sprite' | 'card' | 'mem' | 'tts-model'): void {
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
    // 声音模式：旧卡按是否绑定参考音频迁移（绑定=mimo，否则 none）
    voiceMode: raw.voiceMode ?? (raw.voiceId ? 'mimo' : 'none'),
    localVoice: raw.localVoice ?? null,
    ttsOverride: raw.ttsOverride ?? null,
    // 角色 TTS 语速倍率（旧卡缺省 null = 原速）；范围钳制在变速函数内
    ttsSpeed: typeof raw.ttsSpeed === 'number' && Number.isFinite(raw.ttsSpeed) ? raw.ttsSpeed : null,
    // 形象呈现（2D 立绘）；旧卡缺省 → Live2D 模式、未绑立绘
    renderMode: raw.renderMode ?? null,
    spriteId: raw.spriteId ?? null,
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
    voiceMode: input.voiceMode ?? (input.voiceId ? 'mimo' : 'none'),
    localVoice: input.localVoice ?? null,
    ttsOverride: input.ttsOverride ?? null,
    ttsSpeed: typeof input.ttsSpeed === 'number' && Number.isFinite(input.ttsSpeed) ? input.ttsSpeed : null,
    renderMode: input.renderMode ?? null,
    spriteId: input.spriteId || null,
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

/** 归一化记忆条目：补齐 category/characterCardId/confirmed/sourceSessionId 缺省值（兼容旧数据）。
 *  注意保留可选字段 origin（剧情沉淀标记）与 enabled（注入开关）——显式字段清单重建对象时漏掉即静默丢失 */
function normalizeMemory(raw?: Partial<MemoryItem> | null): MemoryItem {
  return {
    id: raw?.id ?? genId('mem'),
    content: raw?.content ?? '',
    createdAt: raw?.createdAt ?? Date.now(),
    category: raw?.category ?? 'long_term',
    characterCardId: raw?.characterCardId ?? null,
    confirmed: raw?.confirmed ?? true,
    sourceSessionId: raw?.sourceSessionId ?? null,
    ...(raw?.origin ? { origin: raw.origin } : {}),
    ...(raw?.enabled === undefined ? {} : { enabled: raw.enabled }),
  }
}

export async function listMemories(): Promise<MemoryItem[]> {
  const items = await readJson<Partial<MemoryItem>[]>(paths.memoryFile, DEFAULT_MEMORIES)
  return items.map(normalizeMemory)
}

/**
 * 列出指定角色的已确认记忆（含全局背景 characterCardId=null，兼容旧数据），
 * 用于 system prompt 注入；按创建时间倒序后截取前 limit 条。
 * enabled=false 的条目暂停注入（用户开关），但不删除。
 */
export async function listConfirmedMemories(cardId: string, limit?: number): Promise<MemoryItem[]> {
  const items = await listMemories()
  const owned = items.filter(
    (m) => m.confirmed && m.enabled !== false && (m.characterCardId === cardId || m.characterCardId === null),
  )
  return limit && limit > 0 ? owned.slice(0, limit) : owned
}

/** 列出待确认候选（自动沉淀产物，未入 system prompt） */
export async function listPendingMemories(): Promise<MemoryItem[]> {
  const items = await listMemories()
  return items.filter((m) => !m.confirmed)
}

/** 手动新增一条已确认记忆（category 缺省 long_term；characterCardId 缺省 = 全局背景） */
export async function addMemory(input: {
  content: string
  category?: MemoryCategory
  characterCardId?: string | null
}): Promise<MemoryItem> {
  const text = input.content.trim()
  if (!text) throw new Error('记忆内容不能为空')
  const item: MemoryItem = {
    id: genId('mem'),
    content: text,
    createdAt: Date.now(),
    category: input.category ?? 'long_term',
    characterCardId: input.characterCardId ?? null,
    confirmed: true,
  }
  await mutateJson(paths.memoryFile, DEFAULT_MEMORIES, (items) => [item, ...items])
  return item
}

/** 追加待确认候选（自动沉淀写入，入列后由用户在设置窗确认/删除） */
export async function addPendingMemory(input: {
  content: string
  category: MemoryCategory
  characterCardId: string | null
  sourceSessionId?: string | null
  /** 记忆来源标记：'story' = 剧情经历沉淀（缺省 = 对话沉淀/手动添加） */
  origin?: 'story'
}): Promise<MemoryItem> {
  const text = input.content.trim()
  if (!text) throw new Error('记忆内容不能为空')
  const item: MemoryItem = {
    id: genId('mem'),
    content: text,
    createdAt: Date.now(),
    category: input.category,
    characterCardId: input.characterCardId,
    confirmed: false,
    sourceSessionId: input.sourceSessionId ?? null,
    ...(input.origin ? { origin: input.origin } : {}),
  }
  await mutateJson(paths.memoryFile, DEFAULT_MEMORIES, (items) => [item, ...items])
  return item
}

/** 更新记忆内容、分类或注入开关（部分更新；enabled=false = 暂停注入，条目保留） */
export async function updateMemory(id: string, patch: { content?: string; category?: MemoryCategory; enabled?: boolean }): Promise<void> {
  const nextPatch = { ...patch }
  if (nextPatch.content !== undefined) {
    const text = nextPatch.content.trim()
    if (!text) throw new Error('记忆内容不能为空')
    nextPatch.content = text
  }
  await mutateJson(paths.memoryFile, DEFAULT_MEMORIES, (items) => {
    let found = false
    const next = items.map((m) => {
      if (m.id !== id) return m
      found = true
      const update: Partial<MemoryItem> = {}
      if (nextPatch.content !== undefined) update.content = nextPatch.content
      if (nextPatch.category !== undefined) update.category = nextPatch.category
      if (nextPatch.enabled !== undefined) update.enabled = nextPatch.enabled
      return { ...m, ...update }
    })
    if (!found) throw new Error('记忆条目不存在')
    return next
  })
}

/** 确认待确认候选：confirmed=false → true，此后注入 system prompt */
export async function confirmMemory(id: string): Promise<void> {
  await mutateJson(paths.memoryFile, DEFAULT_MEMORIES, (items) => {
    let found = false
    const next = items.map((m) => {
      if (m.id !== id) return m
      found = true
      return { ...m, confirmed: true }
    })
    if (!found) throw new Error('记忆条目不存在')
    return next
  })
}

export async function removeMemory(id: string): Promise<void> {
  await mutateJson(paths.memoryFile, DEFAULT_MEMORIES, (items) => items.filter((m) => m.id !== id))
}

/**
 * 当前时间 Section（时间感知方案 A）：
 * LLM 无内置时钟，任何"现在几点"都来自 prompt。此前时间只藏在 user 消息前缀里（隐含线索），
 * 模型需要自己定位线索并做 24h→12h 制换算，曾出现 16:04 被说成"下午两点零四分"的换算幻觉。
 * 升级为 system prompt 权威声明：含日期/星期/时刻，并直接给出 12 小时制表述免模型换算；
 * buildSystemPrompt 每轮调用 → 时间自然刷新。金样测试不受影响（金样直接测
 * buildSystemParts/composeSystemPrompt，本函数仅在 repository 组装层拼接）。
 */
function currentTimeSection(now = new Date()): string {
  const week = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][now.getDay()]
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  const h = now.getHours()
  // 0 点的 12h 制表述用"凌晨0点"而非"凌晨12点"——后者罕见且有歧义，模型实测把它当弱锚点
  // 无视（2026-10-16 00:23 轮实锤：声明"凌晨12点23分"模型仍答"晚上十一点半"）；正午 12 点不变
  const hour12 = h === 0 ? 0 : h % 12 === 0 ? 12 : h % 12
  const period = h < 6 ? '凌晨' : h < 12 ? '上午' : h < 13 ? '中午' : h < 18 ? '下午' : '晚上'
  const minute = now.getMinutes() === 0 ? '整' : `${String(now.getMinutes()).padStart(2, '0')}分`
  return [
    `【当前真实时间】${date} ${week} ${hhmm}（${period}${hour12}点${minute}）。`,
    '对话中提到"现在""今天""刚才"等时刻一律以此为准；历史消息中的时间是过去的时刻，不代表现在。',
  ].join('\n')
}

/**
 * 时间感知关闭时的防幻觉条款：模型无内置时钟，纯静默（什么都不注入）会靠训练先验乱猜
 * "今天星期五"——显式声明"你不知道时间"后模型行为才可预期（坦诚说不知道而非编造）。
 */
const TIME_UNAWARE_SECTION = [
  '【时间感知已关闭】你没有可靠的时钟感知，不知道现在几点、今天星期几，也无法知道消息之间间隔了多久。',
  '不要声称或暗示你知道当前时间或日期，被问到时坦诚说"不太确定"；也不要根据时间推断对方的作息或状态。',
].join('\n')

/**
 * 记忆年龄前缀（时间感知方案2）：检索打分已有 recency 因子（30 天半衰期），但模型看不到
 * "多久之前"——两个月前的临时状态会被当现状。以相对时长标注，不写绝对日期（避免时区/
 * 换算歧义，与时间 Section 的 12h 制免换算口径一致）。受时间感知总开关门控。
 */
function formatMemoryAge(createdAt: number, now = Date.now()): string {
  const ms = Math.max(0, now - createdAt)
  if (ms < 60 * 60 * 1000) return '（刚刚）'
  if (ms < 48 * 60 * 60 * 1000) return `（约${Math.round(ms / 3_600_000)}小时前）`
  if (ms < 60 * 86_400_000) return `（约${Math.round(ms / 86_400_000)}天前）`
  return `（约${Math.round(ms / (30 * 86_400_000))}个月前）`
}

/**
 * 分段组装 system prompt（PromptComposer 薄包装，末尾前置当前时间 Section）。
 *
 * @param card 角色卡（取人设字段）
 * @param memories 参与注入的记忆列表（来源由检索器决定：向量检索 or 最近 N 条）
 * @param userName 你的称呼（%player% 占位符替换值）
 * @param profileDigest 用户画像压缩稿（M4 分层压缩产物；缺省不注入）
 * @param proactiveHint 是否注入主动搭话常驻说明（enableProactive 开启时为 true）
 * @param storyDirective 剧情导演指令段（仅剧情演出轮次注入；缺省不注入）
 * @param stripParenNarration 台词模式（「回答仅含台词」开启时为 true）：旁白规范段替换为禁括号版本
 * @param emotionPalette 角色绑定的状态词表（null = 未启用词表，输出格式段维持旧 6 枚举金样原文）
 * @param timeAwareness 时间感知总开关（缺省/undefined = 开启，向后兼容）：开启 → 当前时间锚点 +
 *   记忆年龄标注；关闭 → 防时间幻觉条款。记忆检索打分的 recency 因子属于排序逻辑，不受此开关影响
 */
export function buildSystemPrompt(
  card: CharacterCard | null,
  memories: MemoryItem[],
  userName = '用户',
  profileDigest?: string | null,
  proactiveHint?: boolean,
  storyDirective?: string | null,
  stripParenNarration?: boolean,
  emotionPalette?: EmotionPaletteRef | null,
  timeAwareness?: boolean,
  sceneSection?: string | null,
): string {
  const timeAware = timeAwareness !== false
  // 方案2 记忆年龄标注：在组装层做映射（不进 buildSystemParts/composeSystemPrompt），金样测试
  // 直接测这两层、传自己的 memories，不受影响。无 createdAt 的条目（防御）原样透传
  const effectiveMemories = timeAware
    ? memories.map((m) =>
        typeof m.createdAt === 'number' && m.createdAt > 0 ? { ...m, content: `${formatMemoryAge(m.createdAt)}${m.content}` } : m,
      )
    : memories
  const sections = buildSystemParts(card, effectiveMemories, profileDigest, proactiveHint, storyDirective, stripParenNarration, emotionPalette)
  const composed = composeSystemPrompt(sections, { userName }).text
  // 时间 Section 置于最前：模型先建立"现在"的锚点，再读画像/人设/记忆。
  // 总开关关闭 → 防幻觉条款占位（模型无时钟，纯静默会乱猜，见 TIME_UNAWARE_SECTION 注释）
  const timeHeader = timeAware ? currentTimeSection() : TIME_UNAWARE_SECTION
  // 情境 Section 紧随时间之后（先"现在几点"再"现在什么情境"）。组装层拼接（金样零影响）；
  // 缺省（无摘要/开关关闭/调用方未传）不注入，模型退化为现状
  return sceneSection ? `${timeHeader}\n\n${sceneSection}\n\n${composed}` : `${timeHeader}\n\n${composed}`
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
  // 空会话不会有已发送的图片，但可能有粘贴后未发送的残留，一并清掉
  await Promise.all(empties.map((s) => removeSessionImages(s.id)))
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
    return {
      ...base,
      messages: [...base.messages, ...extra],
      revision: (base.revision ?? 0) + 1,
      sceneEpoch: (base.sceneEpoch ?? 0) + 1,
    }
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

/**
 * 删除会话最后一轮（末尾 assistant + 其前最近的 user），返回被删除的 user 内容。
 *
 * @deprecated 编辑重发/重新回答已统一走 truncateSessionFromMessage（支持任意目标 + revision 校验 +
 * 摘要游标/标题处理）。此函数仅为旧调用方保留；新代码不要使用。
 */
export async function deleteLastTurnMessages(id: string): Promise<ChatMessage | null> {
  assertValidResourceId(id, 'session')
  let removedUser: ChatMessage | null = null
  await mutateJson<SessionDetail | null>(paths.sessionFile(id), null, (cur) => {
    if (!cur) return cur
    const msgs = cur.messages ?? []
    if (msgs.length === 0) return cur
    const last = msgs[msgs.length - 1]
    // 形态1：完整轮（末尾 assistant + 其前 user）→ 两条一起删
    if (last?.role === 'assistant') {
      if (msgs.length < 2) return cur
      const prev = msgs[msgs.length - 2]
      if (prev?.role !== 'user') return cur
      removedUser = prev
      return {
        ...cur,
        messages: msgs.slice(0, -2),
        revision: (cur.revision ?? 0) + 1,
        sceneEpoch: (cur.sceneEpoch ?? 0) + 1,
      }
    }
    // 形态2：孤立 user（上一轮发送失败/取消落盘的"未收到回复"消息，2026-10-17 实锤）
    // → 只删它并以原内容重跑（重答=重发）；主动搭话旁白不是用户输入，不参与重答
    if (last?.role === 'user' && !last.meta?.proactive) {
      removedUser = last
      return {
        ...cur,
        messages: msgs.slice(0, -1),
        revision: (cur.revision ?? 0) + 1,
        sceneEpoch: (cur.sceneEpoch ?? 0) + 1,
      }
    }
    return cur
  })
  if (!removedUser) return null
  // 更新索引 messageCount / updatedAt（title 不回退：由首条 user 派生，重答不影响）
  const detail = await getSession(id)
  await mutateJson(paths.sessionsIndexFile, DEFAULT_SESSION_INDEX, (index) => {
    const idx = index.findIndex((s) => s.id === id)
    if (idx === -1) return index
    const existing = index[idx] as SessionIndexItem
    index[idx] = { ...existing, messageCount: detail?.messages.length ?? 0, updatedAt: Date.now() }
    return index
  })
  return removedUser
}

/**
 * 从指定消息起截断会话（编辑并重发 / 重新回答的核心落盘操作）：
 * 删除 targetIndex 及其后的全部消息，返回新会话与被删消息。
 *
 * 与 deleteLastTurnMessages 的区别：支持任意 user 消息（中间轮次），并用
 * expectedRevision 做乐观并发校验，防止另一窗口在读取后追加消息导致按旧下标误删。
 * allowProactive：重新回答主动搭话轮时目标 user 是旁白，需要放行；编辑并重发恒为 false。
 */
export async function truncateSessionFromMessage(
  id: string,
  targetIndex: number,
  opts: { expectedRevision?: number; allowProactive?: boolean } = {},
): Promise<{
  session: SessionDetail
  removed: ChatMessage[]
} | null> {
  assertValidResourceId(id, 'session')
  let removed: ChatMessage[] = []
  let oldMessages: ChatMessage[] = []
  const session = await mutateJson<SessionDetail | null>(paths.sessionFile(id), null, (cur) => {
    if (!cur) throw new Error('会话不存在')
    if (opts.expectedRevision != null && (cur.revision ?? 0) !== opts.expectedRevision) {
      throw new Error('会话已更新，请刷新后重试')
    }
    const msgs = cur.messages ?? []
    if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= msgs.length) {
      throw new Error('目标消息不存在')
    }
    const target = msgs[targetIndex]
    if (target?.role !== 'user') throw new Error('只能编辑用户消息')
    if (!opts.allowProactive && target.meta?.proactive) throw new Error('主动搭话旁白不支持编辑')
    oldMessages = msgs
    removed = msgs.slice(targetIndex)
    return {
      ...cur,
      messages: msgs.slice(0, targetIndex),
      revision: (cur.revision ?? 0) + 1,
      sceneEpoch: (cur.sceneEpoch ?? 0) + 1,
    }
  })
  if (!session || removed.length === 0) return null

  // 索引更新：messageCount / updatedAt；首条消息被编辑且标题仍是自动派生值时，重置标题，
  // 让下一次 appendSessionMessages 按新的首条 user 重新生成（用户手动改过的标题不覆盖）。
  const index = await listSessions()
  const item = index.find((s) => s.id === id)
  const resetTitle = targetIndex === 0 && !!item && item.title === deriveTitle(oldMessages)
  await mutateJson(paths.sessionsIndexFile, DEFAULT_SESSION_INDEX, (list) => {
    const idx = list.findIndex((s) => s.id === id)
    if (idx === -1) return list
    const existing = list[idx] as SessionIndexItem
    list[idx] = {
      ...existing,
      title: resetTitle ? '新会话' : existing.title,
      messageCount: session.messages.length,
      updatedAt: Date.now(),
    }
    return list
  })
  return { session, removed }
}

/**
 * 重发去重：发送前若磁盘末条是**带 error 标记的失败 user** 且内容与本次发送完全相同，
 * 则移除它（本次发送替代失败尝试）。失败轮落盘 user 携带 error 供"未收到回复"提示展示，
 * 但用户重发同一条消息时若不替换，历史里会出现两条相邻重复 user（2026-10-17 实锤，
 * 重复消息进入上下文还可能诱发模型输出劣化）。
 */
export async function removeFailedDuplicateUser(id: string, content: string): Promise<void> {
  assertValidResourceId(id, 'session')
  const text = content.trim()
  if (!text) return
  await mutateJson<SessionDetail | null>(paths.sessionFile(id), null, (cur) => {
    if (!cur) return cur
    const msgs = cur.messages ?? []
    const last = msgs[msgs.length - 1]
    if (last?.role !== 'user' || !last.error || last.content.trim() !== text) return cur
    return {
      ...cur,
      messages: msgs.slice(0, -1),
      revision: (cur.revision ?? 0) + 1,
      sceneEpoch: (cur.sceneEpoch ?? 0) + 1,
    }
  })
}

/**
 * 存量清理（启动一次性、幂等）：扫描全部会话，移除"失败 user + 紧随其后的同内容重发 user"
 * 相邻重复对（历史版本未做重发去重时产生的重复，2026-10-17 实锤 19:20 轮）。
 * 仅当两条**相邻**且内容一致、前一条带 error 标记时才删前一条——保守不误删正常对话。
 */
export async function dedupeFailedUserResends(): Promise<void> {
  try {
    const index = await listSessions()
    for (const item of index) {
      await mutateJson<SessionDetail | null>(paths.sessionFile(item.id), null, (cur) => {
        if (!cur) return cur
        const msgs = cur.messages ?? []
        let changed = false
        const out: ChatMessage[] = []
        for (let i = 0; i < msgs.length; i++) {
          const cur2 = msgs[i]
          if (!cur2) continue
          const prev = out[out.length - 1]
          if (
            prev &&
            prev.role === 'user' &&
            !!prev.error &&
            cur2?.role === 'user' &&
            cur2.content.trim() === prev.content.trim() &&
            !cur2.error
          ) {
            // 前一条失败 user 被同内容重发替代 → 丢弃前一条
            changed = true
            continue
          }
          out.push(cur2)
        }
        return changed ? { ...cur, messages: out } : cur
      })
    }
  } catch (err) {
    console.error('[migrate] 重发去重清理失败', err)
  }
}

/**
 * 写入会话的历史摘要（A2 自动压缩产物，落盘复用）。
 * 会话文件不存在（已被删除）时静默忽略；摘要不参与消息数组，UI 不展示。
 */
export async function updateSessionSummary(id: string, summary: string): Promise<void> {
  assertValidResourceId(id, 'session')
  const text = summary?.trim()
  if (!text) return
  await mutateJson<SessionDetail | null>(paths.sessionFile(id), null, (cur) => {
    if (!cur) return cur
    return { ...cur, summary: text }
  })
}

/**
 * 写入会话的情景摘要缓存（情境服务 Phase 1：每轮由辅助模型异步更新"此刻场景状态"）。
 * 会话文件不存在时静默忽略；空摘要不写（保留旧值）。
 *
 * 并发保护：expectedSceneEpoch 与当前会话代际不一致时放弃写入——rewind 截断、手动编辑
 * 或新一轮落盘都会推进 sceneEpoch，旧轮的异步更新不得覆盖更新的状态。
 * atMessageCount：摘要对应的 messages.length（sceneDigestAt），用于判断摘要是否覆盖某条消息。
 * @returns 是否真正写入
 */
export async function updateSessionSceneDigest(
  id: string,
  digest: string,
  opts: { expectedSceneEpoch?: number; atMessageCount?: number } = {},
): Promise<boolean> {
  assertValidResourceId(id, 'session')
  const text = digest?.trim()
  if (!text) return false
  let written = false
  await mutateJson<SessionDetail | null>(paths.sessionFile(id), null, (cur) => {
    if (!cur) return cur
    if (opts.expectedSceneEpoch != null && (cur.sceneEpoch ?? 0) !== opts.expectedSceneEpoch) return cur
    written = true
    const next: SessionDetail = {
      ...cur,
      sceneDigest: text,
      sceneEpoch: (cur.sceneEpoch ?? 0) + 1,
    }
    if (opts.atMessageCount !== undefined) next.sceneDigestAt = opts.atMessageCount
    return next
  })
  return written
}

/**
 * 手动写入/清空会话的情景摘要缓存（设置窗文本块编辑通道）。
 * 与 updateSessionSceneDigest 的区别：允许空串清除字段（用户显式清空 = 删除缓存，
 * 下一轮注入只剩系统层活跃状态行，之后由辅助模型重新生成）。
 *
 * 手动编辑同样推进 sceneEpoch：在途的自动更新携带旧代际会被丢弃，不能覆盖用户手写内容。
 * atMessageCount 缺省取当前消息数（手动摘要描述"此刻"，视为覆盖到当前全部消息）。
 * @returns 是否真正写入
 */
export async function setSessionSceneDigest(
  id: string,
  text: string,
  opts: { expectedSceneEpoch?: number; atMessageCount?: number } = {},
): Promise<boolean> {
  assertValidResourceId(id, 'session')
  const trimmed = text?.trim() ?? ''
  let written = false
  await mutateJson<SessionDetail | null>(paths.sessionFile(id), null, (cur) => {
    if (!cur) return cur
    if (opts.expectedSceneEpoch != null && (cur.sceneEpoch ?? 0) !== opts.expectedSceneEpoch) return cur
    written = true
    const at = opts.atMessageCount ?? (cur.messages?.length ?? 0)
    if (!trimmed) {
      const { sceneDigest: _removed, ...rest } = cur
      return { ...rest, sceneDigestAt: at, sceneEpoch: (cur.sceneEpoch ?? 0) + 1 }
    }
    return { ...cur, sceneDigest: trimmed, sceneDigestAt: at, sceneEpoch: (cur.sceneEpoch ?? 0) + 1 }
  })
  return written
}

export async function removeSession(id: string): Promise<void> {
  assertValidResourceId(id, 'session')
  await mutateJson(paths.sessionsIndexFile, DEFAULT_SESSION_INDEX, (index) => index.filter((s) => s.id !== id))
  await deleteFile(paths.sessionFile(id))
  // 级联删除该会话的聊天图片附件（失败静默，由保留期清理兜底）
  await removeSessionImages(id)
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

/** 更新模型元数据（当前仅展示名重命名；不动磁盘目录与 model3.json） */
export async function updateModel(
  modelId: string,
  patch: Partial<Pick<Live2DModelMeta, 'name'>>,
): Promise<void> {
  assertValidResourceId(modelId, 'model')
  await mutateJson(paths.modelsIndexFile, DEFAULT_MODELS, (list) =>
    list.map((m) => (m.id === modelId ? { ...m, ...patch } : m)),
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

/** 更新立绘集的展示资产：状态词表 / 经典状态映射 / 说话立绘 / 思考立绘 / 名称 */
export async function updateSprite(
  spriteId: string,
  patch: Partial<Pick<CharacterSprite, 'name' | 'emotions' | 'defaultEmotion' | 'speakingImage' | 'thinkingImage' | 'observingImage'>>,
): Promise<void> {
  assertValidResourceId(spriteId, 'sprite')
  await mutateJson(paths.spritesIndexFile, DEFAULT_SPRITES, (list) =>
    list.map((s) => (s.id === spriteId ? { ...s, ...patch } : s)),
  )
}

/**
 * 读取立绘集的状态词表视图（系统内唯一取词表入口，永不返回 null）：
 * 立绘集不存在 / 未打标 → 内置最小词表（仅"平静"）。
 */
export async function getSpritePalette(spriteId: string | null | undefined): Promise<EmotionPaletteRef> {
  if (spriteId) {
    try {
      const spr = (await listSprites()).find((s) => s.id === spriteId)
      if (spr) return paletteFromSprite(spr)
    } catch {
      // 读取失败按未打标处理
    }
  }
  return builtinPalette()
}

// ---------------- Live2D 模型演出词表（data/model-palettes.json，与立绘集词表双轨对等） ----------------

/** 模型词表存储形态：modelId → { entries }（纯「词→表情」映射，无默认状态） */
type ModelPaletteStore = Record<string, ModelPalette>

/**
 * 读取 Live2D 模型演出词表视图（live2d 模式取词表入口，永不返回 null）：
 * 模型不存在 / 未配置词表 → 内置最小词表（仅"平静"，无表情联动，回落静态表情）。
 * 模型词表无默认状态概念：归一化兜底词固定取「平静」（在表内）或第一个词条，
 * 与 prompt 契约一致；未命中词条的状态在渲染端不联动表情（查表落空 → 回落静态表情）。
 */
export async function getModelPalette(modelId: string | null | undefined): Promise<EmotionPaletteRef> {
  if (modelId) {
    try {
      const store = await readJson<ModelPaletteStore>(paths.modelPalettesFile, {})
      const palette = store[modelId]
      if (palette && Array.isArray(palette.entries) && palette.entries.length > 0) {
        // 兜底词：平静（在表内）> 第一个词条（与 paletteFromSprite 的缺省口径一致）
        const names = new Set(palette.entries.map((e) => e.name))
        const def = names.has(BUILTIN_DEFAULT_EMOTION) ? BUILTIN_DEFAULT_EMOTION : palette.entries[0]!.name
        return { entries: palette.entries.map((e) => ({ name: e.name, gloss: e.gloss })), defaultEmotion: def }
      }
    } catch {
      // 读取失败按未配置处理
    }
  }
  return builtinPalette()
}

/** 读取模型词表原始数据（编辑器用，含 expression；未配置返回 null） */
export async function readModelPalette(modelId: string): Promise<ModelPalette | null> {
  const store = await readJson<ModelPaletteStore>(paths.modelPalettesFile, {})
  return store[modelId] ?? null
}

/** 保存 Live2D 模型演出词表（全量写回；词表空 = 删除该模型的词表配置，运行时落内置最小词表） */
export async function updateModelPalette(modelId: string, palette: ModelPalette): Promise<void> {
  await mutateJson<ModelPaletteStore>(paths.modelPalettesFile, {}, (store) => {
    const next: ModelPaletteStore = { ...store }
    if (Array.isArray(palette.entries) && palette.entries.length > 0) {
      next[modelId] = {
        entries: palette.entries
          .filter((e) => e.name.trim())
          .map((e) => ({
            name: e.name.trim(),
            gloss: e.gloss?.trim?.() ?? '',
            ...(e.expression?.trim() ? { expression: e.expression.trim() } : {}),
          })),
      }
    } else {
      delete next[modelId]
    }
    return next
  })
}

/** 删除模型时清理其词表配置（models 删除链路调用） */
export async function deleteModelPalette(modelId: string): Promise<void> {
  await mutateJson<ModelPaletteStore>(paths.modelPalettesFile, {}, (store) => {
    if (!(modelId in store)) return store
    const next: ModelPaletteStore = { ...store }
    delete next[modelId]
    return next
  })
}

/**
 * 旧 6 枚举 → 词表词的迁移映射（含释义）。neutral 缺失时词表默认取第一个词条。
 */
const LEGACY_EMOTION_MIGRATION: Record<string, { name: string; gloss: string }> = {
  neutral: { name: BUILTIN_DEFAULT_EMOTION, gloss: BUILTIN_DEFAULT_GLOSS },
  happy: { name: '开心', gloss: '愉悦雀跃' },
  sad: { name: '难过', gloss: '低落委屈' },
  angry: { name: '生气', gloss: '愤怒恼火' },
  surprised: { name: '惊讶', gloss: '吃惊意外' },
  shy: { name: '害羞', gloss: '脸红羞涩' },
}

/**
 * 一次性迁移（启动调用）：立绘集旧 emotionMap（6 枚举→图）→ emotions 词表条目，
 * 并从数据中剥离 emotionMap 字段。已迁移/无旧映射的集不动（词表为空 = 内置最小词表）。
 * @returns 发生迁移的立绘集数量（仅日志用）
 */
export async function migrateSpriteEmotionMaps(): Promise<number> {
  const list = await readJson<Partial<CharacterSprite>[]>(paths.spritesIndexFile, [])
  let migrated = 0
  let changed = false
  const next = list.map((raw) => {
    if (!raw || typeof raw !== 'object' || !('emotionMap' in raw)) return raw
    changed = true
    const spr = raw as Record<string, unknown>
    const legacyMap = spr['emotionMap'] as Record<string, string> | null | undefined
    delete spr['emotionMap']
    const hasPalette = Array.isArray(raw.emotions) && raw.emotions.length > 0
    if (hasPalette || !legacyMap || typeof legacyMap !== 'object') return spr as unknown as CharacterSprite
    // emotionMap → 词表条目（按旧 6 枚举固定顺序，跳过未配置项）
    const entries: SpritePaletteEntry[] = []
    for (const key of ['neutral', 'happy', 'sad', 'angry', 'surprised', 'shy']) {
      const image = legacyMap[key]
      if (!image) continue
      const { name, gloss } = LEGACY_EMOTION_MIGRATION[key] ?? { name: key, gloss: '' }
      entries.push({ name, gloss, image })
    }
    if (entries.length === 0) return spr as unknown as CharacterSprite
    spr['emotions'] = entries
    spr['defaultEmotion'] =
      legacyMap['neutral'] && entries.some((e) => e.name === BUILTIN_DEFAULT_EMOTION)
        ? BUILTIN_DEFAULT_EMOTION
        : entries[0]!.name
    migrated++
    console.log('[migrate] 立绘集 emotionMap → 词表：%s（%d 词条）', raw.name ?? raw.id, entries.length)
    return spr as unknown as CharacterSprite
  })
  if (changed) await writeJson(paths.spritesIndexFile, next)
  return migrated
}

/**
 * 计算词表内容指纹（djb2 十六进制）：词/释义与顺序任一变化都会改变指纹。
 * 用于剧本 story.yaml 的 vocabHash 比对（打开剧本时检测"词表已变"）。
 * 指纹仅覆盖 name+gloss——vocabHash 的语义是「事件引用的状态词是否仍有效」，
 * 演出物（立绘图/表情绑定）变化不影响词的有效性，不参与指纹。
 */
export function paletteHash(palette: EmotionPaletteRef): string | null {
  if (!palette || palette.entries.length === 0) return null
  let hash = 5381
  const feed = (s: string) => {
    for (let i = 0; i < s.length; i++) hash = ((hash * 33) ^ s.charCodeAt(i)) & 0xffffffff
  }
  feed(palette.defaultEmotion)
  for (const e of palette.entries) {
    feed(`|${e.name}|${e.gloss}`)
  }
  return (hash >>> 0).toString(16)
}

// ---------------- 设置 ----------------

const DEFAULT_SETTINGS: AppSettings = {
  // 全局服务商档案库（档案制配置）：主/辅/视觉/嵌入各自引用其中一个档案（启动迁移填充）
  profiles: [],
  activeMainProfileId: null,
  // 辅助模型未启用（null）时回落主模型激活的档案
  activeAuxProfileId: null,
  // 视觉模型不回落主模型：未启用则屏幕感知降级、立绘打标不可用
  activeVisionProfileId: null,
  // 嵌入模型未启用则记忆向量检索关闭
  activeEmbeddingProfileId: null,
  // ↓ 以下 baseURL/model 为旧版单配置字段（已废弃），仅启动迁移读取一次
  baseURL: '',
  model: '',
  temperature: 0.8,
  maxTokens: 1024,
  stream: true,
  theme: 'dark',
  // 上下文管理（A1/A2）：默认 32k 窗口 + 开启自动摘要
  contextWindowTokens: 32768,
  enableAutoCompact: true,
  // 记忆自动沉淀：默认开启（会话结束后台抽取候选记忆，需用户确认后生效）
  enableMemoryExtraction: true,
  // 主动搭话：默认关闭（调度循环每 30s 一轮；需用户显式开启）
  enableProactive: false,
  // 回答仅含台词：普通聊天不生成也不显示（）内的心理/动作/环境描写（默认关闭 = 保留现状）
  stripParenNarration: false,
  // 屏幕感知：默认关闭（与主动搭话级联；开启后搭话前先感知屏幕内容）
  enableScreenSense: false,
  // 视觉能力（设置页「视觉」模块）：默认转述模式（不依赖主模型是否支持图片输入）
  vision: {
    readMode: 'describe',
    chatImagesEnabled: true,
    // 图片记忆轮数：默认 0 = 仅发送当轮带原图，之后只用 caption 文本
    captionRounds: 0,
    // 原图保留天数：默认 30 天（0 = 永久）
    imageRetentionDays: 30,
    // 感知范围默认只截活动窗口（字更清楚，且天然排除自家窗口）
    screenRange: 'window',
    // 前台窗口信号（L0）与情境注入默认关闭：需用户显式开启
    readForeground: false,
    injectActivity: false,
    // 截图时隐藏本应用窗口：默认开（否则屏幕感知会把自己的桌宠拍进去）
    hideFromCapture: true,
    // 点眼睛时的识图方式：默认速览（保持旧行为）
    eyeReadMode: 'ambient',
  },
  // 每日主动搭话上限（用户回复后重置计数）
  maxProactivePerDay: 3,
  // 主动搭话兴趣值增长间隔（秒）：每 X 秒累积一轮兴趣值（+5~10）
  proactiveInterestIntervalSec: 30,
  // 话题搭话旁白由 LLM 随机生成（每次搭话多一次小调用；失败回退固定模板）
  proactiveLlmNarration: true,
  // 屏幕搭话占比：默认 70%（十次主动搭话里约七次先看一眼屏幕）
  proactiveScreenWeight: 70,
  // 免打扰时段（空串 = 不启用；支持跨零点）
  quietHours: { start: '', end: '' },
  // 屏幕感知视觉模型（OpenAI 兼容 chat/completions + 图片输入；Key 独立加密存储）
  visionBaseURL: '',
  visionModel: '',
  // 记忆向量检索：默认关闭（需在设置中填入嵌入 API 地址/模型/Key 后开启；开启前回退「最近 N 条」注入）
  memoryRetrievalEnabled: false,
  // 嵌入 API 地址（OpenAI 兼容 /embeddings；独立于主 LLM 的 baseURL）
  embeddingBaseURL: '',
  // 嵌入模型名（对应嵌入服务商；Key 走独立加密存储）
  embeddingModel: '',
  // 翻译/修复辅助模型（P0-2B：ja 翻译与 JSON 结构修复走快速小模型；留空回落主对话模型）
  translationBaseURL: '',
  translationModel: '',
  // AI 时间感知总开关：默认开启（当前时间锚点/对话间隔/记忆年龄/摘要时间线全链路）
  timeAwarenessEnabled: true,
  // 语音文本跟随语音逐字显示：默认开启（台词文本按音频播放进度逐字放行）
  voiceTextFollowAudio: true,
  // 语音段截断二次重试时重载模型：默认开启（首次截断免重载直接重试；仍截断才按本开关重载兜底）
  truncationReloadRetry: true,
  // Genie 多句段严格判定：默认开启（多句段使用单独阈值，取消 20 字豁免）
  genieMultiSentenceStrict: true,
  // 多句段截断阈值：默认 0.9（覆盖实测 0.64~0.87 的截断比例）
  genieMultiSentenceTruncationRatio: 0.9,
  // 单句截断阈值：默认 0.55（保持原行为）
  genieTruncationRatio: 0.55,
  // 情景摘要缓存：默认开启（每轮异步更新"此刻场景状态"，注入【当前情景】Section）
  enableSceneDigest: true,
  // 语义去重相似度阈值（cos ≥ 阈值视为重复）
  memoryDedupThreshold: 0.92,
  // 你的称呼：%player% 占位符的替换值
  userName: '用户',
  // 文字显示速度：0-100 速度档（越大越快；0=即时显示）——桌宠/聊天窗用
  textSpeed: 80,
  // 剧情窗对话框文字显示速度（独立于通用 textSpeed，仅剧情系统读取）
  storyTextSpeed: 80,
}

export async function getSettings(): Promise<AppSettings> {
  const saved = await readJson<Partial<AppSettings> | null>(paths.settingsFile, null)
  const merged = { ...DEFAULT_SETTINGS, ...(saved ?? {}) }
  // vision 为嵌套对象：浅合并会让缺失的子字段变 undefined，此处逐字段兜底
  merged.vision = { ...DEFAULT_SETTINGS.vision, ...(saved?.vision ?? {}) }
  return merged
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const result = await mutateJson<Partial<AppSettings> | null>(paths.settingsFile, null, (current) => {
    const base = current ?? {}
    const next: Partial<AppSettings> = { ...base }
    // 仅合并白名单字段，避免污染
    // 档案库：整体写回（渲染端档案管理区全量提交）；剔除非法条目与传输态 hasKey
    if (patch.profiles !== undefined) {
      next.profiles = (Array.isArray(patch.profiles) ? patch.profiles : [])
        .filter((p): p is ApiProfile => !!p && typeof p.id === 'string' && /^prof_[0-9a-f]{12}$/.test(p.id))
        .map((p) => ({ id: p.id, name: String(p.name ?? '').slice(0, 40), baseURL: String(p.baseURL ?? '').trim(), model: String(p.model ?? '').trim() }))
    }
    if (patch.activeMainProfileId !== undefined) next.activeMainProfileId = patch.activeMainProfileId
    if (patch.activeAuxProfileId !== undefined) next.activeAuxProfileId = patch.activeAuxProfileId
    if (patch.activeVisionProfileId !== undefined) next.activeVisionProfileId = patch.activeVisionProfileId
    if (patch.activeEmbeddingProfileId !== undefined) next.activeEmbeddingProfileId = patch.activeEmbeddingProfileId
    if (patch.baseURL !== undefined) next.baseURL = patch.baseURL
    if (patch.model !== undefined) next.model = patch.model
    if (patch.temperature !== undefined) next.temperature = patch.temperature
    if (patch.maxTokens !== undefined) next.maxTokens = patch.maxTokens
    if (patch.stream !== undefined) next.stream = patch.stream
    if (patch.theme !== undefined) next.theme = patch.theme
    if (patch.contextWindowTokens !== undefined) next.contextWindowTokens = patch.contextWindowTokens
    if (patch.enableAutoCompact !== undefined) next.enableAutoCompact = patch.enableAutoCompact
    if (patch.enableMemoryExtraction !== undefined) next.enableMemoryExtraction = patch.enableMemoryExtraction
    if (patch.stripParenNarration !== undefined) next.stripParenNarration = patch.stripParenNarration
    if (patch.enableProactive !== undefined) next.enableProactive = patch.enableProactive
    if (patch.enableScreenSense !== undefined) next.enableScreenSense = patch.enableScreenSense
    if (patch.vision !== undefined) {
      // 嵌套对象：逐字段校验并夹取，避免渲染端传入非法值污染磁盘
      const v = (patch.vision ?? {}) as Partial<VisionSettings>
      const rounds = Number(v.captionRounds)
      const days = Number(v.imageRetentionDays)
      next.vision = {
        readMode: v.readMode === 'direct' ? 'direct' : 'describe',
        chatImagesEnabled: v.chatImagesEnabled !== false,
        // 夹取 0~6 轮：4 张图 × N 轮是乘法关系，上限过大会把上下文窗口吃满
        captionRounds: Number.isFinite(rounds) ? Math.min(6, Math.max(0, Math.floor(rounds))) : 0,
        imageRetentionDays: Number.isFinite(days) ? Math.min(365, Math.max(0, Math.floor(days))) : 30,
        screenRange: v.screenRange === 'screen' ? 'screen' : 'window',
        readForeground: v.readForeground === true,
        injectActivity: v.injectActivity === true,
        hideFromCapture: v.hideFromCapture !== false,
        eyeReadMode: v.eyeReadMode === 'detail' ? 'detail' : v.eyeReadMode === 'native' ? 'native' : 'ambient',
      }
    }
    if (patch.maxProactivePerDay !== undefined) next.maxProactivePerDay = Math.max(0, Math.floor(patch.maxProactivePerDay))
    if (patch.proactiveInterestIntervalSec !== undefined) {
      // 夹取 10~600 秒：下限防定时器疯转，上限兜底极端输入
      next.proactiveInterestIntervalSec = Math.min(600, Math.max(10, Math.floor(patch.proactiveInterestIntervalSec)))
    }
    if (patch.proactiveLlmNarration !== undefined) next.proactiveLlmNarration = patch.proactiveLlmNarration
    if (patch.proactiveScreenWeight !== undefined) {
      // 夹取 0~100：这是概率百分比，超出范围没有意义
      const w = Number(patch.proactiveScreenWeight)
      next.proactiveScreenWeight = Number.isFinite(w) ? Math.min(100, Math.max(0, Math.floor(w))) : 70
    }
    if (patch.quietHours !== undefined) next.quietHours = patch.quietHours
    if (patch.visionBaseURL !== undefined) next.visionBaseURL = patch.visionBaseURL
    if (patch.visionModel !== undefined) next.visionModel = patch.visionModel
    if (patch.memoryRetrievalEnabled !== undefined) next.memoryRetrievalEnabled = patch.memoryRetrievalEnabled
    if (patch.embeddingBaseURL !== undefined) next.embeddingBaseURL = patch.embeddingBaseURL
    if (patch.embeddingModel !== undefined) next.embeddingModel = patch.embeddingModel
    if (patch.translationBaseURL !== undefined) next.translationBaseURL = patch.translationBaseURL
    if (patch.translationModel !== undefined) next.translationModel = patch.translationModel
    if (patch.timeAwarenessEnabled !== undefined) next.timeAwarenessEnabled = patch.timeAwarenessEnabled
    if (patch.voiceTextFollowAudio !== undefined) next.voiceTextFollowAudio = patch.voiceTextFollowAudio
    if (patch.truncationReloadRetry !== undefined) next.truncationReloadRetry = patch.truncationReloadRetry
    if (patch.genieMultiSentenceStrict !== undefined) next.genieMultiSentenceStrict = !!patch.genieMultiSentenceStrict
    if (patch.genieMultiSentenceTruncationRatio !== undefined) {
      // 夹取 0.5~1.0：过低会漏判截断，过高会频繁误判重试
      const v = Number(patch.genieMultiSentenceTruncationRatio)
      next.genieMultiSentenceTruncationRatio = Number.isFinite(v) ? Math.min(1, Math.max(0.5, v)) : 0.9
    }
    if (patch.genieTruncationRatio !== undefined) {
      // 夹取 0.3~0.9：保持单句原有判定区间
      const v = Number(patch.genieTruncationRatio)
      next.genieTruncationRatio = Number.isFinite(v) ? Math.min(0.9, Math.max(0.3, v)) : 0.55
    }
    if (patch.enableSceneDigest !== undefined) next.enableSceneDigest = patch.enableSceneDigest
    if (patch.memoryDedupThreshold !== undefined) next.memoryDedupThreshold = patch.memoryDedupThreshold
    if (patch.userName !== undefined) next.userName = patch.userName
    if (patch.textSpeed !== undefined) next.textSpeed = patch.textSpeed
    if (patch.storyTextSpeed !== undefined) next.storyTextSpeed = patch.storyTextSpeed
    return next
  })
  const merged = { ...DEFAULT_SETTINGS, ...result }
  // vision 同 getSettings：返回值也必须是完整嵌套对象，否则渲染端读子字段会拿到 undefined
  merged.vision = { ...DEFAULT_SETTINGS.vision, ...(result?.vision ?? {}) }
  return merged
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
  spriteView: { scale: 1, x: 0, y: 0 },
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
    spriteView: { ...DEFAULT_MODEL_SETTINGS.spriteView, ...(saved.spriteView ?? {}) },
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
    if (patch.spriteView) next.spriteView = { ...(base.spriteView ?? {}), ...patch.spriteView }
    if (patch.selectedModelId !== undefined) next.selectedModelId = patch.selectedModelId
    if (patch.selectedSpriteId !== undefined) next.selectedSpriteId = patch.selectedSpriteId
    return next
  })
  return {
    parameters: { ...DEFAULT_MODEL_SETTINGS.parameters, ...(result?.parameters ?? {}) },
    animation: { ...DEFAULT_MODEL_SETTINGS.animation, ...(result?.animation ?? {}) },
    view: { ...DEFAULT_MODEL_SETTINGS.view, ...(result?.view ?? {}) },
    spriteView: { ...DEFAULT_MODEL_SETTINGS.spriteView, ...(result?.spriteView ?? {}) },
    selectedModelId: result?.selectedModelId ?? DEFAULT_MODEL_SETTINGS.selectedModelId,
    selectedSpriteId: result?.selectedSpriteId ?? DEFAULT_MODEL_SETTINGS.selectedSpriteId,
  }
}

// ---------------- TTS 模型卡 ----------------

const DEFAULT_TTS_MODELS: TTSModelCard[] = []

export async function listTTSModels(): Promise<TTSModelCard[]> {
  return readJson<TTSModelCard[]>(paths.ttsModelsIndexFile, DEFAULT_TTS_MODELS)
}

export async function getTTSModel(id: string): Promise<TTSModelCard | null> {
  assertValidResourceId(id, 'tts-model')
  const models = await listTTSModels()
  return models.find((m) => m.id === id) ?? null
}

export async function createTTSModel(input: TTSModelCardInput): Promise<TTSModelCard> {
  const card: TTSModelCard = {
    id: genId('tts-model'),
    engine: input.engine ?? 'genie',
    name: input.name.trim(),
    characterName: input.characterName.trim(),
    onnxModelDir: input.onnxModelDir.trim(),
    refAudioPath: input.refAudioPath.trim(),
    refAudioText: input.refAudioText.trim(),
    createdAt: Date.now(),
  }
  await mutateJson<TTSModelCard[]>(paths.ttsModelsIndexFile, DEFAULT_TTS_MODELS, (list) => [...list, card])
  return card
}

export async function updateTTSModel(id: string, input: TTSModelCardInput): Promise<TTSModelCard> {
  assertValidResourceId(id, 'tts-model')
  const updated = await mutateJson<TTSModelCard[]>(paths.ttsModelsIndexFile, DEFAULT_TTS_MODELS, (list) => {
    const idx = list.findIndex((m) => m.id === id)
    if (idx === -1) throw new Error('TTS 模型卡不存在')
    const existing = list[idx]!
    const next: TTSModelCard = {
      ...existing,
      engine: input.engine ?? existing.engine ?? 'genie',
      name: input.name.trim(),
      characterName: input.characterName.trim(),
      onnxModelDir: input.onnxModelDir.trim(),
      refAudioPath: input.refAudioPath.trim(),
      refAudioText: input.refAudioText.trim(),
    }
    list[idx] = next
    return list
  })
  return updated.find((m) => m.id === id)!
}

export async function deleteTTSModel(id: string): Promise<void> {
  assertValidResourceId(id, 'tts-model')
  await mutateJson<TTSModelCard[]>(paths.ttsModelsIndexFile, DEFAULT_TTS_MODELS, (list) => list.filter((m) => m.id !== id))
}