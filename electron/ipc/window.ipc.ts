/**
 * 窗口控制 + 应用级操作 IPC。
 * - 桌宠窗口拖动（moveBy）、缩放（setSize）
 * - 自定义标题栏（minimize / toggleMaximize / close）
 * - 应用级操作（打开聊天/设置、同步桌宠模型、退出）
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { markPetWindowQuitting } from '../windows/petWindow'
import { windowManager } from '../windows/windowManager'

function windowFromEvent(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): BrowserWindow | null {
  const win = BrowserWindow.fromWebContents(event.sender)
  return win && !win.isDestroyed() ? win : null
}

export function registerWindowIpc(): void {
  // ---------------- 窗口控制 ----------------

  ipcMain.on('win:minimize', (e) => {
    windowFromEvent(e)?.minimize()
  })

  ipcMain.on('win:toggle-maximize', (e) => {
    const win = windowFromEvent(e)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })

  ipcMain.on('win:close', (e) => {
    windowFromEvent(e)?.close()
  })

  ipcMain.handle('win:is-maximized', (e) => windowFromEvent(e)?.isMaximized() ?? false)

  ipcMain.handle('win:get-position', (e) => {
    const win = windowFromEvent(e)
    if (!win) return { x: 0, y: 0 }
    const [x, y] = win.getPosition()
    return { x, y }
  })

  // 绝对定位（拖动用）：直接设置窗口坐标，避免增量方案在拖动中反复 getPosition()
  // 读取到 DWM 动画/滞后坐标，导致方向性误差（下/右阻力、上/左超速）。
  ipcMain.handle('win:set-position', (e, x: number, y: number) => {
    const win = windowFromEvent(e)
    if (!win) return
    win.setPosition(Math.round(x), Math.round(y))
  })

  ipcMain.handle('win:move-by', (e, dx: number, dy: number) => {
    const win = windowFromEvent(e)
    if (!win) return
    const pos = win.getPosition()
    const x = pos[0] ?? 0
    const y = pos[1] ?? 0
    win.setPosition(Math.round(x + dx), Math.round(y + dy))
  })

  ipcMain.handle('win:get-size', (e) => {
    const win = windowFromEvent(e)
    if (!win) return { width: 0, height: 0 }
    const [width, height] = win.getSize()
    return { width, height }
  })

  ipcMain.handle('win:set-size', (e, width: number, height: number) => {
    const win = windowFromEvent(e)
    if (!win) return
    const w = Math.max(200, Math.round(width))
    const h = Math.max(200, Math.round(height))
    win.setSize(w, h, true)
  })

  // ---------------- 应用级操作 ----------------

  ipcMain.on('app:open-chat', () => windowManager.showChat())
  ipcMain.on('app:open-settings', () => windowManager.showSettings())

  ipcMain.on('app:set-pet-model', (_e, modelId: string | null) => {
    windowManager.setPetModel(modelId)
  })

  ipcMain.on('app:quit', () => {
    markPetWindowQuitting()
    app.quit()
  })
}
