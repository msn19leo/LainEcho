/**
 * 聊天图片附件 IPC。
 *
 * 只做一件事：把渲染端粘贴/拖入的图片字节交给 chatImages 服务压缩落盘，回传附件描述。
 * 统一走 ArrayBuffer（粘贴与拖拽同一条路径），避免渲染端读文件路径带来的
 * Electron 版本差异（v32+ 已移除 File.path，需 webUtils.getPathForFile）。
 */
import { ipcMain } from 'electron'
import { discardChatImage, saveChatImage } from '../services/chatImages'

export function registerChatImageIpc(): void {
  ipcMain.handle('chat:attach-image', async (_event, params: { sessionId?: unknown; buffer?: unknown; mime?: unknown }) => {
    const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : ''
    const mime = typeof params?.mime === 'string' ? params.mime : ''
    if (!sessionId) throw new Error('缺少会话标识')
    // ipcRenderer.invoke 传 ArrayBuffer：结构化克隆后在这里是 ArrayBuffer 或 Uint8Array
    const raw = params?.buffer
    if (!(raw instanceof ArrayBuffer) && !ArrayBuffer.isView(raw)) throw new Error('图片数据无效')
    const buffer = raw instanceof ArrayBuffer ? Buffer.from(raw) : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
    return await saveChatImage({ sessionId, buffer, mime })
  })

  ipcMain.handle('chat:discard-image', async (_event, params: { path?: unknown }) => {
    const relPath = typeof params?.path === 'string' ? params.path : ''
    if (!relPath) return
    await discardChatImage(relPath)
  })
}
