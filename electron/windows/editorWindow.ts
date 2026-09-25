/**
 * 剧本可视化编辑器窗口（7.6）：独立 BrowserWindow，与剧情演出窗同模式（frame:false + 自定义标题栏）。
 * 编辑器只做"表单/文本读写 + 校验"，不参与演出；同一时间一个编辑器窗口，重复打开切换剧本并通知重载。
 */
import { BrowserWindow } from 'electron'
import path from 'path'
import { bindWindowStateEvents, loadWindowPage } from './base'

let editorWin: BrowserWindow | null = null
/** 当前编辑器正在编辑的剧本 id（渲染端通过 story:editor-current 读取） */
let currentScriptId: string | null = null

export function getEditorScriptId(): string | null {
  return currentScriptId
}

export function createEditorWindow(scriptId: string): BrowserWindow {
  currentScriptId = scriptId
  if (editorWin && !editorWin.isDestroyed()) {
    editorWin.focus()
    // 已打开：切换剧本 → 通知渲染端重载
    editorWin.webContents.send('editor:reload')
    return editorWin
  }
  const win = new BrowserWindow({
    width: 950,
    height: 600,
    minWidth: 900,
    minHeight: 600,
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
  win.on('closed', () => {
    editorWin = null
  })
  editorWin = win
  void loadWindowPage(win, 'editor.html')
  return win
}

/** 编辑器窗口存活时通知渲染端重载（剧本被外部修改/切换时预留） */
export function notifyEditorReload(): void {
  if (editorWin && !editorWin.isDestroyed()) editorWin.webContents.send('editor:reload')
}

export function getEditorWindow(): BrowserWindow | null {
  return editorWin
}
