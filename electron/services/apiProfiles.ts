/**
 * API 服务商档案（全局档案库，2026-10-19）：
 * 把「API 地址 + 模型名 + Key」打包为可复用、可切换的配置档案。主/辅/视觉/嵌入四类
 * 模型各自通过 activeXxxProfileId 引用一个档案，仅手动切换（无自动故障转移）。
 *
 * 职责：
 *  - 运行时唯一配置解析入口 resolveProfile(type)：档案 id → 解密 Key → 生效三元组；
 *    替代旧版散落在各处的 getSettings() + readApiKey()/readSecret() 拼装
 *  - 档案 CRUD（upsertProfile/deleteProfile），供设置窗 IPC 调用
 *  - 一次性启动迁移 migrateApiProfiles()：旧单配置字段 + 各独立 Key 文件 → 首批档案
 *
 * 安全边界：Key 密文按档案隔离落盘（secure/keys/<profileId>.enc），明文仅存在于
 * 主进程内存；profileId 拼入文件路径，必须先过格式校验防路径穿越。
 */
import type { ApiProfile, AppSettings } from '../../src/types'
import { decryptSecret, readSecret, saveSecret } from './crypto'
import { genId, getSettings, saveSettings } from './repository'
import { paths, readBuffer, fileExists, deleteFile } from './storage'

/** 档案 id 合法格式（会拼入 Key 密文文件路径，防路径穿越） */
const PROFILE_ID_RE = /^prof_[0-9a-f]{12}$/

/** 档案被哪类模型引用 */
export type ProfileType = 'main' | 'aux' | 'vision' | 'embedding'

/** 运行时生效的 LLM 配置三元组（主/辅模型共用） */
export interface ResolvedLlmConfig {
  model: string
  baseURL: string
  apiKey: string
}

/** 各类型在 AppSettings 中对应的激活档案字段名 */
const ACTIVE_FIELD: Record<ProfileType, 'activeMainProfileId' | 'activeAuxProfileId' | 'activeVisionProfileId' | 'activeEmbeddingProfileId'> = {
  main: 'activeMainProfileId',
  aux: 'activeAuxProfileId',
  vision: 'activeVisionProfileId',
  embedding: 'activeEmbeddingProfileId',
}

/** 各类型的展示名（错误信息用） */
const TYPE_LABEL: Record<ProfileType, string> = {
  main: '主模型',
  aux: '辅助模型',
  vision: '视觉模型',
  embedding: '嵌入模型',
}

/** 指定档案的 Key 是否已配置（掩码回显用，不返回明文） */
export async function hasProfileKey(profileId: string): Promise<boolean> {
  if (!PROFILE_ID_RE.test(profileId)) return false
  return (await readSecret(paths.profileKeyFile(profileId))) !== null
}

/**
 * 运行时配置解析唯一入口：按类型取激活档案并解密其 Key。
 * @returns 地址/模型/Key 任一缺失、或该类型未激活档案时返回 null（调用方自行回落/跳过/报错）
 */
export async function resolveProfile(type: ProfileType): Promise<ResolvedLlmConfig | null> {
  const settings = await getSettings()
  const activeId = settings[ACTIVE_FIELD[type]]
  if (!activeId) return null
  const profile = (settings.profiles ?? []).find((p) => p.id === activeId)
  if (!profile) return null
  const baseURL = profile.baseURL.trim()
  const model = profile.model.trim()
  const apiKey = await readSecret(paths.profileKeyFile(profile.id)).catch(() => null)
  if (!baseURL || !model || !apiKey) return null
  return { model, baseURL, apiKey }
}

/**
 * 应用档案列表变更并落盘（读取当前档案库 → 应用变更 → 走 saveSettings 白名单整体写回）。
 * 读改写不在 mutateJson 串行队列内，但档案编辑仅来自设置窗单人操作，并发窗口可忽略。
 */
async function saveProfiles(mutate: (profiles: ApiProfile[]) => ApiProfile[]): Promise<void> {
  const settings = await getSettings()
  await saveSettings({ profiles: mutate([...(settings.profiles ?? [])]) })
}

/**
 * 新建/更新档案（upsert，按 id 缺省新建）。
 * @param input.key 非空时保存该档案的 API Key；undefined = 保持原 Key 不变
 * @returns 落盘后的档案（含传输态 hasKey）
 */
