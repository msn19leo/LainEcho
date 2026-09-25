/**
 * 统一注册所有 IPC handler。
 */
import { registerAiIpc } from './ai.ipc'
import { registerCharacterCardIpc } from './characterCard.ipc'
import { registerMemoryIpc } from './memory.ipc'
import { registerModelIpc } from './model.ipc'
import { registerModelSettingsIpc } from './modelSettings.ipc'
import { registerProactiveIpc } from './proactive.ipc'
import { registerSessionIpc } from './session.ipc'
import { registerSettingsIpc } from './settings.ipc'
import { registerSpritesIpc } from './sprites.ipc'
import { registerStoryIpc } from './story.ipc'
import { registerTtsIpc } from './tts.ipc'
import { registerWindowIpc } from './window.ipc'
import { registerUpdaterIpc } from './updater.ipc'
import { windowManager } from '../windows/windowManager'

export function registerAllIpc(): void {
  registerAiIpc()
  registerCharacterCardIpc()
  registerMemoryIpc()
  registerModelIpc()
  registerModelSettingsIpc()
  registerProactiveIpc()
  registerSessionIpc()
  registerSettingsIpc()
  registerSpritesIpc()
  registerStoryIpc()
  registerTtsIpc()
  registerWindowIpc()
  // 更新：广播目标为所有窗口（桌宠/聊天/设置）
  registerUpdaterIpc(() => windowManager.getAllWindows())
}
