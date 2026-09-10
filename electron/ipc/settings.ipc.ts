/**
 * 设置 IPC：API 配置（含 safeStorage 加密的 Key）+ 数据目录管理。
 */
import { ipcMain, dialog } from 'electron'
import type { AppSettings } from '../../src/types'
import { hasApiKey, saveApiKey, hasSecret, saveSecret } from '../services/crypto'
import { getSettings, saveSettings } from '../services/repository'
import { getDataDirInfo, migrateDataDir, resetDataDir, paths } from '../services/storage'
import { windowManager } from '../windows/windowManager'

export function registerSettingsIpc(): void {
  ipcMain.handle('settings:get', async () => {
    const settings = await getSettings()
    const keyPresent = await hasApiKey()
    const embeddingKeyPresent = await hasSecret(paths.embeddingApiKeyFile)
    const visionKeyPresent = await hasSecret(paths.visionApiKeyFile)
    return { ...settings, hasApiKey: keyPresent, hasEmbeddingApiKey: embeddingKeyPresent, hasVisionApiKey: visionKeyPresent }
  })

  ipcMain.handle('settings:save', async (_e, patch: Partial<AppSettings>) => {
    const result = await saveSettings(patch)
    // 设置变更广播给桌宠窗：同步「模型上下文窗口」等展示字段（如 token 用量显示里的窗口值）
    windowManager.broadcastAI('settings:changed', result)
    return result
  })

  ipcMain.handle('settings:save-api-key', (_e, key: string) => saveApiKey(key))

  ipcMain.handle('settings:has-api-key', () => hasApiKey())

  /** 保存嵌入服务独立 API Key（safeStorage 加密，与主 LLM Key 隔离） */
  ipcMain.handle('settings:save-embedding-api-key', (_e, key: string) => saveSecret(paths.embeddingApiKeyFile, key))

  /** 嵌入服务 Key 是否已配置（仅回显掩码用，不返回明文） */
  ipcMain.handle('settings:has-embedding-api-key', () => hasSecret(paths.embeddingApiKeyFile))

  /** 保存屏幕感知视觉模型独立 API Key（safeStorage 加密，与主 LLM Key 隔离） */
  ipcMain.handle('settings:save-vision-api-key', (_e, key: string) => saveSecret(paths.visionApiKeyFile, key))

  /** 视觉模型 Key 是否已配置（仅回显掩码用，不返回明文） */
  ipcMain.handle('settings:has-vision-api-key', () => hasSecret(paths.visionApiKeyFile))

  /** 获取当前数据目录信息 */
  ipcMain.handle('settings:get-data-dir', () => {
    return getDataDirInfo()
  })

  /**
   * 选择新目录并迁移数据：
   * 1. 弹出文件夹选择对话框
   * 2. 将 data/、models/、live2d-core/ 复制到新目录
   * 3. 写入配置文件
   * 4. 仅退出应用（不自动重启——dev 模式下 app.relaunch 与 vite 冲突）
   *    用户手动重新打开即可，新路径在下次启动时生效
   */
  ipcMain.handle('settings:change-data-dir', async (): Promise<{ success: boolean; error?: string; needRestart?: boolean }> => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: '选择数据存放位置',
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false }
    }
    const newDir = result.filePaths[0]!
    try {
      await migrateDataDir(newDir)
      // 不自动重启：dev 模式下 app.relaunch() 与 vite 进程管理冲突会导致启动失败
      // 生产模式下也统一走手动重启，避免 relaunch 在某些环境下失败
      return { success: true, needRestart: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : '迁移失败' }
    }
  })

  /** 重置数据目录为默认位置（清除自定义配置，不删除数据） */
  ipcMain.handle('settings:reset-data-dir', async (): Promise<{ success: boolean; error?: string; needRestart?: boolean }> => {
    try {
      await resetDataDir()
      return { success: true, needRestart: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : '重置失败' }
    }
  })
}