export async function upsertProfile(input: {
  id?: string
  name: string
  baseURL: string
  model: string
  key?: string
}): Promise<ApiProfile> {
  const name = input.name.trim().slice(0, 40) || '未命名档案'
  const baseURL = input.baseURL.trim()
  const model = input.model.trim()
  const profileId = input.id
  if (profileId !== undefined && !PROFILE_ID_RE.test(profileId)) throw new Error('非法档案 ID')

  if (!profileId) {
    // 新建：genId 与其他资源同一套生成器（前缀 prof_）
    const created: ApiProfile = { id: genId('prof'), name, baseURL, model }
    await saveProfiles((profiles) => [...profiles, created])
    if (input.key?.trim()) await saveSecret(paths.profileKeyFile(created.id), input.key.trim())
    return { ...created, hasKey: await hasProfileKey(created.id) }
  }

  // 更新：仅覆写名称/地址/模型三字段
  await saveProfiles((profiles) => profiles.map((p) => (p.id === profileId ? { ...p, name, baseURL, model } : p)))
  if (input.key?.trim()) await saveSecret(paths.profileKeyFile(profileId), input.key.trim())
  return { id: profileId, name, baseURL, model, hasKey: await hasProfileKey(profileId) }
}

/**
 * 删除档案：正在被任一类模型引用时抛错（需先在对应类型切换到其他档案）；
 * 连同其 Key 密文文件一并清除。
 */
export async function deleteProfile(id: string): Promise<void> {
  if (!PROFILE_ID_RE.test(id)) throw new Error('非法档案 ID')
  const settings = await getSettings()
  const refBy = (['main', 'aux', 'vision', 'embedding'] as const).filter((t) => settings[ACTIVE_FIELD[t]] === id)
  if (refBy.length > 0) {
    throw new Error(`该档案正在被${refBy.map((t) => TYPE_LABEL[t]).join('、')}使用，请先切换到其他档案`)
  }
  await saveProfiles((profiles) => profiles.filter((p) => p.id !== id))
  if (await fileExists(paths.profileKeyFile(id))) {
    await deleteFile(paths.profileKeyFile(id)).catch(() => {})
  }
}

/**
 * 拉取服务商档案的可用模型列表（OpenAI 兼容 GET {baseURL}/models）。
 * 安全边界与档案体系一致：Key 明文不出主进程——编辑已有档案时按 profileId 读存储密钥，
 * 新建未保存档案时才使用表单现值。
 * @returns 模型 id 列表（去重 + 字典序）；任何失败直接 throw（渲染端 toast 展示）
 */
export async function listProfileModels(input: { profileId?: string; baseURL?: string; key?: string }): Promise<string[]> {
  let baseURL = input.baseURL?.trim() ?? ''
  let apiKey = input.key?.trim() ?? ''
  if (input.profileId) {
    if (!PROFILE_ID_RE.test(input.profileId)) throw new Error('非法档案 ID')
    const settings = await getSettings()
    const profile = (settings.profiles ?? []).find((p) => p.id === input.profileId)
    if (!profile) throw new Error('档案不存在')
    baseURL = profile.baseURL.trim()
    if (!apiKey) apiKey = (await readSecret(paths.profileKeyFile(input.profileId)).catch(() => null)) ?? ''
  }
  if (!baseURL) throw new Error('请先填写 API 地址（baseURL）')
  const url = `${baseURL.replace(/\/+$/, '')}/models`
  let res: Response
  try {
    res = await fetch(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    throw new Error(`无法访问 ${url}：${err instanceof Error ? err.message : String(err)}`)
  }
  if (!res.ok) throw new Error(`获取模型列表失败（HTTP ${res.status}）`)
  const json: unknown = await res.json().catch(() => null)
  // OpenAI 兼容形态 { data: [{ id }] }；容错 { models: [...] } 与纯字符串数组
  const rows: unknown[] = Array.isArray(json)
    ? json
    : typeof json === 'object' && json !== null
      ? ((json as { data?: unknown[] }).data ?? (json as { models?: unknown[] }).models ?? [])
      : []
  const ids = rows
    .map((r) => (typeof r === 'string' ? r : typeof r === 'object' && r !== null ? (r as { id?: unknown }).id : null))
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    .map((v) => v.trim())
  if (ids.length === 0) throw new Error('接口返回了空模型列表（该服务可能不支持 /models 端点）')
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b))
}

