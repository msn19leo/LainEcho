/**
 * 主动搭话 IPC：调度状态查询。开关/屏幕感知/免打扰等配置走 settings:*，
 * 状态变更经 proactive:state 广播推送到各窗口（设置面板实时刷新）。
 */
import { ipcMain } from 'electron'
import { getProactiveState } from '../services/proactive/scheduler'

export function registerProactiveIpc(): void {
  ipcMain.handle('proactive:get-state', () => getProactiveState())
}
