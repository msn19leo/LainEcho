/**
 * 窗口公共辅助：页面加载（dev 走 dev server，prod 走 file://）+ 状态事件转发。
 */
import type { BrowserWindow } from 'electron'
import path from 'path'

export type WindowPage = 'pet.html' | 'chat.html' | 'settings.html'

/** vite-plugin-electron 在 dev 模式下注入到主进程的环境变量 */
const DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'] as string | undefined

export function isDev(): boolean {
  return !!DEV_SERVER_URL
}

export function loadWindowPage(win: BrowserWindow, page: WindowPage): void {
  if (DEV_SERVER_URL) {
    void win.loadURL(`${DEV_SERVER_URL}/${page}`)
  } else {
    void win.loadFile(path.join(__dirname, `../dist/${page}`))
  }
}

/** 转发窗口最大化状态变化给渲染进程（自定义标题栏需要） */
export function bindWindowStateEvents(win: BrowserWindow): void {
  const send = (maximized: boolean) => {
    if (!win.isDestroyed()) win.webContents.send('win:maximized-change', maximized)
  }
  win.on('maximize', () => send(true))
  win.on('unmaximize', () => send(false))
}
