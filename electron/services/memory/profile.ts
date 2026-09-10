/**
 * 记忆分层压缩：用户画像（personaDigest，常驻注入）+ 编年史（chronicle，长期经历滚动摘要）。
 *
 * - 画像：把未吸收的 user_info 记忆交给 LLM 聚合去重，产出 200-400 字压缩稿；
 *   生成后先落为「待采纳草稿」，用户在 MemoryPanel 采纳后才常驻注入（AI 不擅自动用户记忆）；
 * - 编年史：把未吸收的 long_term 记忆按 LLM 摘要为若干条目，直接生效（仅作为检索候选与兜底注入）；
 * - 原始记忆条目永远保留在记忆库中（压缩只影响注入侧，不删数据）；
 * - 触发：手动（设置面板「整理画像与编年史」）或自动（未吸收 user_info > 30 条，确认后后台整理）。
 */
import type { ChronicleEntry, MemoryProfile } from '../../../src/types'
import { readApiKey } from '../crypto'
import { sendChatCompletion } from '../aiClient'
import { getSettings, listMemories } from '../repository'
import { paths, readJson, mutateJson } from '../storage'

/** 触发自动整理的未吸收 user_info 条数阈值 */
export const AUTO_CONSOLIDATE_THRESHOLD = 30
/** 画像草稿输出 token 上限（独立请求，与主对话 JSON 契约隔离） */
const CONSOLIDATE_MAX_TOKENS = 2048

/** 索引文件结构：按归属键（角色卡 id 或 '_global'）隔离 */
type ProfileFile = Record<string, MemoryProfile>

const EMPTY_PROFILE: MemoryProfile = {
  key: '',
  personaDigest: '',
  personaUpdatedAt: 0,
  personaSourceIds: [],
  pendingDigest: null,
  pendingSourceIds: [],
  chronicle: [],
  chronicleSourceIds: [],
  lastConsolidatedAt: 0,
}

/** 归属键：cardId 为空串时归入全局（与记忆的 characterCardId=null 口径对应） */
function profileKey(cardId: string): string {
  return cardId || '_global'
}

/** 读取指定角色的档案（不存在返回 null） */
export async function getProfile(cardId: string): Promise<MemoryProfile | null> {
  const file = await mutateRead()
  const entry = file[profileKey(cardId)]
  return entry ?? null
}

/** 读取已采纳生效的画像（供检索器常驻注入） */
export async function getActiveProfile(cardId: string): Promise<MemoryProfile | null> {
  const entry = await getProfile(cardId)
  return entry && entry.personaDigest.trim() ? entry : null
}

/**
 * 取最近 N 条编年史条目，包装为伪 MemoryItem 参与注入（long_term 段落内编号展示）。
 * id 加 `chron:` 前缀，与真实记忆 id（mem_ 前缀）区分。
 */
export async function getRecentChronicleItems(cardId: string, count: number) {
  const entry = await getProfile(cardId)
  if (!entry || count <= 0) return []
  const recent = [...entry.chronicle].sort((a, b) => b.createdAt - a.createdAt).slice(0, count)
  return recent.map((c) => ({
    id: `chron:${c.id}`,
    content: c.text,
    createdAt: c.createdAt,
    category: 'long_term' as const,
    characterCardId: cardId || null,
    confirmed: true,
  }))
}

/** 读整份档案文件（readJson 即可，写入统一走 saveProfileEntry 的串行队列） */
function mutateRead(): Promise<ProfileFile> {
  return readJson<ProfileFile>(paths.memoryProfileFile, {})
}

/** 保存单个角色的档案条目（串行队列内读-改-写） */
async function saveProfileEntry(cardId: string, patch: (entry: MemoryProfile) => MemoryProfile): Promise<void> {
  await mutateJson<ProfileFile>(paths.memoryProfileFile, {}, (file) => {
    const key = profileKey(cardId)
    const current = file[key] ?? { ...EMPTY_PROFILE, key }
    return { ...file, [key]: patch(current) }
  })
}

/** 统计未吸收的画像/编年史素材条数（自动触发判断用） */
export async function countUnconsolidated(cardId: string): Promise<{ userInfo: number; longTerm: number }> {
  const [entry, all] = await Promise.all([getProfile(cardId), listMemories()])
  const owned = all.filter((m) => m.confirmed && (m.characterCardId === cardId || m.characterCardId === null))
  const personaIds = new Set([...(entry?.personaSourceIds ?? []), ...(entry?.pendingSourceIds ?? [])])
  const chronicleIds = new Set(entry?.chronicleSourceIds ?? [])
  return {
    userInfo: owned.filter((m) => m.category === 'user_info' && !personaIds.has(m.id)).length,
    longTerm: owned.filter((m) => m.category === 'long_term' && !chronicleIds.has(m.id)).length,
  }
}

/** 整理结果 */
export interface ConsolidateResult {
  ok: boolean
  /** 待采纳的画像草稿（null = 无新草稿） */
  draft: string | null
  /** 本次编年史新增条数 */
  chronicleAdded: number
  error?: string
}

