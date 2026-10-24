/**
 * 会话 IPC：CRUD + 导出为 Markdown。
 */
import { dialog, ipcMain } from 'electron'
import type { SessionDetail, SessionIndexItem } from '../../src/types'
import { sessionToMarkdown } from '../services/markdownExporter'
import { createSession, getSession, listSessions, removeSession, renameSession, setSessionSceneDigest } from '../services/repository'
import { windowManager } from '../windows/windowManager'

export function registerSessionIpc(): void {
  ipcMain.handle('session:list', (): Promise<SessionIndexItem[]> => listSessions())

  ipcMain.handle('session:get', (_e, id: string): Promise<SessionDetail> => getSession(id))

  /**
   * 读取会话的情景摘要缓存（设置窗查看/编辑）：
   * 优先聊天窗当前选中的会话（windowManager.currentSessionId，切会话后编辑块立即跟随——
   * 切到未聊过的会话 = 空缓存，观感即"切换后清空"）；尚未上报时回落最近活跃会话（listSessions 首个）。
   */
  ipcMain.handle('session:scene-digest-get', async () => {
    const index = await listSessions()
    if (index.length === 0) return null
    const currentId = windowManager.getCurrentSessionId()
    const target = (currentId ? index.find((s) => s.id === currentId) : undefined) ?? index[0]
    if (!target) return null
    const detail = await getSession(target.id)
    return { sessionId: target.id, title: target.title, digest: detail.sceneDigest ?? '' }
  })

  /** 保存指定会话的情景摘要缓存（设置窗手动编辑；空串=清空缓存） */
  ipcMain.handle('session:scene-digest-set', async (_e, params: { sessionId: string; text: string }) => {
    await setSessionSceneDigest(params.sessionId, params.text ?? '')
  })

  ipcMain.handle('session:create', async (_e, params: { characterCardId: string }): Promise<SessionIndexItem> => {
    if (!params?.characterCardId) throw new Error('缺少角色卡')
    const item = await createSession(params.characterCardId)
    windowManager.notifySessionsChanged()
    return item
  })

  ipcMain.handle('session:remove', async (_e, id: string) => {
    await removeSession(id)
    windowManager.notifySessionsChanged()
  })

  ipcMain.handle('session:rename', async (_e, id: string, title: string) => {
    await renameSession(id, title)
    windowManager.notifySessionsChanged()
  })

  ipcMain.handle('session:export-markdown', async (_e, id: string) => {
    const session = await getSession(id)
    const index = await listSessions()
    const entry = index.find((s) => s.id === id)
    const title = entry?.title ?? '会话'
    const characterCardName = entry?.characterCardName ?? 'AI'
    const createdAt = entry?.createdAt ?? Date.now()

    const markdown = sessionToMarkdown(session, { title, characterCardName, createdAt })

    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '导出会话为 Markdown',
      defaultPath: `${title.replace(/[\\/:*?"<>|]/g, '_')}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    })
    if (canceled || !filePath) return null

    const { writeFile } = await import('fs/promises')
    await writeFile(filePath, markdown, 'utf-8')
    return { savedPath: filePath }
  })
}