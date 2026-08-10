/**
 * 设置 IPC：API 配置（含 safeStorage 加密的 Key）。
 */
import { ipcMain } from 'electron'
import type { AppSettings } from '../../src/types'
import { hasApiKey, saveApiKey } from '../services/crypto'
import { getSettings, saveSettings } from '../services/repository'

export function registerSettingsIpc(): void {
  ipcMain.handle('settings:get', async () => {
    const settings = await getSettings()
    const keyPresent = await hasApiKey()
    return { ...settings, hasApiKey: keyPresent }
  })

  ipcMain.handle('settings:save', (_e, patch: Partial<AppSettings>) => saveSettings(patch))

  ipcMain.handle('settings:save-api-key', (_e, key: string) => saveApiKey(key))

  ipcMain.handle('settings:has-api-key', () => hasApiKey())
}