/**
 * 整理画像与编年史（手动触发 / 自动触发共用）。
 * 画像草稿写入 pendingDigest，等用户采纳；编年史条目直接生效。
 * @param llm 由调用方注入的补全函数（走主 API，独立 prompt，非流式）
 */
export async function consolidateProfile(cardId: string, llm: ConsolidateLlm): Promise<ConsolidateResult> {
  const all = await listMemories()
  const owned = all.filter((m) => m.confirmed && (m.characterCardId === cardId || m.characterCardId === null))
  const entry = await getProfile(cardId)

  // ---- 画像：未吸收的 user_info（排除已在 pending 中的，避免重复吸收）----
  const personaIds = new Set([...(entry?.personaSourceIds ?? []), ...(entry?.pendingSourceIds ?? [])])
  const freshUserInfo = owned.filter((m) => m.category === 'user_info' && !personaIds.has(m.id))

  // ---- 编年史：未吸收的 long_term ----
  const chronicleIds = new Set(entry?.chronicleSourceIds ?? [])
  const freshLongTerm = owned.filter((m) => m.category === 'long_term' && !chronicleIds.has(m.id))

  if (freshUserInfo.length === 0 && freshLongTerm.length === 0) {
    return { ok: true, draft: null, chronicleAdded: 0 }
  }

  let draft: string | null = null
  const draftSourceIds: string[] = []
  let chronicleAdded = 0
  const errors: string[] = []

  // ---- 生成画像草稿 ----
  if (freshUserInfo.length > 0) {
    try {
      const base = entry?.personaDigest?.trim() ?? ''
      const items = freshUserInfo.map((m, i) => `${i + 1}. ${m.content}`).join('\n')
      draft = await llm.consolidatePersona(base, items)
      draftSourceIds.push(...freshUserInfo.map((m) => m.id))
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }

  // ---- 生成编年史条目 ----
  if (freshLongTerm.length > 0) {
    try {
      const items = freshLongTerm
        .map((m) => `- ${new Date(m.createdAt).toLocaleDateString('zh-CN')} ${m.content}`)
        .join('\n')
      const texts = await llm.consolidateChronicle(items)
      if (texts.length > 0) {
        const now = Date.now()
        const newEntries: ChronicleEntry[] = texts.map((text, i) => ({
          id: `ch_${(now + i).toString(36)}`,
          text,
          createdAt: now,
        }))
        await saveProfileEntry(cardId, (cur) => ({
          ...cur,
          key: profileKey(cardId),
          chronicle: [...cur.chronicle, ...newEntries],
          chronicleSourceIds: [...cur.chronicleSourceIds, ...freshLongTerm.map((m) => m.id)],
          lastConsolidatedAt: now,
        }))
        chronicleAdded = newEntries.length
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }

  // ---- 画像草稿落盘（待采纳）----
  if (draft) {
    await saveProfileEntry(cardId, (cur) => ({
      ...cur,
      key: profileKey(cardId),
      pendingDigest: draft!,
      pendingSourceIds: draftSourceIds,
      lastConsolidatedAt: Date.now(),
    }))
  }

  if (!draft && chronicleAdded === 0 && errors.length > 0) {
    return { ok: false, draft: null, chronicleAdded: 0, error: errors.join('；') }
  }
  return { ok: true, draft, chronicleAdded, error: errors.length > 0 ? errors.join('；') : undefined }
}

/** 采纳画像草稿：pendingDigest → personaDigest（此后常驻注入） */
export async function adoptProfileDraft(cardId: string, adopt: boolean): Promise<void> {
  await saveProfileEntry(cardId, (cur) => {
    if (adopt && cur.pendingDigest?.trim()) {
      return {
        ...cur,
        personaDigest: cur.pendingDigest.trim(),
        personaUpdatedAt: Date.now(),
        personaSourceIds: [...cur.personaSourceIds, ...cur.pendingSourceIds],
        pendingDigest: null,
        pendingSourceIds: [],
      }
    }
    // 放弃草稿：仅清空 pending，来源记忆回到"未吸收"（下次整理会再次纳入）
    return { ...cur, pendingDigest: null, pendingSourceIds: [] }
  })
}

/**
 * 编辑已生效画像文本（面板手动修改整理结果）。
 * 仅改文本，来源记忆保持"已吸收"——避免下次整理把同样内容重复收编。
 */
export async function setPersonaDigest(cardId: string, text: string): Promise<void> {
  await saveProfileEntry(cardId, (cur) => ({
    ...cur,
    key: profileKey(cardId),
    personaDigest: text.trim(),
    personaUpdatedAt: text.trim() ? Date.now() : cur.personaUpdatedAt,
  }))
}

/**
 * 删除已生效画像（清空常驻注入）。
 * 来源记忆全部恢复"未吸收"——否则删掉画像后「整理画像」无素材可用，形成死局；
 * 恢复后下次整理会基于原始记忆重新生成完整画像。
 */
export async function deletePersonaDigest(cardId: string): Promise<void> {
  await saveProfileEntry(cardId, (cur) => ({
    ...cur,
    key: profileKey(cardId),
    personaDigest: '',
    personaUpdatedAt: 0,
    personaSourceIds: [],
  }))
}

/** 编辑编年史条目文本（仅改文本，不影响来源标记） */
export async function updateChronicleEntry(cardId: string, entryId: string, text: string): Promise<void> {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('编年史条目内容不能为空')
  await saveProfileEntry(cardId, (cur) => ({
    ...cur,
    chronicle: cur.chronicle.map((e) => (e.id === entryId ? { ...e, text: trimmed } : e)),
  }))
}

/**
 * 删除编年史条目。
 * 来源记忆保持"已吸收"（原始记忆本就仍在记忆库中参与检索/注入，无信息丢失）；
 * 仅移除这条摘要本身。
 */
export async function deleteChronicleEntry(cardId: string, entryId: string): Promise<void> {
  await saveProfileEntry(cardId, (cur) => ({
    ...cur,
    chronicle: cur.chronicle.filter((e) => e.id !== entryId),
  }))
}

/** LLM 整理回调（由 IPC 层注入，隔离 aiClient 依赖便于测试） */
export interface ConsolidateLlm {
  /** 聚合 user_info 记忆为画像压缩稿；base 为现有画像（空串 = 首次整理） */
  consolidatePersona(base: string, items: string): Promise<string>
  /** 把 long_term 记忆摘要为编年史条目（≤5 条，每条 ≤100 字） */
  consolidateChronicle(items: string): Promise<string[]>
}

/** 组装 LLM 整理回调（走主 API 的 chat/completions，独立上下文） */
export function createConsolidator(cfg: { model: string; baseURL: string; apiKey: string }): ConsolidateLlm {
  const run = async (system: string, user: string): Promise<string> => {
    const raw = await sendChatCompletion(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      { model: cfg.model, baseURL: cfg.baseURL, apiKey: cfg.apiKey, temperature: 0.3, stream: false, maxTokensOverride: CONSOLIDATE_MAX_TOKENS },
    )
    return raw ?? ''
  }
  return {
    /** 画像整理：合并同义、剔除临时信息、矛盾并列，统一「对方/你」人称 */
    consolidatePersona: async (base, items) => {
      const system =
        '你是记忆整理助手。把散落的用户个人信息整理成一段「用户画像」压缩稿。要求：\n' +
        '- 合并同义/重复信息；剔除临时情绪、一次性琐事；相互矛盾的信息并列保留（如「曾喜欢X，后来改为Y」）\n' +
        '- 表述统一用「对方」指代用户；一段话 200-400 字；只输出画像文本本身，不要任何解释或格式标记'
      const user = base
        ? `现有画像：\n${base}\n\n新增信息：\n${items}\n\n请输出整理后的完整画像：`
        : `散落信息：\n${items}\n\n请输出整理后的用户画像：`
      const text = (await run(system, user)).trim()
      if (!text) throw new Error('画像整理结果为空')
      return text
    },
    /** 编年史整理：按时间脉络归纳为 ≤5 条摘要 */
    consolidateChronicle: async (items) => {
      const system =
        '你是记忆整理助手。把「长期经历」类记忆按时间脉络归纳为编年史条目。要求：\n' +
        '- 最多 5 条，每条不超过 100 字，保留对后续互动有价值的事件\n' +
        '- 只输出 JSON：{"entries":[{"text":"..."}]}，不要 markdown 代码块、不要解释'
      const raw = await run(system, `经历记录：\n${items}\n\n请输出编年史：`)
      const block = raw.replace(/```json\s*/gi, '').replace(/```/g, '')
      const start = block.indexOf('{')
      const end = block.lastIndexOf('}')
      if (start === -1 || end <= start) return []
      try {
        const parsed = JSON.parse(block.slice(start, end + 1)) as { entries?: Array<{ text?: string }> }
        return (parsed?.entries ?? [])
          .map((e) => (typeof e?.text === 'string' ? e.text.trim() : ''))
          .filter((t) => t.length > 0)
          .slice(0, 5)
      } catch {
        return []
      }
    },
  }
}

/** 从主进程设置组装整理回调（未配置 API 时返回 null） */
export async function resolveConsolidator(): Promise<ConsolidateLlm | null> {
  const settings = await getSettings()
  const apiKey = await readApiKey().catch(() => null)
  if (!apiKey || !settings.baseURL.trim() || !settings.model.trim()) return null
  return createConsolidator({ model: settings.model, baseURL: settings.baseURL, apiKey })
}

/** 确认/新增记忆后的自动整理触发判断（超过阈值才发起，避免频繁调用） */
export async function maybeAutoConsolidate(cardId: string): Promise<void> {
  try {
    const { userInfo } = await countUnconsolidated(cardId)
    if (userInfo <= AUTO_CONSOLIDATE_THRESHOLD) return
    const llm = await resolveConsolidator()
    if (!llm) return
    const result = await consolidateProfile(cardId, llm)
    if (result.draft) {
      console.log('[memory-profile] 自动整理完成，画像草稿待采纳（user_info 未吸收 %d 条）', userInfo)
    }
  } catch (err) {
    console.warn('[memory-profile] 自动整理失败（静默）：', err instanceof Error ? err.message : err)
  }
}
