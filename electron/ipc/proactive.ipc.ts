/**
 * 主动搭话 IPC：调度状态查询 + 用户主动识屏（眼睛按钮）。
 * 开关/屏幕感知/免打扰等配置走 settings:*，状态变更经 proactive:state 广播推送到各窗口。
 */
import { ipcMain } from 'electron'
import { getProactiveState, lookAtScreenNow } from '../services/proactive/scheduler'

export function registerProactiveIpc(): void {
  ipcMain.handle('proactive:get-state', () => getProactiveState())
  /** 眼睛按钮：立刻看一次屏幕并让角色开口（不计入每日搭话次数、不受免打扰限制） */
  ipcMain.handle('proactive:look-now', () => lookAtScreenNow())
}
