/**
 * 聊天窗口：无边框透明窗口，窗口大小紧贴 FloatingDock 可视区域。
 *
 * 窗口 = Dock 展开态大小（560x600），初始位置在屏幕右下角。
 * 折叠态时渲染进程通过 win:set-size 缩小窗口到 56x56（仅头像小球）。
 * 拖拽 Dock = 拖拽整个窗口（win:set-position），无多余透明区域拦截鼠标。
 */
import { BrowserWindow, screen } from 'electron'
import path from 'path'
import { bindWindowStateEvents, loadWindowPage } from './base'

/** Dock 展开态尺寸（与 FloatingDock 默认值一致） */
const DOCK_WIDTH = 560
const DOCK_HEIGHT = 600

export function createChatWindow(): BrowserWindow {
  // 计算屏幕右下角位置（留 24px 边距）
  const workArea = screen.getPrimaryDisplay().workAreaSize
  const x = workArea.width - DOCK_WIDTH - 24
  const y = workArea.height - DOCK_HEIGHT - 24

  const win = new BrowserWindow({
    width: DOCK_WIDTH,
    height: DOCK_HEIGHT,
    x,
    y,
    frame: false,
    show: false,
    transparent: true,
    maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  win.setMenuBarVisibility(false)
  bindWindowStateEvents(win)
  win.once('ready-to-show', () => win.show())
  void loadWindowPage(win, 'chat.html')
  return win
}
