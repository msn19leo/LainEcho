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

/** 按窗口 ID 缓存目标尺寸，避免 getSize() 在透明窗口上返回不一致的值
 *  导致拖拽时窗口持续扩大（反馈循环：setBounds → getSize 返回更大值 → setBounds 更大）。 */
const winSizeCache = new Map<number, { width: number; height: number }>()

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
  // 用 setBounds + 缓存尺寸代替 setPosition + getSize：
  //   Windows 透明窗口上 setSize/setPosition 可能导致尺寸意外改变，
  //   且 getSize() 在 DWM 缩放下可能返回比设置值更大的值，
  //   造成反馈循环（每次拖拽窗口都变大）。缓存切断了这个循环。
  ipcMain.handle('win:set-position', (e, x: number, y: number) => {
    const win = windowFromEvent(e)
    if (!win) return
    const cached = winSizeCache.get(win.id)
    const w = cached?.width ?? win.getSize()[0]
    const h = cached?.height ?? win.getSize()[1]
    win.setBounds({ x: Math.round(x), y: Math.round(y), width: w, height: h })
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
    const [x, y] = win.getPosition()
    const w = Math.max(56, Math.round(width))
    const h = Math.max(56, Math.round(height))
    // 缓存目标尺寸，供 set-position 使用（避免 getSize 返回不一致值）
    winSizeCache.set(win.id, { width: w, height: h })
    win.setBounds({ x, y, width: w, height: h })
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
