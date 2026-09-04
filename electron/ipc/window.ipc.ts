/**
 * 窗口控制 + 应用级操作 IPC。
 * - 桌宠窗口拖动（moveBy）、缩放（setSize）
 * - 自定义标题栏（minimize / toggleMaximize / close）
 * - 应用级操作（打开聊天/设置、同步桌宠模型、退出）
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import type { PetCardPayload, TTSLanguage } from '../../src/types'
import { markPetWindowQuitting, setPetPanelHeight } from '../windows/petWindow'
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

  ipcMain.on('app:open-chat', (_e, sessionId?: string) => windowManager.showChat(sessionId))
  ipcMain.on('app:open-settings', () => windowManager.showSettings())

  ipcMain.on('app:set-pet-card', (_e, payload: PetCardPayload) => {
    windowManager.setPetCard(payload)
  })

  /** 通知桌宠窗口播放语音（聊天窗口 AI 回复后调用，触发 TTS + 口型同步）。
     *  payload 含主进程拆好的合成分段（dialogue 逐项），供桌宠段级合成播放。 */
  ipcMain.on('app:speak', (_e, text: string, voiceId: string | null, languageOverride?: TTSLanguage | null, payload?: { chunks?: import('../../src/types').DialogueChunk[] }) => {
    windowManager.speak(text, voiceId, languageOverride, payload)
  })

  /** 聊天窗上报当前会话 → 转发给宠物窗（内容框跟随同步） */
  ipcMain.on('session:current', (_e, sessionId: string | null) => {
    windowManager.notifyCurrentSession(sessionId)
  })

  /** 宠物窗朗读到某段文本 → 转发给聊天窗随语音显示 */
  ipcMain.on('pet:reading-text', (_e, text: string) => {
    const t = typeof text === 'string' ? text : ''
    if (process.env.NODE_ENV !== 'production') {
      console.log('[diag] pet->chat reading-text len=', t.length, t.length ? JSON.stringify(t.slice(0, 24)) : '')
    }
    windowManager.notifyReadingText(t)
  })

  /** 宠物窗朗读是否进行中 → 转发给聊天窗控制光标 */
  ipcMain.on('pet:reading-active', (_e, active: boolean) => {
    if (process.env.NODE_ENV !== 'production') console.log('[diag] pet->chat reading-active=', active)
    windowManager.notifyReadingActive(active === true)
  })

  /** 宠物窗/聊天窗 renderer 就绪 → 补发最近一次语音模式 + 进行中的会话 id（避免广播早于订阅而丢失） */
  ipcMain.on('pet:renderer-ready', () => {
    windowManager.resendVoiceMode('pet')
    windowManager.resendActiveSession('pet')
  })
  ipcMain.on('chat:renderer-ready', () => {
    windowManager.resendVoiceMode('chat')
    windowManager.resendActiveSession('chat')
  })

  /** 宠物窗内容框高度变化 → 调整宠物窗总高度（模型区恒定，顶边固定向下生长） */
  ipcMain.on('pet:set-panel-height', (_e, panelH: number) => {
    setPetPanelHeight(typeof panelH === 'number' && Number.isFinite(panelH) ? panelH : 0)
  })

  ipcMain.on('app:quit', () => {
    markPetWindowQuitting()
    app.quit()
  })
}
