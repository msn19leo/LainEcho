/**
 * 自动更新服务。
 * 策略：不自动下载（autoDownload=false），发现新版时回调前端弹窗「是否更新」，
 *       下载完成后再询问「是否重启安装」，全程由用户决定。
 */
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'

type UpdateHandlers = {
  /** 发现新版本（通知前端弹窗，传新版本号） */
  onAvailable: (version: string) => void
  /** 检查完成且无新版本（通知前端结束"检查中"状态） */
  onNotAvailable: () => void
  /** 更新包下载完成 */
  onDownloaded: () => void
  /** 下载进度（0-100） */
  onProgress: (percent: number) => void
  /** 检查/下载出错 */
  onError: (message: string) => void
}

let isInit = false

/**
 * 初始化自动更新。开发模式（未打包）下仅注册事件、不触发网络检查、
 * 且下载/安装动作会被守卫拦截，避免误操作。
 */
export function initAutoUpdater(handlers: UpdateHandlers): void {
  if (isInit) return
  isInit = true

  autoUpdater.autoDownload = false // 由用户决定是否下载
  autoUpdater.autoInstallOnAppQuit = false // 不在退出时静默安装

  // 事件转发给调用方（windowManager / IPC）
  autoUpdater.on('update-available', (info) => handlers.onAvailable(info.version))
  autoUpdater.on('update-not-available', () => handlers.onNotAvailable())
  autoUpdater.on('update-downloaded', () => handlers.onDownloaded())
  autoUpdater.on('download-progress', (p) => handlers.onProgress(Math.round(p.percent)))
  autoUpdater.on('error', (err) => handlers.onError(err.message))
}

/** 手动触发「检查更新」；开发模式直接抛错（无发布源）。 */
export function checkForUpdates(): Promise<void> {
  if (!app.isPackaged) {
    return Promise.reject(new Error('开发模式下无法检查更新'))
  }
  return autoUpdater.checkForUpdates() as unknown as Promise<void>
}