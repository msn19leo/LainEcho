/**
 * preload.ts —— 通过 contextBridge 暴露白名单 API 到 window.api。
 * 安全基线：
 *   - 不做通配符透传，每个方法逐一声明
 *   - 渲染进程拿不到 ipcRenderer 原始对象，无法调用未暴露的通道
 *   - API Key 明文永不经过这里
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { StreamDonePayload, StreamErrorPayload, ModelSettings, WindowApi } from '../src/types'

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
    generate: (input) => ipcRenderer.invoke('character-card:ai-generate', input),
    onChanged: (cb) => {
      const listener = () => cb()
      ipcRenderer.on('character-cards-changed', listener)
      return () => ipcRenderer.removeListener('character-cards-changed', listener)
    },
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
    rename: (id, title) => ipcRenderer.invoke('session:rename', id, title),
    exportMarkdown: (id) => ipcRenderer.invoke('session:export-markdown', id),
    onChanged: (cb) => {
      const listener = () => cb()
      ipcRenderer.on('sessions-changed', listener)
      return () => ipcRenderer.removeListener('sessions-changed', listener)
    },
  },
  model: {
    list: () => ipcRenderer.invoke('model:list'),
    motionGroups: (modelId) => ipcRenderer.invoke('model:motion-groups', modelId),
    expressionList: (modelId) => ipcRenderer.invoke('model:expression-list', modelId),
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
    getDataDir: () => ipcRenderer.invoke('settings:get-data-dir'),
    changeDataDir: () => ipcRenderer.invoke('settings:change-data-dir'),
    resetDataDir: () => ipcRenderer.invoke('settings:reset-data-dir'),
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
    setPetCard: (payload) => ipcRenderer.send('app:set-pet-card', payload),
    quit: () => ipcRenderer.send('app:quit'),
    /** 通知桌宠窗口播放语音（AI 回复后由聊天窗口调用，触发 TTS 合成+口型同步） */
    speak: (text, voiceId, languageOverride) => ipcRenderer.send('app:speak', text, voiceId, languageOverride),
  },
  pet: {
    onCardChanged: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: { modelId: string | null; modelOverride: import('../src/types').CharacterModelOverride | null }) => cb(payload)
      ipcRenderer.on('pet:set-card', listener)
      return () => ipcRenderer.removeListener('pet:set-card', listener)
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
    onModelSettingsChanged: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, settings: ModelSettings) => cb(settings)
      ipcRenderer.on('pet:model-settings-changed', listener)
      return () => ipcRenderer.removeListener('pet:model-settings-changed', listener)
    },
    /** 全局鼠标坐标变化回调（窗口相对坐标，由主进程 screen.getCursorScreenPoint 轮询） */
    onCursorMove: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, pos: { x: number; y: number }) => cb(pos)
      ipcRenderer.on('cursor:move', listener)
      return () => ipcRenderer.removeListener('cursor:move', listener)
    },
    /** 订阅"说话"事件（聊天窗口 AI 回复后触发，桌宠窗口合成并播放语音+口型同步） */
    onSpeak: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: { text: string; voiceId: string | null; languageOverride: import('../src/types').TTSLanguage | null }) => cb(payload)
      ipcRenderer.on('pet:speak', listener)
      return () => ipcRenderer.removeListener('pet:speak', listener)
    },
    modelUrl: (modelId, model3Path) => `pet-res://models/${modelId}/${model3Path}`,
  },
  /** 语音合成（TTS）：MiMo 声音克隆 */
  tts: {
    getConfig: () => ipcRenderer.invoke('tts:get-config'),
    saveConfig: (patch) => ipcRenderer.invoke('tts:save-config', patch),
    saveApiKey: (key) => ipcRenderer.invoke('tts:save-api-key', key),
    hasApiKey: () => ipcRenderer.invoke('tts:has-api-key'),
    importReference: () => ipcRenderer.invoke('tts:import-reference'),
    listReferences: () => ipcRenderer.invoke('tts:list-references'),
    removeReference: (id) => ipcRenderer.invoke('tts:remove-reference', id),
    renameReference: (id, name) => ipcRenderer.invoke('tts:rename-reference', id, name),
    synthesize: (params) => ipcRenderer.invoke('tts:synthesize', params),
  },
  modelSettings: {
    get: () => ipcRenderer.invoke('model-settings:get'),
    save: (patch) => ipcRenderer.invoke('model-settings:save', patch),
  },
  /** 自动更新：check 触发检查，download/skip/install 控制流程，其余为事件订阅 */
  updater: {
    /** 触发「检查更新」（仅打包版可用，开发模式抛错） */
    check: () => ipcRenderer.invoke('updater:check'),
    /** 读取当前应用版本号 */
    getVersion: () => ipcRenderer.invoke('updater:get-version') as Promise<string>,
    /** 用户确认「开始下载」 */
    download: () => ipcRenderer.invoke('updater:download'),
    /** 用户放弃本次更新 */
    skip: () => ipcRenderer.invoke('updater:skip'),
    /** 用户确认「立即重启安装」 */
    install: () => ipcRenderer.invoke('updater:install'),
    /** 订阅「发现新版本」事件 */
    onAvailable: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, version: string) => cb(version)
      ipcRenderer.on('updater:available', listener)
      return () => ipcRenderer.removeListener('updater:available', listener)
    },
    /** 订阅「检查完成且无新版本」事件（结束"检查中"状态） */
    onNotAvailable: (cb) => {
      const listener = () => cb()
      ipcRenderer.on('updater:not-available', listener)
      return () => ipcRenderer.removeListener('updater:not-available', listener)
    },
    /** 订阅「下载完成」事件 */
    onDownloaded: (cb) => {
      const listener = () => cb()
      ipcRenderer.on('updater:downloaded', listener)
      return () => ipcRenderer.removeListener('updater:downloaded', listener)
    },
    /** 订阅「下载进度」事件（0-100） */
    onProgress: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, percent: number) => cb(percent)
      ipcRenderer.on('updater:progress', listener)
      return () => ipcRenderer.removeListener('updater:progress', listener)
    },
    /** 订阅「检查/下载出错」事件 */
    onError: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, message: string) => cb(message)
      ipcRenderer.on('updater:error', listener)
      return () => ipcRenderer.removeListener('updater:error', listener)
    },
    /** 订阅「托盘触发检查更新」事件（设置窗已打开，等待弹窗） */
    onCheckRequest: (cb) => {
      const listener = () => cb()
      ipcRenderer.on('updater:check-request', listener)
      return () => ipcRenderer.removeListener('updater:check-request', listener)
    },
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