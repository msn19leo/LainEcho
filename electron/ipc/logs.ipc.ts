/**
 * 运行日志 IPC：缓冲快照 / 历史文件尾部 / 打开日志文件夹 / 渲染端日志转发。
 * 通道清单：
 *  - logs:get-buffer（invoke）  内存环形缓冲快照（旧→新）
 *  - logs:read-tail（invoke）   当前 latest.log 尾部（查看重启前的历史）
 *  - logs:open-folder（invoke） 打开日志文件夹（资源管理器）
 *  - logs:forward（send）       渲染端 console 转发（带窗口来源标签）
 *  - logs:appended（主→渲染）   实时 tail 推送（logger 每条新日志广播）
 */
import { ipcMain, shell } from 'electron'
import type { LogEntrySource } from '../../src/types'
import { forwardLog, clearCurrentLog, getBufferSnapshot, LOG_DIR, readLatestTail, type LogEntry } from '../services/logger'

export function registerLogsIpc(): void {
  ipcMain.handle('logs:get-buffer', (): LogEntry[] => getBufferSnapshot())
  ipcMain.handle('logs:read-tail', () => readLatestTail())
  ipcMain.handle('logs:clear', () => clearCurrentLog())
  ipcMain.handle('logs:open-folder', async () => {
    // 空串 = 成功，否则为错误消息
    return shell.openPath(LOG_DIR())
  })
  // 渲染端 console 转发（fire-and-forget）
  ipcMain.on('logs:forward', (_e, source: unknown, level: unknown, msg: unknown) => {
    const src = typeof source === 'string' && source ? (source as LogEntrySource) : 'main'
    const lv = level === 'warn' || level === 'error' ? level : 'info'
    forwardLog(src, lv, typeof msg === 'string' ? msg : String(msg))
  })
}
