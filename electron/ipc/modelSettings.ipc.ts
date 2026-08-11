/**
 * 模型设置 IPC：缩放/位置/动画/参数的读取与保存。
 * 保存后通过 windowManager 广播到桌宠窗口，实现实时跨窗口同步。
 */
import { ipcMain } from 'electron'
import type { ModelSettings } from '../../src/types'
import { getModelSettings, saveModelSettings } from '../services/repository'
import { windowManager } from '../windows/windowManager'

export function registerModelSettingsIpc(): void {
  ipcMain.handle('model-settings:get', async (): Promise<ModelSettings> => {
    return getModelSettings()
  })

  ipcMain.handle('model-settings:save', async (_e, patch: Partial<ModelSettings>): Promise<void> => {
    const merged = await saveModelSettings(patch)
    // 广播合并后的完整设置到桌宠窗口
    windowManager.notifyModelSettingsChanged(merged)
  })
}
