/**
 * 记忆体 CRUD IPC（按角色隔离 + 分主题 + 待确认候选）。
 * 所有写操作（新增/更新/确认/删除）完成后广播 memory:changed，
 * 让桌宠窗/聊天窗/设置窗的「待确认」角标与列表实时同步刷新。
 * 自动沉淀（memoryExtraction）产生的候选也走同一广播。
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
      return item
    },
  )
  ipcMain.handle('memory:update', async (_e, id: string, patch: { content?: string; category?: MemoryCategory }) => {
    await updateMemory(id, patch)
    windowManager.broadcast('memory:changed')
  })
  ipcMain.handle('memory:confirm', async (_e, id: string) => {
    await confirmMemory(id)
    windowManager.broadcast('memory:changed')
  })
  ipcMain.handle('memory:remove', async (_e, id: string) => {
    await removeMemory(id)
    windowManager.broadcast('memory:changed')
  })
}
