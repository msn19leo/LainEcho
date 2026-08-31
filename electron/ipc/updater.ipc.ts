/**
 * 注册「检查更新」相关 IPC。
 * 主进程事件（发现新版/下载完成/进度/错误）通过 broadcast 推送给所有窗口，
 * 渲染进程据此弹窗并决定是否下载/安装。
 */
import { ipcMain, BrowserWindow, app } from 'electron'
import { autoUpdater } from 'electron-updater'
import { initAutoUpdater, checkForUpdates } from '../services/updater'

/**
 * 初始化更新 IPC：
 * @param getWindows 返回当前活跃窗口列表（用于 broadcast 推送更新状态）
 */
export function registerUpdaterIpc(getWindows: () => BrowserWindow[]): void {
  const broadcast = (channel: string, ...args: unknown[]) => {
    for (const win of getWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, ...args)
    }
  }

  // 初始化自动更新服务，把主进程事件转发给渲染进程
  initAutoUpdater({
    onAvailable: (version) => broadcast('updater:available', version),
    onNotAvailable: () => broadcast('updater:not-available'),
    onDownloaded: () => broadcast('updater:downloaded'),
    onProgress: (percent) => broadcast('updater:progress', percent),
    onError: (message) => broadcast('updater:error', message),
  })

  // 渲染进程主动触发「检查更新」
  ipcMain.handle('updater:check', () => checkForUpdates())

  // 读取当前应用版本号（AboutPanel 展示用）
  ipcMain.handle('updater:get-version', () => app.getVersion())

  // 用户确认「开始下载」
  ipcMain.handle('updater:download', () => autoUpdater.downloadUpdate())

  // 用户放弃本次更新：因为 autoDownload=false，未触发下载时无需显式取消
  ipcMain.handle('updater:skip', () => undefined)

  // 用户确认「立即重启安装」
  ipcMain.handle('updater:install', () => autoUpdater.quitAndInstall())
}