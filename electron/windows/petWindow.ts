/**
 * 桌宠窗口：无边框、透明背景、始终置顶、可拖动缩放、不穿透鼠标。
 */
import { BrowserWindow, screen } from 'electron'
import path from 'path'
import { loadWindowPage } from './base'

const PET_WIDTH = 300
/** 模型区基础高度（内容框作为半透明浮层叠加在模型上，不占用布局，模型区恒定）
 *  窗口总高 = 模型区 + 底部输入框；不随内容框变化 */
const PET_MODEL_H = 440
/** 底部输入框固定占高（与渲染层 INPUT_H 一致） */
const PET_INPUT_H = 40
/** 窗口目标高度：固定不变 */
const currentPetHeight = PET_MODEL_H + PET_INPUT_H

/** 当前宠物窗口引用（保留字段） */
let petWin: BrowserWindow | null = null

/** 历史 IPC：内容框已改为浮层，不再调整窗口高度；保留导出避免破坏调用方 */
export function setPetPanelHeight(_panelH: number): void {}

/** 应用是否正在退出：退出时允许真正关闭窗口，否则关闭=隐藏（常驻托盘） */
let quitting = false
export function markPetWindowQuitting(): void {
  quitting = true
}

export function createPetWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: PET_WIDTH,
    height: currentPetHeight,
    x: 200,
    y: 160,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    // 不可缩放：拖动透明无边框窗口在 Windows 上若可缩放，会被误触边缘缩放手柄
    // 或出现窗口随拖动拉伸的渲染问题。缩放统一走 Live2D 模型 scale（滚轮），窗口尺寸固定。
    resizable: false,
    maximizable: false,
    alwaysOnTop: true,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })

  win.setAlwaysOnTop(true, 'floating')
  win.setMenuBarVisibility(false)

  // 保险：Windows 上透明无边框窗口在拖动时尺寸可能被 DWM 漂移（即使 resizable:false），
  // 一旦检测到尺寸偏离当前目标（宽固定 300、高随面板联动）立即钉回，保证拖动不会让窗口漂移变大。
  win.on('resize', () => {
    if (win.isDestroyed()) return
    const [w, h] = win.getSize()
    if (w !== PET_WIDTH || h !== currentPetHeight) {
      win.setSize(PET_WIDTH, currentPetHeight)
    }
  })

  // 透明窗口首次绘制完成后再显示，避免白屏闪烁
  win.once('ready-to-show', () => {
    win.show()
  })

  // 关闭时隐藏而非销毁（常驻托盘），真正的退出走 tray -> quit
  win.on('close', (e) => {
    if (!quitting && !win.isDestroyed()) {
      e.preventDefault()
      win.hide()
    }
  })

  // ---- 全局鼠标跟踪 ----
  // 透明窗口 + -webkit-app-region: drag 导致 window.mousemove 无法正常触发，
  // 且桌宠窗口仅 300x440，需要跟踪屏幕任意位置的鼠标（参考 airi 桌面端用 OS API）。
  // 通过 screen.getCursorScreenPoint() 轮询全局鼠标坐标，转换为窗口相对坐标后发送给渲染进程。
  let cursorTimer: ReturnType<typeof setInterval> | null = null
  const startCursorTracking = () => {
    if (cursorTimer) return
    cursorTimer = setInterval(() => {
      if (win.isDestroyed() || !win.isVisible()) return
      const pos = screen.getCursorScreenPoint()
      const [winX, winY] = win.getPosition()
      win.webContents.send('cursor:move', {
        x: pos.x - (winX ?? 0),
        y: pos.y - (winY ?? 0),
      })
    }, 33) // ~30fps，足够流畅的眼球跟踪
  }
  const stopCursorTracking = () => {
    if (cursorTimer) {
      clearInterval(cursorTimer)
      cursorTimer = null
    }
  }
  win.on('show', startCursorTracking)
  win.on('hide', stopCursorTracking)
  win.on('closed', () => {
    stopCursorTracking()
    if (petWin === win) petWin = null
  })

  petWin = win
  void loadWindowPage(win, 'pet.html')
  return win
}

/** 窗口基础尺寸（宽度固定；高度随面板联动，见 currentPetHeight） */
export const PET_WINDOW_SIZE = { width: PET_WIDTH, height: PET_MODEL_H }
