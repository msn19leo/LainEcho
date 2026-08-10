/**
 * 角色卡 CRUD IPC。
 */
import { ipcMain } from 'electron'
import type { CharacterCard } from '../../src/types'
import {
  createCharacterCard,
  listCharacterCards,
  removeCharacterCard,
  updateCharacterCard,
} from '../services/repository'

export function registerCharacterCardIpc(): void {
  ipcMain.handle('character-card:list', () => listCharacterCards())

  ipcMain.handle(
    'character-card:create',
    (_e, input: Pick<CharacterCard, 'name' | 'identity' | 'consciousness' | 'modelId'>) =>
      createCharacterCard(input),
  )

  ipcMain.handle(
    'character-card:update',
    (_e, id: string, patch: Partial<Pick<CharacterCard, 'name' | 'identity' | 'consciousness' | 'modelId'>>) =>
      updateCharacterCard(id, patch),
  )

  ipcMain.handle('character-card:remove', (_e, id: string) => removeCharacterCard(id))
}