/**
 * 一次性启动迁移（幂等）：旧单配置字段 + 各独立 Key 文件 → 首批档案并激活。
 * 档案库已存在（profiles 非空）时直接返回，不重复迁移。
 * 旧字段/旧 Key 文件保留不删（迁移失败可重来；旧字段已废弃、运行时不再读取）。
 */
export async function migrateApiProfiles(): Promise<void> {
  try {
    const settings = await getSettings()
    if ((settings.profiles ?? []).length > 0) return

    const profiles: ApiProfile[] = []
    const patch: Partial<AppSettings> = {}

    // 主模型：baseURL/model + apiKey.enc → 「默认」档案（迁移前老用户的唯一配置）
    if (settings.baseURL.trim() || settings.model.trim()) {
      const p: ApiProfile = { id: genId('prof'), name: '默认', baseURL: settings.baseURL.trim(), model: settings.model.trim() }
      p.hasKey = await copyLegacyKey(paths.apiKeyFile, p.id)
      profiles.push(p)
      patch.activeMainProfileId = p.id
    }

    // 辅助模型：translationXxx + translationApiKey.enc（旧语义：地址/模型任一非空即启用；
    // 缺省字段回落旧主模型配置，与旧 resolveAuxLlmConfig 口径一致）
    if (settings.translationBaseURL.trim() || settings.translationModel.trim()) {
      const p: ApiProfile = {
        id: genId('prof'),
        name: '辅助模型',
        baseURL: settings.translationBaseURL.trim() || settings.baseURL.trim(),
        model: settings.translationModel.trim() || settings.model.trim(),
      }
      p.hasKey = await copyLegacyKey(paths.translationApiKeyFile, p.id)
      profiles.push(p)
      patch.activeAuxProfileId = p.id
    }

    // 视觉模型：visionXxx + visionApiKey.enc（旧语义：独立必填不回落）
    if (settings.visionBaseURL.trim() && settings.visionModel.trim()) {
      const p: ApiProfile = { id: genId('prof'), name: '视觉模型', baseURL: settings.visionBaseURL.trim(), model: settings.visionModel.trim() }
      p.hasKey = await copyLegacyKey(paths.visionApiKeyFile, p.id)
      profiles.push(p)
      patch.activeVisionProfileId = p.id
    }

    // 嵌入模型：embeddingXxx + embeddingApiKey.enc
    if (settings.embeddingBaseURL.trim() && settings.embeddingModel.trim()) {
      const p: ApiProfile = { id: genId('prof'), name: '嵌入模型', baseURL: settings.embeddingBaseURL.trim(), model: settings.embeddingModel.trim() }
      p.hasKey = await copyLegacyKey(paths.embeddingApiKeyFile, p.id)
      profiles.push(p)
      patch.activeEmbeddingProfileId = p.id
    }

    if (profiles.length === 0) return
    // hasKey 是传输态字段，落盘前剥离
    await saveSettings({ ...patch, profiles: profiles.map(({ hasKey: _drop, ...p }) => p) })
    console.log('[migrate] API 档案迁移完成：%d 个档案', profiles.length)
  } catch (err) {
    console.error('[migrate] API 档案迁移失败（旧配置保留，可在设置中手动配置档案）', err)
  }
}

/** 把旧版独立 Key 密文解密后重加密为档案 Key 文件；失败返回 false（档案仍创建，Key 待重填） */
async function copyLegacyKey(legacyFile: string, profileId: string): Promise<boolean> {
  try {
    if (!(await fileExists(legacyFile))) return false
    const encrypted = await readBuffer(legacyFile)
    if (!encrypted) return false
    const plain = decryptSecret(encrypted)
    await saveSecret(paths.profileKeyFile(profileId), plain)
    console.log('[migrate] 旧 Key 已迁移至档案 %s', profileId)
    return true
  } catch (err) {
    console.warn('[migrate] 旧 Key 迁移失败（档案已建，需重填 Key）：%s', err instanceof Error ? err.message : err)
    return false
  }
}
