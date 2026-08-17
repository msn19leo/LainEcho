/**
 * 角色卡 CRUD IPC。
 * 增删改后通过 windowManager 广播 character-cards-changed 事件，
 * 实现跨窗口同步（替代旧版依赖 window.focus 轮询的机制）。
 */
import { ipcMain } from 'electron'
import type { CharacterCardInput, PersonaGenerateInput } from '../../src/types'
import {
  createCharacterCard,
  listCharacterCards,
  removeCharacterCard,
  updateCharacterCard,
} from '../services/repository'
import { generatePersona } from '../services/personaGenerator'
import { windowManager } from '../windows/windowManager'

export function registerCharacterCardIpc(): void {
  ipcMain.handle('character-card:list', () => listCharacterCards())

  ipcMain.handle('character-card:create', async (_e, input: CharacterCardInput) => {
    const card = await createCharacterCard(input)
    notifyCharacterCardsChanged()
    return card
  })

  ipcMain.handle('character-card:update', async (_e, id: string, patch: Partial<CharacterCardInput>) => {
    await updateCharacterCard(id, patch)
    notifyCharacterCardsChanged()
  })

  ipcMain.handle('character-card:remove', async (_e, id: string) => {
    await removeCharacterCard(id)
    notifyCharacterCardsChanged()
  })

  // 用 AI 生成人设草稿：不入库，仅返回结构化数据供编辑器回填
  ipcMain.handle('character-card:ai-generate', async (_e, input: PersonaGenerateInput) => {
    return generatePersona(input)
  })
}

/** 角色卡增删改后广播到所有窗口，触发跨窗口同步刷新 */
export function notifyCharacterCardsChanged(): void {
  windowManager.broadcast('character-cards-changed')
}
