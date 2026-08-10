/**
 * 渲染进程访问主进程能力的唯一入口：window.api（由 preload.ts 注入）。
 */
import type { WindowApi } from '../types'

export const api: WindowApi = window.api

export type { WindowApi }
export * from '../types'
