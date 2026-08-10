/**
 * 设置窗口：左侧导航 + 右侧卡片式内容（参考 moeru-ai/airi 风格）。
 */
import { BrowserWindow } from 'electron'
import path from 'path'
import { bindWindowStateEvents, loadWindowPage } from './base'

export function createSettingsWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 780,
    minHeight: 540,
    frame: false,
    show: false,
    backgroundColor: '#0f1115',
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
  void loadWindowPage(win, 'settings.html')
  return win
}
