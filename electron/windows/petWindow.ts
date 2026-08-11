/**
 * 桌宠窗口：无边框、透明背景、始终置顶、可拖动缩放、不穿透鼠标。
 */
import { BrowserWindow } from 'electron'
import path from 'path'
import { loadWindowPage } from './base'

const PET_WIDTH = 300
const PET_HEIGHT = 440

/** 应用是否正在退出：退出时允许真正关闭窗口，否则关闭=隐藏（常驻托盘） */
let quitting = false
export function markPetWindowQuitting(): void {
  quitting = true
}

export function createPetWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: PET_WIDTH,
    height: PET_HEIGHT,
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
  // 一旦检测到尺寸变化立即钉回固定尺寸，保证「无论如何拖动都保持不变」。
  win.on('resize', () => {
    if (win.isDestroyed()) return
    const [w, h] = win.getSize()
    if (w !== PET_WIDTH || h !== PET_HEIGHT) {
      win.setSize(PET_WIDTH, PET_HEIGHT)
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

  void loadWindowPage(win, 'pet.html')
  return win
}

export const PET_WINDOW_SIZE = { width: PET_WIDTH, height: PET_HEIGHT }
