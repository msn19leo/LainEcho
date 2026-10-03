/**
 * 记忆分层压缩：用户画像（personaDigest，常驻注入）。
 *
 * - 画像：把未吸收的 user_info 记忆交给 LLM 聚合去重，产出 200-400 字压缩稿；
 *   生成后先落为「待采纳草稿」，用户在 MemoryPanel 采纳后才常驻注入（AI 不擅自动用户记忆）；
 * - 原始记忆条目永远保留在记忆库中（压缩只影响注入侧，不删数据）；
 * - 触发：手动（设置面板「整理画像」）或自动（未吸收 user_info > 30 条，确认后后台整理）。
 * - 注：long_term 记忆不在此压缩（原编年史模块已移除）——当前量级下原始条目经向量检索/最近条注入即可，
 *   避免同一段经历以"原文+摘要"双份进 prompt 的冗余。
 */
import type { MemoryProfile } from '../../../src/types'
import { readApiKey } from '../crypto'
import { sendChatCompletion } from '../aiClient'
import { getCharacterCard, getSettings, listMemories } from '../repository'
import { normalizePerspective } from '../memoryExtraction'
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

/** 读取已采纳生效的画像（供检索器常驻注入）。personaEnabled=false = 用户暂停注入 → 视为无画像 */
export async function getActiveProfile(cardId: string): Promise<MemoryProfile | null> {
  const entry = await getProfile(cardId)
  return entry && entry.personaDigest.trim() && entry.personaEnabled !== false ? entry : null
}

/** 档案总览条目（画像 tab「全局」查看用） */
export interface ProfileOverviewEntry {
  /** 归属键：角色卡 id 或 '_global' */
  key: string
  personaDigest: string
  personaUpdatedAt: number
  /** 注入开关（false = 用户暂停注入） */
  personaEnabled: boolean
}

/** 全部档案总览：仅返回已生成画像的档案（全局查看态展示所有角色的画像） */
export async function listProfileOverview(): Promise<ProfileOverviewEntry[]> {
  const file = await mutateRead()
  return Object.values(file)
    .filter((e) => e?.personaDigest?.trim())
    .map((e) => ({
      key: e.key,
      personaDigest: e.personaDigest,
      personaUpdatedAt: e.personaUpdatedAt,
      personaEnabled: e.personaEnabled !== false,
    }))
    .sort((a, b) => b.personaUpdatedAt - a.personaUpdatedAt)
}

/** 切换画像注入开关（false = 暂停常驻注入，画像文本保留可随时恢复） */
export async function setPersonaEnabled(cardId: string, enabled: boolean): Promise<void> {
  await saveProfileEntry(cardId, (cur) => ({
    ...cur,
    key: profileKey(cardId),
    personaEnabled: enabled,
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

/** 统计未吸收的画像素材条数（自动触发判断用） */
export async function countUnconsolidated(cardId: string): Promise<{ userInfo: number }> {
  const [entry, all] = await Promise.all([getProfile(cardId), listMemories()])
  const owned = all.filter((m) => m.confirmed && (m.characterCardId === cardId || m.characterCardId === null))
  const personaIds = new Set([...(entry?.personaSourceIds ?? []), ...(entry?.pendingSourceIds ?? [])])
  return {
    userInfo: owned.filter((m) => m.category === 'user_info' && !personaIds.has(m.id)).length,
  }
}

/** 整理结果 */
export interface ConsolidateResult {
  ok: boolean
  /** 待采纳的画像草稿（null = 无新草稿） */
  draft: string | null
  error?: string
}

/**
 * 整理画像（手动触发 / 自动触发共用）：把未吸收的 user_info 记忆聚合为画像草稿，待用户采纳。
 * @param llm 由调用方注入的补全函数（走主 API，独立 prompt，非流式）
 */
export async function consolidateProfile(cardId: string, llm: ConsolidateLlm): Promise<ConsolidateResult> {
  const all = await listMemories()
  const owned = all.filter((m) => m.confirmed && (m.characterCardId === cardId || m.characterCardId === null))
  const entry = await getProfile(cardId)
  // 角色名：档案体人称归一用（卡片已删除时退化为「角色」标签，与记忆沉淀口径一致）
  const card = await getCharacterCard(cardId).catch(() => null)
  const cardName = card?.name?.trim() || '角色'

  // ---- 画像：未吸收的 user_info（排除已在 pending 中的，避免重复吸收）----
  const personaIds = new Set([...(entry?.personaSourceIds ?? []), ...(entry?.pendingSourceIds ?? [])])
  const freshUserInfo = owned.filter((m) => m.category === 'user_info' && !personaIds.has(m.id))
  if (freshUserInfo.length === 0) {
    return { ok: true, draft: null }
  }

  const errors: string[] = []

  // ---- 生成画像草稿 ----
  let draft: string | null = null
  const draftSourceIds: string[] = []
  try {
    const base = entry?.personaDigest?.trim() ?? ''
    const items = freshUserInfo.map((m, i) => `${i + 1}. ${m.content}`).join('\n')
    draft = await llm.consolidatePersona(base, items, cardName)
    // 档案体人称归一（防模型漏 obey）：对方→用户、你/我/角色/AI→角色名，与记忆沉淀同款
    draft = normalizePerspective(draft, cardName)
    draftSourceIds.push(...freshUserInfo.map((m) => m.id))
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err))
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

  if (!draft && errors.length > 0) {
    return { ok: false, draft: null, error: errors.join('；') }
  }
  return { ok: true, draft, error: errors.length > 0 ? errors.join('；') : undefined }
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

/** LLM 整理回调（由 IPC 层注入，隔离 aiClient 依赖便于测试） */
export interface ConsolidateLlm {
  /** 聚合 user_info 记忆为画像压缩稿；base 为现有画像（空串 = 首次整理）；cardName 供档案体人称约束 */
  consolidatePersona(base: string, items: string, cardName: string): Promise<string>
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
    /** 画像整理：合并同义、剔除临时信息、矛盾并列；第三人称档案体（与记忆沉淀同款口径）：
     *  用户一律写「用户」、角色一律写「{cardName}」，注入侧统一做视角替换 */
    consolidatePersona: async (base, items, cardName) => {
      const system =
        '你是记忆整理助手。把散落的用户个人信息整理成一段「用户画像」压缩稿。要求：\n' +
        '- 合并同义/重复信息；剔除临时情绪、一次性琐事；相互矛盾的信息并列保留（如「曾喜欢X，后来改为Y」）\n' +
        '- 表述视角为第三人称档案体：一律用「用户」指代用户方，需要提及角色时用「' +
        cardName +
        '」指代；严禁使用「我/你/对方/他/她/AI」等任何人称代词或标签词（含把用户写成「他/她」）\n' +
        '- 一段话 200-400 字；只输出画像文本本身，不要任何解释或格式标记'
      const user = base
        ? `现有画像：\n${base}\n\n新增信息：\n${items}\n\n请输出整理后的完整画像：`
        : `散落信息：\n${items}\n\n请输出整理后的用户画像：`
      const text = (await run(system, user)).trim()
      if (!text) throw new Error('画像整理结果为空')
      return text
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
    // 自动触发只整理画像（触发条件本就是 user_info 积压）
    const result = await consolidateProfile(cardId, llm)
    if (result.draft) {
      console.log('[memory-profile] 自动整理完成，画像草稿待采纳（user_info 未吸收 %d 条）', userInfo)
    }
  } catch (err) {
    console.warn('[memory-profile] 自动整理失败（静默）：', err instanceof Error ? err.message : err)
  }
}
