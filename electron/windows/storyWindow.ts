/**
 * 剧情演出窗口：独立可缩放 BrowserWindow（参照设置窗，frame:false + 自定义标题栏）。
 * 引擎运行在主进程——关闭剧情窗不中断演出，重开后按快照恢复（story:renderer-ready → resendStoryState）。
 */
import { BrowserWindow } from 'electron'
import path from 'path'
import { bindWindowStateEvents, loadWindowPage } from './base'

export function createStoryWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 800,
    height: 580,
    minWidth: 760,
    minHeight: 520,
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
  void loadWindowPage(win, 'story.html')
  return win
}
