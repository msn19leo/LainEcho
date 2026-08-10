/**
 * 会话 IPC：CRUD + 导出为 Markdown。
 */
import { dialog, ipcMain } from 'electron'
import type { SessionDetail, SessionIndexItem } from '../../src/types'
import { sessionToMarkdown } from '../services/markdownExporter'
import { createSession, getSession, listSessions, removeSession } from '../services/repository'
import { windowManager } from '../windows/windowManager'

export function registerSessionIpc(): void {
  ipcMain.handle('session:list', (): Promise<SessionIndexItem[]> => listSessions())

  ipcMain.handle('session:get', (_e, id: string): Promise<SessionDetail> => getSession(id))

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
