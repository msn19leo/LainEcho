/**
 * 共享类型定义 —— 主进程（electron/）与渲染进程（src/）复用。
 * 主进程通过 preload.ts 将 window.api 白名单方法暴露给渲染进程。
 */

export type ChatRole = 'system' | 'user' | 'assistant'

/** 单条聊天消息（落盘到 sessions/{id}.json 的 messages 数组） */
export interface ChatMessage {
  role: ChatRole
  content: string
  timestamp?: number
}

/** 角色卡：AI 桌宠的“身份”与“意识”，分开配置 */
export interface CharacterCard {
  id: string
  name: string
  /** 身份：角色是什么（身份设定），作为 system prompt 的一部分注入 */
  identity: string
  /** 意识：角色的思维、行为方式、说话习惯，作为 system prompt 的一部分注入 */
  consciousness: string
  /** 可选：绑定的 Live2D 模型 id（不绑定则使用全局当前模型） */
  modelId: string | null
  createdAt: number
  updatedAt: number
}

/** 记忆体：用户手动维护的全局固定记忆条目 */
export interface MemoryItem {
  id: string
  content: string
  createdAt: number
}

/** 会话索引条目（sessions/index.json，不含消息正文，用于列表/搜索/筛选） */
export interface SessionIndexItem {
  id: string
  title: string
  characterCardId: string
  characterCardName: string
  createdAt: number
  updatedAt: number
  messageCount: number
}

/** 单个会话的完整消息记录（sessions/{id}.json） */
export interface SessionDetail {
  id: string
  characterCardId: string
  messages: ChatMessage[]
}

/** 主题模式：dark / light / system（跟随系统 prefers-color-scheme） */
export type ThemeMode = 'dark' | 'light' | 'system'

/** 非敏感 API 配置（settings.json） */
export interface AppSettings {
  baseURL: string
  model: string
  temperature: number
  maxTokens: number
  stream: boolean
  theme: ThemeMode
}

/** Live2D 模型元信息（models/index.json） */
export interface Live2DModelMeta {
  id: string
  /** 展示名，默认取导入文件夹名 */
  name: string
  /** model3.json 相对 userData/models/{id}/ 的路径 */
  model3Path: string
  createdAt: number
}

/** 会话导出结果为 Markdown 时返回 */
export interface ExportResult {
  savedPath: string
}

export interface TestConnectionResult {
  ok: boolean
  error?: string
  data?: string
}

/** AI 流式输出事件负载 */
export interface StreamDonePayload {
  sessionId: string
  message: ChatMessage
}

/** AI 流式出错 / 取消事件负载 */
export interface StreamErrorPayload {
  sessionId: string
  error: string
  /** true 表示用户主动点击「停止」（cancel），非真实错误 */
  cancelled?: boolean
}

/** 桌宠窗口交互（拖动/缩放） */
export interface WindowState {
  x: number
  y: number
  width: number
  height: number
}

/**
 * preload.ts 暴露到 window.api 的白名单 API 契约。
 * 渲染进程只能调用这里声明的能力，不做通配符透传。
 */
export interface WindowApi {
  ai: {
    /** 发送消息；主进程组装 system prompt（人设+记忆）、发起流式请求、持久化 */
    sendMessage: (params: { sessionId: string; messages: ChatMessage[] }) => Promise<ChatMessage>
    /** 订阅流式 token 片段，返回取消订阅函数 */
    onStreamChunk: (cb: (chunk: string) => void) => () => void
    onStreamDone: (cb: (payload: StreamDonePayload) => void) => () => void
    onStreamError: (cb: (payload: StreamErrorPayload) => void) => () => void
    /** 取消当前流式请求 */
    cancel: () => void
    testConnection: () => Promise<TestConnectionResult>
  }
  characterCard: {
    list: () => Promise<CharacterCard[]>
    create: (card: Omit<CharacterCard, 'id' | 'createdAt' | 'updatedAt'>) => Promise<CharacterCard>
    update: (
      id: string,
      patch: Partial<Pick<CharacterCard, 'name' | 'identity' | 'consciousness' | 'modelId'>>,
    ) => Promise<void>
    remove: (id: string) => Promise<void>
  }
  memory: {
    list: () => Promise<MemoryItem[]>
    add: (content: string) => Promise<MemoryItem>
    update: (id: string, content: string) => Promise<void>
    remove: (id: string) => Promise<void>
  }
  session: {
    list: () => Promise<SessionIndexItem[]>
    get: (id: string) => Promise<SessionDetail>
    create: (params: { characterCardId: string }) => Promise<SessionIndexItem>
    remove: (id: string) => Promise<void>
    exportMarkdown: (id: string) => Promise<ExportResult | null>
    /** 订阅会话列表变化（其他窗口新建/删除会话时），返回取消订阅函数 */
    onChanged: (cb: () => void) => () => void
  }
  model: {
    list: () => Promise<Live2DModelMeta[]>
    /** 弹原生文件夹选择框并导入 Live2D 模型 */
    importFromFolder: () => Promise<Live2DModelMeta | null>
    remove: (modelId: string) => Promise<void>
    /** Cubism Core 运行库是否已就绪 */
    coreStatus: () => Promise<{ present: boolean; path: string | null }>
    /** 弹原生文件选择框导入 live2dcubismcore.min.js */
    importCore: () => Promise<{ present: boolean; path: string | null }>
  }
  settings: {
    /** 返回非敏感配置 + 是否已配置 Key（不回显明文） */
    get: () => Promise<AppSettings & { hasApiKey: boolean }>
    save: (settings: Partial<AppSettings>) => Promise<void>
    saveApiKey: (key: string) => Promise<void>
    hasApiKey: () => Promise<boolean>
  }
  /** 窗口控制（自定义标题栏、桌宠拖动缩放等） */
  win: {
    minimize: () => void
    toggleMaximize: () => void
    close: () => void
    isMaximized: () => Promise<boolean>
    onMaximizedChange: (cb: (maximized: boolean) => void) => () => void
    getPosition: () => Promise<{ x: number; y: number }>
    /** 相对当前位置移动窗口（保留，兼容） */
    moveBy: (dx: number, dy: number) => Promise<void>
    /** 绝对定位窗口（桌宠拖动用：窗口左上角 = 指针屏幕坐标 - 抓取点偏移） */
    setPosition: (x: number, y: number) => Promise<void>
    getSize: () => Promise<{ width: number; height: number }>
    setSize: (width: number, height: number) => Promise<void>
  }
  /** 应用级操作（桌宠唤起聊天、托盘、模型同步等） */
  app: {
    openChat: () => void
    openSettings: () => void
    /** 通知桌宠窗口切换 Live2D 模型 */
    setPetModel: (modelId: string | null) => void
    /** 通知桌宠窗口切换角色卡（刷新人设提示，可选） */
    quit: () => void
  }
  pet: {
    /** 订阅角色卡切换事件（chat 窗口切卡后同步到桌宠） */
    onModelChanged: (cb: (modelId: string | null) => void) => () => void
    /** 订阅 Live2D 模型列表变化（导入/删除后刷新） */
    onModelsChanged: (cb: () => void) => () => void
    /** 订阅 Cubism Core 运行库导入事件（导入后桌宠重新初始化） */
    onCoreChanged: (cb: () => void) => () => void
    /** 获取 Live2D 模型资源的 file:// 前缀（用于拼 model3.json 地址） */
    modelUrl: (modelId: string, model3Path: string) => string
  }
}
