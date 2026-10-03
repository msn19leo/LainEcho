/**
 * 记忆体 CRUD IPC（按角色隔离 + 分主题 + 待确认候选 + 向量检索能力）。
 * 所有写操作（新增/更新/确认/删除）完成后：
 *  1. 广播 memory:changed，让桌宠窗/聊天窗/设置窗的「待确认」角标与列表实时同步刷新；
 *  2. 后台同步向量索引（嵌入/清理，失败静默），保证语义检索与语义去重可用；
 *  3. 确认/新增后检查自动整理阈值（未吸收 user_info 过多时后台生成画像草稿）。
 */
import { ipcMain } from 'electron'
import type { MemoryCategory } from '../../src/types'
import {
  addMemory,
  confirmMemory,
  listMemories,
  listPendingMemories,
  removeMemory,
  updateMemory,
} from '../services/repository'
import {
  compensateMissingVectors,
  removeMemoryVectors,
  semanticSearchAmong,
  syncMemoryVectors,
  testEmbedding,
} from '../services/memory/memoryVectors'
import {
  adoptProfileDraft,
  consolidateProfile,
  deletePersonaDigest,
  getProfile,
  listProfileOverview,
  maybeAutoConsolidate,
  resolveConsolidator,
  setPersonaDigest,
  setPersonaEnabled,
} from '../services/memory/profile'
import { windowManager } from '../windows/windowManager'

export function registerMemoryIpc(): void {
  ipcMain.handle('memory:list', () => listMemories())
  ipcMain.handle('memory:list-pending', () => listPendingMemories())

  /** 写操作完成后广播变更，触发所有窗口的待确认角标 / 列表刷新 */
  ipcMain.handle(
    'memory:add',
    async (_e, input: { content: string; category?: MemoryCategory; characterCardId?: string | null }) => {
      const item = await addMemory(input)
      windowManager.broadcast('memory:changed')
      // 向量同步与自动整理均为后台任务：失败静默，不阻塞添加
      void syncMemoryVectors([item])
      void maybeAutoConsolidate(item.characterCardId ?? '')
      return item
    },
  )
  ipcMain.handle('memory:update', async (_e, id: string, patch: { content?: string; category?: MemoryCategory; enabled?: boolean }) => {
    await updateMemory(id, patch)
    windowManager.broadcast('memory:changed')
    // 内容被编辑 → 原向量失效，重嵌（fire-and-forget）；开关切换不动内容，无需重嵌
    if (patch.content !== undefined) {
      void listMemories().then((items) => syncMemoryVectors(items.filter((m) => m.id === id)))
    }
  })
  ipcMain.handle('memory:confirm', async (_e, id: string) => {
    // 先取条目归属（确认后用于自动整理阈值检查）
    const target = (await listMemories()).find((m) => m.id === id)
    await confirmMemory(id)
    windowManager.broadcast('memory:changed')
    // 候选通常在沉淀时已带向量；确认后补同步兜底
    void listMemories().then((items) => syncMemoryVectors(items.filter((m) => m.id === id)))
    void maybeAutoConsolidate(target?.characterCardId ?? '')
  })
  ipcMain.handle('memory:remove', async (_e, id: string) => {
    await removeMemory(id)
    windowManager.broadcast('memory:changed')
    void removeMemoryVectors([id])
  })

  // ---------------- 向量检索 ----------------

  /** 语义搜索已确认记忆（MemoryPanel 搜索框；嵌入不可用时前端自行回退本地过滤） */
  ipcMain.handle('memory:semantic-search', async (_e, params: { query: string; topK?: number }) => {
    const { query, topK = 10 } = params ?? {}
    if (typeof query !== 'string' || !query.trim()) return []
    const all = await listMemories()
    const candidates = all.filter((m) => m.confirmed)
    return semanticSearchAmong(query.trim(), candidates, topK)
  })

  /** 手动重嵌全部已确认记忆（换嵌入模型 / 大量缺失时使用） */
  ipcMain.handle('memory:reembed-all', async () => {
    const result = await compensateMissingVectors()
    return result ?? { embedded: 0, failed: 0, unavailable: true }
  })

  /** 测试嵌入配置连通性（地址/模型/独立 Key），成功返回向量维度 */
  ipcMain.handle('memory:test-embedding', () => testEmbedding())

  // ---------------- 画像（分层压缩） ----------------

  ipcMain.handle('memory:get-profile', async (_e, params: { cardId?: string | null }) => {
    return getProfile(params?.cardId ?? '')
  })

  /** 档案总览（画像 tab「全局」查看态）：所有已生成画像的档案 */
  ipcMain.handle('memory:get-profile-overview', () => listProfileOverview())

  /** 触发画像整理（聚合「用户信息」类记忆为草稿，待采纳）；未配置 API 时返回可读错误 */
  ipcMain.handle('memory:consolidate-profile', async (_e, params: { cardId?: string | null }) => {
    const cardId = params?.cardId ?? ''
    const llm = await resolveConsolidator()
    if (!llm) return { ok: false, draft: null, error: '未配置 API（baseURL/model/Key），无法整理画像' }
    const result = await consolidateProfile(cardId, llm)
    if (result.draft) windowManager.broadcast('memory:changed')
    return result
  })

  /** 切换画像注入开关（false = 暂停常驻注入，画像保留） */
  ipcMain.handle('memory:set-profile-enabled', async (_e, params: { cardId?: string | null; enabled: boolean }) => {
    await setPersonaEnabled(params?.cardId ?? '', params?.enabled !== false)
    windowManager.broadcast('memory:changed')
  })

  /** 采纳/放弃画像草稿（采纳后常驻注入 system prompt） */
  ipcMain.handle('memory:adopt-profile', async (_e, params: { cardId?: string | null; adopt: boolean }) => {
    await adoptProfileDraft(params?.cardId ?? '', params?.adopt === true)
    windowManager.broadcast('memory:changed')
  })

  /** 编辑已生效画像文本（空串视为删除画像） */
  ipcMain.handle('memory:update-profile-digest', async (_e, params: { cardId?: string | null; text: string }) => {
    const text = params?.text ?? ''
    if (!text.trim()) {
      await deletePersonaDigest(params?.cardId ?? '')
    } else {
      await setPersonaDigest(params?.cardId ?? '', text)
    }
    windowManager.broadcast('memory:changed')
  })

  /** 删除已生效画像（来源记忆恢复"未吸收"，可重新整理生成） */
  ipcMain.handle('memory:delete-profile-digest', async (_e, params: { cardId?: string | null }) => {
    await deletePersonaDigest(params?.cardId ?? '')
    windowManager.broadcast('memory:changed')
  })
}
