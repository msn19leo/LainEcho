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
export function assertValidResourceId(id: string, kind: 'session' | 'model' | 'card' | 'mem'): void {
  if (typeof id !== 'string' || !new RegExp(`^${kind}_[0-9a-f]{12}$`).test(id)) {
    throw new Error('非法资源 ID')
  }
}

// ---------------- 角色卡 ----------------

const DEFAULT_CARDS: CharacterCard[] = []

/**
 * 归一化角色卡：补全缺失字段，保证旧数据/部分写入的数据结构完整。
 * 新版结构废弃了 identity/consciousness，改用 description/personality/scenario 分层。
 */
function normalizeCard(raw: Partial<CharacterCard>): CharacterCard {
  const now = Date.now()
  return {
    id: raw.id ?? genId('card'),
    name: raw.name ?? '未命名角色',
    version: raw.version ?? CHARACTER_CARD_VERSION,
    description: raw.description ?? '',
    personality: raw.personality ?? '',
    scenario: raw.scenario ?? '',
    greeting: raw.greeting ?? '',
    alternateGreetings: raw.alternateGreetings ?? [],
    messageExample: raw.messageExample ?? '',
    modelId: raw.modelId ?? null,
    voiceId: raw.voiceId ?? null,
    ttsOverride: raw.ttsOverride ?? null,
    modelOverride: raw.modelOverride ?? null,
    tags: raw.tags ?? [],
    avatar: raw.avatar ?? null,
    creator: raw.creator ?? '',
    notes: raw.notes ?? '',
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
    description: input.description ?? '',
    personality: input.personality ?? '',
    scenario: input.scenario ?? '',
    greeting: input.greeting ?? '',
    alternateGreetings: input.alternateGreetings ?? [],
    messageExample: input.messageExample ?? '',
    modelId: input.modelId || null,
    voiceId: input.voiceId || null,
    ttsOverride: input.ttsOverride ?? null,
    modelOverride: input.modelOverride ?? null,
    tags: input.tags ?? [],
    avatar: input.avatar ?? null,
    creator: input.creator ?? '',
    notes: input.notes ?? '',
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
 * 把 description / personality / scenario / messageExample / 长期记忆 按顺序 join。
 * @param card 角色卡（取人设字段）
 * @param memories 全局记忆体
 */
export function buildSystemPrompt(card: CharacterCard | null, memories: MemoryItem[]): string {
  const parts: string[] = []
  if (card?.description?.trim()) parts.push(`【身份】\n${card.description.trim()}`)
  if (card?.personality?.trim()) parts.push(`【性格】\n${card.personality.trim()}`)
  if (card?.scenario?.trim()) parts.push(`【场景】\n${card.scenario.trim()}`)
  if (card?.messageExample?.trim()) parts.push(`【示例对话】\n${card.messageExample.trim()}`)
  if (memories.length > 0) {
    const memLines = memories.map((m, i) => `${i + 1}. ${m.content}`).join('\n')
    parts.push(`【长期记忆】\n${memLines}`)
  }
  return parts.join('\n\n')
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

  // 开场白注入：若角色卡配置了 greeting，写入首条 assistant 消息（含备选开场白随机选）
  const greetings = [card?.greeting, ...(card?.alternateGreetings ?? [])].filter((g): g is string => !!g?.trim())
  const initialMessages: ChatMessage[] = []
  if (greetings.length > 0) {
    const greeting = greetings[Math.floor(Math.random() * greetings.length)]!
    initialMessages.push({ role: 'assistant', content: greeting, timestamp: now })
    item.messageCount = 1
    // 更新索引的 messageCount
    await mutateJson(paths.sessionsIndexFile, DEFAULT_SESSION_INDEX, (index) => {
      const idx = index.findIndex((s) => s.id === item.id)
      if (idx !== -1) index[idx]!.messageCount = 1
      return index
    })
  }

  const detail: SessionDetail = { id: item.id, characterCardId, messages: initialMessages }
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
    return next
  })
  return {
    parameters: { ...DEFAULT_MODEL_SETTINGS.parameters, ...(result?.parameters ?? {}) },
    animation: { ...DEFAULT_MODEL_SETTINGS.animation, ...(result?.animation ?? {}) },
    view: { ...DEFAULT_MODEL_SETTINGS.view, ...(result?.view ?? {}) },
    selectedModelId: result?.selectedModelId ?? DEFAULT_MODEL_SETTINGS.selectedModelId,
  }
}