/**
 * 主进程入口：单实例锁、窗口创建、托盘、自定义协议、IPC 注册。
 */
import { app } from 'electron'
import { ensureDataDirs } from './services/storage'
import { pruneEmptySessions } from './services/repository'
import { registerPetSchemesPrivileged, registerPetProtocolHandler } from './services/petProtocol'
import { registerAllIpc } from './ipc'
import { windowManager } from './windows/windowManager'

// pet-res:// 特权 scheme 必须在 app ready 之前注册
registerPetSchemesPrivileged()

// Windows 通知/任务栏归属
app.setAppUserModelId('com.lainecho.pet')

// 单实例：重复启动时唤醒已有实例的桌宠
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.whenReady().then(async () => {
    await ensureDataDirs()
    // 清理历史遗留的空会话（无消息 = 从未使用）
    await pruneEmptySessions().catch((err) => console.error('清理空会话失败', err))
    registerPetProtocolHandler()
    registerAllIpc()
    windowManager.init()

    app.on('activate', () => {
      // macOS Dock 点击时恢复桌宠窗口（兼容处理）
      if (!windowManager.getPetWindow()) windowManager.showPet()
    })
  })

  // Windows/macOS：关闭所有窗口后保持托盘常驻（不退出）
  app.on('window-all-closed', () => {
    // 保持运行，等待托盘退出
  })
}
