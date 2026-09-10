/**
 * preload.ts —— 通过 contextBridge 暴露白名单 API 到 window.api。
 * 安全基线：
 *   - 不做通配符透传，每个方法逐一声明
 *   - 渲染进程拿不到 ipcRenderer 原始对象，无法调用未暴露的通道
 *   - API Key 明文永不经过这里
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { AppSettings, ContextStats, StreamDonePayload, StreamErrorPayload, StreamUserPayload, ModelSettings, WindowApi } from '../src/types'

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
    onStreamUser: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: StreamUserPayload) => cb(payload)
      ipcRenderer.on('ai:stream-user', listener)
      return () => ipcRenderer.removeListener('ai:stream-user', listener)
    },
    onActiveSession: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, sessionId: string | null) => cb(sessionId)
      ipcRenderer.on('ai:active-session', listener)
      return () => ipcRenderer.removeListener('ai:active-session', listener)
    },
    cancel: () => ipcRenderer.send('ai:cancel'),
    testConnection: () => ipcRenderer.invoke('ai:test-connection'),
    compactNow: (sessionId) => ipcRenderer.invoke('ai:compact-now', { sessionId }),
    getContextStats: (sessionId) => ipcRenderer.invoke('ai:get-context-stats', { sessionId }),
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
    listPending: () => ipcRenderer.invoke('memory:list-pending'),
    add: (input) => ipcRenderer.invoke('memory:add', input),
    update: (id, patch) => ipcRenderer.invoke('memory:update', id, patch),
    confirm: (id) => ipcRenderer.invoke('memory:confirm', id),
    remove: (id) => ipcRenderer.invoke('memory:remove', id),
    onChanged: (cb) => {
      const listener = () => cb()
      ipcRenderer.on('memory:changed', listener)
      return () => ipcRenderer.removeListener('memory:changed', listener)
    },
    /** 语义搜索已确认记忆（向量检索；嵌入未配置返回空数组） */
    semanticSearch: (query, topK) => ipcRenderer.invoke('memory:semantic-search', { query, topK }),
    /** 手动重嵌全部已确认记忆 */
    reembedAll: () => ipcRenderer.invoke('memory:reembed-all'),
    /** 测试嵌入配置连通性（独立地址/模型/Key） */
    testEmbedding: () => ipcRenderer.invoke('memory:test-embedding'),
    /** 读取画像/编年史档案 */
    getProfile: (cardId) => ipcRenderer.invoke('memory:get-profile', { cardId }),
    /** 触发画像/编年史整理 */
    consolidateProfile: (cardId) => ipcRenderer.invoke('memory:consolidate-profile', { cardId }),
    /** 采纳/放弃画像草稿 */
    adoptProfile: (cardId, adopt) => ipcRenderer.invoke('memory:adopt-profile', { cardId, adopt }),
    /** 编辑已生效画像文本（空串 = 清除画像） */
    updateProfileDigest: (cardId, text) => ipcRenderer.invoke('memory:update-profile-digest', { cardId, text }),
    /** 删除已生效画像 */
    deleteProfileDigest: (cardId) => ipcRenderer.invoke('memory:delete-profile-digest', { cardId }),
    /** 编辑单条编年史条目 */
    updateChronicleEntry: (cardId, entryId, text) =>
      ipcRenderer.invoke('memory:update-chronicle-entry', { cardId, entryId, text }),
    /** 删除单条编年史条目 */
    deleteChronicleEntry: (cardId, entryId) => ipcRenderer.invoke('memory:delete-chronicle-entry', { cardId, entryId }),
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
  sprite: {
    list: () => ipcRenderer.invoke('sprite:list'),
    importFromFolder: () => ipcRenderer.invoke('sprite:import-from-folder'),
    remove: (spriteId) => ipcRenderer.invoke('sprite:remove', spriteId),
    update: (spriteId, patch) => ipcRenderer.invoke('sprite:update', spriteId, patch),
    onChanged: (cb) => {
      const listener = () => cb()
      ipcRenderer.on('pet:sprites-changed', listener)
      return () => ipcRenderer.removeListener('pet:sprites-changed', listener)
    },
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    save: (settings) => ipcRenderer.invoke('settings:save', settings),
    saveApiKey: (key) => ipcRenderer.invoke('settings:save-api-key', key),
    hasApiKey: () => ipcRenderer.invoke('settings:has-api-key'),
    /** 保存嵌入服务独立 API Key（safeStorage 加密，与主 LLM Key 隔离） */
    saveEmbeddingApiKey: (key) => ipcRenderer.invoke('settings:save-embedding-api-key', key),
    /** 嵌入服务 Key 是否已配置（仅回显掩码用） */
    hasEmbeddingApiKey: () => ipcRenderer.invoke('settings:has-embedding-api-key'),
    /** 保存屏幕感知视觉模型独立 API Key（safeStorage 加密，与主 LLM Key 隔离） */
    saveVisionApiKey: (key) => ipcRenderer.invoke('settings:save-vision-api-key', key),
    /** 视觉模型 Key 是否已配置（仅回显掩码用） */
    hasVisionApiKey: () => ipcRenderer.invoke('settings:has-vision-api-key'),
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
    /** 打开聊天窗口，并可选指定要进入的会话 id（宠物窗点开时带当前会话） */
    openChatWithSession: (sessionId) => ipcRenderer.send('app:open-chat', sessionId),
    openSettings: () => ipcRenderer.send('app:open-settings'),
    setPetCard: (payload) => ipcRenderer.send('app:set-pet-card', payload),
    quit: () => ipcRenderer.send('app:quit'),
    /** 通知桌宠窗口播放语音（AI 回复后由聊天窗口调用，触发 TTS 合成+口型同步） */
    speak: (text, voiceId, languageOverride, payload) => ipcRenderer.send('app:speak', text, voiceId, languageOverride, payload),
    /** 上报当前会话（聊天窗切会话/新建会话时调用，主进程转发给宠物窗同步内容框） */
    notifyCurrentSession: (sessionId) => ipcRenderer.send('session:current', sessionId),
    /** 宠物窗内容框高度联动：调整宠物窗总高度（模型区恒定，顶边固定向下生长） */
    setPetPanelHeight: (panelH) => ipcRenderer.send('pet:set-panel-height', panelH),
  },
  chat: {
    /** 订阅"打开聊天窗口并进入指定会话"（宠物窗点开聊天时触发，聊天窗据此 loadSession） */
    onOpenSession: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, sessionId: string) => cb(sessionId)
      ipcRenderer.on('chat:open-session', listener)
      return () => ipcRenderer.removeListener('chat:open-session', listener)
    },
    /** renderer 就绪通知（用于向主进程补发最近语音模式） */
    reportRendererReady: () => ipcRenderer.send('chat:renderer-ready'),
    /** 订阅"语音朗读到当前段落文本"（宠物窗朗读时经主进程转发），聊天窗随语音段段显示 */
    onReadingText: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, text: string) => cb(text)
      ipcRenderer.on('chat:reading-text', listener)
      return () => ipcRenderer.removeListener('chat:reading-text', listener)
    },
    /** 订阅"语音朗读是否进行中"（控制聊天窗跳动光标的显隐） */
    onReadingActive: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, active: boolean) => cb(active)
      ipcRenderer.on('chat:reading-active', listener)
      return () => ipcRenderer.removeListener('chat:reading-active', listener)
    },
    /** 订阅流式开始的"本轮语音模式"，与宠物窗一致决定段落跟读显示 */
    onVoiceMode: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, opts: { voiceEnabled: boolean }) => cb(opts)
      ipcRenderer.on('chat:voice-mode', listener)
      return () => ipcRenderer.removeListener('chat:voice-mode', listener)
    },
  },
  pet: {
    onCardChanged: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: import('../src/types').PetCardPayload) => cb(payload)
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
      const listener = (_e: Electron.IpcRendererEvent, payload: { text: string; voiceId: string | null; languageOverride: import('../src/types').TTSLanguage | null; chunks?: import('../src/types').DialogueChunk[]; follow?: boolean; engine?: 'genie' | 'mimo'; genieOverride?: import('../src/types').CharacterGenieOverride | null }) => cb(payload)
      ipcRenderer.on('pet:speak', listener)
      return () => ipcRenderer.removeListener('pet:speak', listener)
    },
    /** renderer 就绪通知（用于向主进程补发最近语音模式） */
    reportRendererReady: () => ipcRenderer.send('pet:renderer-ready'),
    /** 上报宠物窗"当前已朗读到"的段落文本（段变化时调用），经主进程转发给聊天窗随语音显示 */
    reportReadingText: (text: string) => ipcRenderer.send('pet:reading-text', text),
    /** 上报语音朗读是否进行中（经主进程转发给聊天窗控制跳动光标显隐） */
    reportReadingActive: (active: boolean) => ipcRenderer.send('pet:reading-active', active),
    /** 订阅 AI 回复情绪事件（主进程聊天完成时广播，桌宠切表情/切立绘） */
    onEmotion: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, emotion: import('../src/types').StandardEmotion) => cb(emotion)
      ipcRenderer.on('pet:emotion', listener)
      return () => ipcRenderer.removeListener('pet:emotion', listener)
    },
    /** 订阅"思考中"状态（AI 准备回答到输出前），立绘切思考立绘 */
    onThinking: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, thinking: boolean) => cb(thinking)
      ipcRenderer.on('pet:thinking', listener)
      return () => ipcRenderer.removeListener('pet:thinking', listener)
    },
    /** 订阅流式开始时的"本轮语音模式"（是否有语音），提前决定文本展示 */
    onVoiceMode: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, opts: { voiceEnabled: boolean }) => cb(opts)
      ipcRenderer.on('pet:voice-mode', listener)
      return () => ipcRenderer.removeListener('pet:voice-mode', listener)
    },
    /** 订阅"当前会话变化"（聊天窗切会话/新建会话时主进程转发，宠物窗内容框同步） */
    onCurrentSessionChanged: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, sessionId: string | null) => cb(sessionId)
      ipcRenderer.on('session:current', listener)
      return () => ipcRenderer.removeListener('session:current', listener)
    },
    /** 订阅主进程广播的上下文 token 用量（每次 AI 组装 / 手动压缩后更新） */
    onContextStats: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, stats: ContextStats) => cb(stats)
      ipcRenderer.on('ai:context-stats', listener)
      return () => ipcRenderer.removeListener('ai:context-stats', listener)
    },
    /** 订阅设置变更（保存后主进程广播，桌宠窗同步「模型上下文窗口」等展示字段） */
    onSettingsChanged: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, settings: AppSettings) => cb(settings)
      ipcRenderer.on('settings:changed', listener)
      return () => ipcRenderer.removeListener('settings:changed', listener)
    },
    modelUrl: (modelId, model3Path) => `pet-res://models/${modelId}/${model3Path}`,
    spriteUrl: (spriteId, filePath) => `pet-res://sprites/${spriteId}/${filePath}`,
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
    genieConfig: () => ipcRenderer.invoke('tts:genie-config'),
    genieSaveConfig: (patch) => ipcRenderer.invoke('tts:genie-save-config', patch),
    genieCheck: (baseUrl) => ipcRenderer.invoke('tts:genie-check', baseUrl),
    genieStart: (workPath, dataDir) => ipcRenderer.invoke('tts:genie-start', workPath, dataDir),
    chooseFolder: () => ipcRenderer.invoke('tts:choose-folder'),
    chooseAudioFile: () => ipcRenderer.invoke('tts:choose-audio-file'),
  },
  /** 角色 TTS 模型卡管理 */
  ttsModel: {
    list: () => ipcRenderer.invoke('tts-model:list'),
    create: (input) => ipcRenderer.invoke('tts-model:create', input),
    update: (id, input) => ipcRenderer.invoke('tts-model:update', id, input),
    delete: (id) => ipcRenderer.invoke('tts-model:delete', id),
  },
  modelSettings: {
    get: () => ipcRenderer.invoke('model-settings:get'),
    save: (patch) => ipcRenderer.invoke('model-settings:save', patch),
  },
  /** 主动搭话：调度状态查询/订阅 */
  proactive: {
    /** 读取调度状态（兴趣值/当日次数/最近搭话时间） */
    getState: () => ipcRenderer.invoke('proactive:get-state') as Promise<import('../src/types').ProactiveState>,
    /** 订阅调度状态变化（每次成功搭话/用户消息重置后广播），返回取消订阅函数 */
    onState: (cb: (state: import('../src/types').ProactiveState) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, state: import('../src/types').ProactiveState) => cb(state)
      ipcRenderer.on('proactive:state', listener)
      return () => ipcRenderer.removeListener('proactive:state', listener)
    },
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