/**
 * preload.ts —— 通过 contextBridge 暴露白名单 API 到 window.api。
 * 安全基线：
 *   - 不做通配符透传，每个方法逐一声明
 *   - 渲染进程拿不到 ipcRenderer 原始对象，无法调用未暴露的通道
 *   - API Key 明文永不经过这里
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { StreamDonePayload, StreamErrorPayload, WindowApi } from '../src/types'

const api: WindowApi = {
  ai: {
    sendMessage: (params) => ipcRenderer.invoke('ai:send-message', params),
    onStreamChunk: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, chunk: string) => cb(chunk)
      ipcRenderer.on('ai:stream-chunk', listener)
      return () => ipcRenderer.removeListener('ai:stream-chunk', listener)
    },
    onStreamDone: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: StreamDonePayload) => cb(payload)
      ipcRenderer.on('ai:stream-done', listener)
      return () => ipcRenderer.removeListener('ai:stream-done', listener)
    },
    onStreamError: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: StreamErrorPayload) => cb(payload)
      ipcRenderer.on('ai:stream-error', listener)
      return () => ipcRenderer.removeListener('ai:stream-error', listener)
    },
    cancel: () => ipcRenderer.send('ai:cancel'),
    testConnection: () => ipcRenderer.invoke('ai:test-connection'),
  },
  characterCard: {
    list: () => ipcRenderer.invoke('character-card:list'),
    create: (card) => ipcRenderer.invoke('character-card:create', card),
    update: (id, patch) => ipcRenderer.invoke('character-card:update', id, patch),
    remove: (id) => ipcRenderer.invoke('character-card:remove', id),
  },
  memory: {
    list: () => ipcRenderer.invoke('memory:list'),
    add: (content) => ipcRenderer.invoke('memory:add', content),
    update: (id, content) => ipcRenderer.invoke('memory:update', id, content),
    remove: (id) => ipcRenderer.invoke('memory:remove', id),
  },
  session: {
    list: () => ipcRenderer.invoke('session:list'),
    get: (id) => ipcRenderer.invoke('session:get', id),
    create: (params) => ipcRenderer.invoke('session:create', params),
    remove: (id) => ipcRenderer.invoke('session:remove', id),
    exportMarkdown: (id) => ipcRenderer.invoke('session:export-markdown', id),
    onChanged: (cb) => {
      const listener = () => cb()
      ipcRenderer.on('sessions-changed', listener)
      return () => ipcRenderer.removeListener('sessions-changed', listener)
    },
  },
  model: {
    list: () => ipcRenderer.invoke('model:list'),
    importFromFolder: () => ipcRenderer.invoke('model:import-from-folder'),
    remove: (modelId) => ipcRenderer.invoke('model:remove', modelId),
    coreStatus: () => ipcRenderer.invoke('model:core-status'),
    importCore: () => ipcRenderer.invoke('model:import-core'),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    save: (settings) => ipcRenderer.invoke('settings:save', settings),
    saveApiKey: (key) => ipcRenderer.invoke('settings:save-api-key', key),
    hasApiKey: () => ipcRenderer.invoke('settings:has-api-key'),
  },
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    toggleMaximize: () => ipcRenderer.send('win:toggle-maximize'),
    close: () => ipcRenderer.send('win:close'),
    isMaximized: () => ipcRenderer.invoke('win:is-maximized'),
    onMaximizedChange: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, maximized: boolean) => cb(maximized)
      ipcRenderer.on('win:maximized-change', listener)
      return () => ipcRenderer.removeListener('win:maximized-change', listener)
    },
    getPosition: () => ipcRenderer.invoke('win:get-position'),
    moveBy: (dx, dy) => ipcRenderer.invoke('win:move-by', dx, dy),
    setPosition: (x, y) => ipcRenderer.invoke('win:set-position', x, y),
    getSize: () => ipcRenderer.invoke('win:get-size'),
    setSize: (width, height) => ipcRenderer.invoke('win:set-size', width, height),
  },
  app: {
    openChat: () => ipcRenderer.send('app:open-chat'),
    openSettings: () => ipcRenderer.send('app:open-settings'),
    setPetModel: (modelId) => ipcRenderer.send('app:set-pet-model', modelId),
    quit: () => ipcRenderer.send('app:quit'),
  },
  pet: {
    onModelChanged: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, modelId: string | null) => cb(modelId)
      ipcRenderer.on('pet:set-model', listener)
      return () => ipcRenderer.removeListener('pet:set-model', listener)
    },
    onModelsChanged: (cb) => {
      const listener = () => cb()
      ipcRenderer.on('pet:models-changed', listener)
      return () => ipcRenderer.removeListener('pet:models-changed', listener)
    },
    onCoreChanged: (cb) => {
      const listener = () => cb()
      ipcRenderer.on('pet:core-changed', listener)
      return () => ipcRenderer.removeListener('pet:core-changed', listener)
    },
    modelUrl: (modelId, model3Path) => `pet-res://models/${modelId}/${model3Path}`,
  },
}

contextBridge.exposeInMainWorld('api', api)

// 类型全局声明（渲染进程通过 window.api 访问）
declare global {
  interface Window {
    api: WindowApi
  }
}

export type { WindowApi }
