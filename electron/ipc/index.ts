/**
 * 统一注册所有 IPC handler。
 */
import { registerAiIpc } from './ai.ipc'
import { registerCharacterCardIpc } from './characterCard.ipc'
import { registerMemoryIpc } from './memory.ipc'
import { registerModelIpc } from './model.ipc'
import { registerSessionIpc } from './session.ipc'
import { registerSettingsIpc } from './settings.ipc'
import { registerWindowIpc } from './window.ipc'

export function registerAllIpc(): void {
  registerAiIpc()
  registerCharacterCardIpc()
  registerMemoryIpc()
  registerModelIpc()
  registerSessionIpc()
  registerSettingsIpc()
  registerWindowIpc()
}
