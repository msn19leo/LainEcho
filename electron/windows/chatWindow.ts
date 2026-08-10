/**
 * 聊天窗口：消息流 + 会话侧边栏。自定义无边框标题栏（渲染进程实现）。
 */
import { BrowserWindow } from 'electron'
import path from 'path'
import { bindWindowStateEvents, loadWindowPage } from './base'

export function createChatWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 920,
    height: 660,
    minWidth: 720,
    minHeight: 480,
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
  void loadWindowPage(win, 'chat.html')
  return win
}
