/**
 * 设置 IPC：API 服务商档案（全局档案库 CRUD，Key 走 safeStorage 加密）+ 数据目录管理。
 * Key 明文只在主进程内存中出现；settings:get 仅按档案回传 hasKey 布尔值供掩码回显。
 */
import { ipcMain, dialog } from 'electron'
import type { AppSettings } from '../../src/types'
import { deleteProfile, hasProfileKey, listProfileModels, upsertProfile } from '../services/apiProfiles'
import { getSettings, saveSettings } from '../services/repository'
import { getDataDirInfo, migrateDataDir, resetDataDir } from '../services/storage'
import { windowManager } from '../windows/windowManager'

/** 读取设置并给每个档案附加传输态 hasKey（掩码回显用，不返回明文） */
async function getSettingsWithProfileKeyState(): Promise<AppSettings> {
  const settings = await getSettings()
  const profiles = await Promise.all(
    (settings.profiles ?? []).map(async (p) => ({ ...p, hasKey: await hasProfileKey(p.id) })),
  )
  return { ...settings, profiles }
}

export function registerSettingsIpc(): void {
  ipcMain.handle('settings:get', () => getSettingsWithProfileKeyState())

  ipcMain.handle('settings:save', async (_e, patch: Partial<AppSettings>) => {
    await saveSettings(patch)
    // 广播携带档案 Key 状态（hasKey），设置窗切换激活档案后掩码回显不丢；
    // 设置变更同步给桌宠窗：「模型上下文窗口」等展示字段（如 token 用量显示里的窗口值）
    const result = await getSettingsWithProfileKeyState()
    windowManager.broadcastAI('settings:changed', result)
    return result
  })

  /** 新建/更新服务商档案（upsert；key 非空时保存该档案的 API Key），变更后广播同步各窗口 */
  ipcMain.handle('settings:save-profile', async (_e, input: { id?: string; name: string; baseURL: string; model: string; key?: string }) => {
    const profile = await upsertProfile(input)
    windowManager.broadcastAI('settings:changed', await getSettingsWithProfileKeyState())
    return profile
  })

  /** 删除服务商档案（被引用时抛错由渲染端 toast 展示），变更后广播同步各窗口 */
  ipcMain.handle('settings:delete-profile', async (_e, id: string) => {
    await deleteProfile(id)
    windowManager.broadcastAI('settings:changed', await getSettingsWithProfileKeyState())
  })

  /** 拉取档案服务商的可用模型列表（OpenAI 兼容 /models）；Key 明文不出主进程 */
  ipcMain.handle('settings:list-models', (_e, input: { profileId?: string; baseURL?: string; key?: string }) =>
    listProfileModels(input ?? {}),
  )

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
