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
  MemoryCategory,
  MemoryItem,
  ModelSettings,
  SessionDetail,
  SessionIndexItem,
  TTSModelCard,
  TTSModelCardInput,
} from '../../src/types'
import { CHARACTER_CARD_VERSION } from '../../src/types'
import { paths, readJson, writeJson, mutateJson, deleteFile, fileExists } from './storage'
import { buildSystemParts } from './prompt/sections'
import { composeSystemPrompt } from './prompt/composer'

// 提示词段落符号已平移至 services/prompt/（纯函数模块），此处保留旧引用路径的导出
export { EMOTION_PROMPT, PARAGRAPH_PROMPT, NARRATION_PROMPT, buildPersonaSections, normalizeMemoryPerspective } from './prompt/sections'

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
    genieOverride: raw.genieOverride ?? null,
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
    voiceMode: input.voiceMode ?? (input.voiceId ? 'mimo' : 'none'),
    genieOverride: input.genieOverride ?? null,
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

/** 归一化记忆条目：补齐 category/characterCardId/confirmed/sourceSessionId 缺省值（兼容旧数据） */
function normalizeMemory(raw?: Partial<MemoryItem> | null): MemoryItem {
  return {
    id: raw?.id ?? genId('mem'),
    content: raw?.content ?? '',
    createdAt: raw?.createdAt ?? Date.now(),
    category: raw?.category ?? 'long_term',
    characterCardId: raw?.characterCardId ?? null,
    confirmed: raw?.confirmed ?? true,
    sourceSessionId: raw?.sourceSessionId ?? null,
  }
}

export async function listMemories(): Promise<MemoryItem[]> {
  const items = await readJson<Partial<MemoryItem>[]>(paths.memoryFile, DEFAULT_MEMORIES)
  return items.map(normalizeMemory)
}

/**
 * 列出指定角色的已确认记忆（含全局背景 characterCardId=null，兼容旧数据），
 * 用于 system prompt 注入；按创建时间倒序后截取前 limit 条。
 */
export async function listConfirmedMemories(cardId: string, limit?: number): Promise<MemoryItem[]> {
  const items = await listMemories()
  const owned = items.filter((m) => m.confirmed && (m.characterCardId === cardId || m.characterCardId === null))
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
  }
  await mutateJson(paths.memoryFile, DEFAULT_MEMORIES, (items) => [item, ...items])
  return item
}

/** 更新记忆内容或分类（部分更新） */
export async function updateMemory(id: string, patch: { content?: string; category?: MemoryCategory }): Promise<void> {
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
 * 分段组装 system prompt（PromptComposer 薄包装）。
 * 段落构造与文本内容全部在 services/prompt/ 中维护（纯函数，可金样测试）；
 * 此处只负责桥接数据层（卡片/记忆）与组装器，并为旧引用保留导出。
 *
 * @param card 角色卡（取人设字段）
 * @param memories 参与注入的记忆列表（来源由检索器决定：向量检索 or 最近 N 条）
 * @param userName 你的称呼（%player% 占位符替换值）
 * @param profileDigest 用户画像压缩稿（M4 分层压缩产物；缺省不注入）
 * @param proactiveHint 是否注入主动搭话常驻说明（enableProactive 开启时为 true）
 */
export function buildSystemPrompt(
  card: CharacterCard | null,
  memories: MemoryItem[],
  userName = '用户',
  profileDigest?: string | null,
  proactiveHint?: boolean,
): string {
  const sections = buildSystemParts(card, memories, profileDigest, proactiveHint)
  return composeSystemPrompt(sections, { userName }).text
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
  // 上下文管理（A1/A2）：默认 32k 窗口 + 开启自动摘要
  contextWindowTokens: 32768,
  enableAutoCompact: true,
  // 记忆自动沉淀：默认开启（会话结束后台抽取候选记忆，需用户确认后生效）
  enableMemoryExtraction: true,
  // 主动搭话：默认关闭（调度循环每 30s 一轮；需用户显式开启）
  enableProactive: false,
  // 屏幕感知：默认关闭（与主动搭话级联；开启后搭话前先感知屏幕内容）
  enableScreenSense: false,
  // 每日主动搭话上限（用户回复后重置计数）
  maxProactivePerDay: 3,
  // 话题搭话旁白由 LLM 随机生成（每次搭话多一次小调用；失败回退固定模板）
  proactiveLlmNarration: true,
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
  // 语义去重相似度阈值（cos ≥ 阈值视为重复）
  memoryDedupThreshold: 0.92,
  // 你的称呼：%player% 占位符的替换值
  userName: '用户',
  // 文字显示速度：0-100 速度档（越大越快；0=即时显示）
  textSpeed: 80,
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
    if (patch.contextWindowTokens !== undefined) next.contextWindowTokens = patch.contextWindowTokens
    if (patch.enableAutoCompact !== undefined) next.enableAutoCompact = patch.enableAutoCompact
    if (patch.enableMemoryExtraction !== undefined) next.enableMemoryExtraction = patch.enableMemoryExtraction
    if (patch.enableProactive !== undefined) next.enableProactive = patch.enableProactive
    if (patch.enableScreenSense !== undefined) next.enableScreenSense = patch.enableScreenSense
    if (patch.maxProactivePerDay !== undefined) next.maxProactivePerDay = Math.max(0, Math.floor(patch.maxProactivePerDay))
    if (patch.proactiveLlmNarration !== undefined) next.proactiveLlmNarration = patch.proactiveLlmNarration
    if (patch.quietHours !== undefined) next.quietHours = patch.quietHours
    if (patch.visionBaseURL !== undefined) next.visionBaseURL = patch.visionBaseURL
    if (patch.visionModel !== undefined) next.visionModel = patch.visionModel
    if (patch.memoryRetrievalEnabled !== undefined) next.memoryRetrievalEnabled = patch.memoryRetrievalEnabled
    if (patch.embeddingBaseURL !== undefined) next.embeddingBaseURL = patch.embeddingBaseURL
    if (patch.embeddingModel !== undefined) next.embeddingModel = patch.embeddingModel
    if (patch.memoryDedupThreshold !== undefined) next.memoryDedupThreshold = patch.memoryDedupThreshold
    if (patch.userName !== undefined) next.userName = patch.userName
    if (patch.textSpeed !== undefined) next.textSpeed = patch.textSpeed
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