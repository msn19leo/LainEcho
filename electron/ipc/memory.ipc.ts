/**
 * 记忆体 CRUD IPC（全局共享，不区分角色卡）。
 */
import { ipcMain } from 'electron'
import { addMemory, listMemories, removeMemory, updateMemory } from '../services/repository'

export function registerMemoryIpc(): void {
  ipcMain.handle('memory:list', () => listMemories())
  ipcMain.handle('memory:add', (_e, content: string) => addMemory(content))
  ipcMain.handle('memory:update', (_e, id: string, content: string) => updateMemory(id, content))
  ipcMain.handle('memory:remove', (_e, id: string) => removeMemory(id))
}
