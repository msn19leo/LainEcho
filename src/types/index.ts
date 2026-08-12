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
  /** model3 json 相对 userData/models/{id}/ 的路径 */
  model3Path: string
  createdAt: number
}

// ---------------- Live2D 模型设置 ----------------

/** 眨眼模式：Auto = SDK 内置眨眼曲线，Force = 自定义状态机 */
export type BlinkMode = 'auto' | 'force'

/** 表情混合模式（对应 exp3.json 的 Blend 字段） */
export type ExpressionBlend = 'Add' | 'Multiply' | 'Overwrite'

/** exp3.json 中的单个表情参数 */
export interface ExpressionParameter {
  /** Cubism 参数 ID，如 ParamMouthForm */
  Id: string
  /** 参数值 */
  Value: number
  /** 混合模式 */
  Blend: ExpressionBlend
}

/** 表情元信息（从 model3.json 的 FileReferences.Expressions 解析） */
export interface ExpressionMeta {
  /** 表情名称（model3.json 中的 Name 字段） */
  name: string
  /** exp3.json 相对路径 */
  file: string
  /** 表情参数列表 */
  parameters: ExpressionParameter[]
}

/** 模型参数（对应 Cubism 标准参数 ID） */
export interface ModelParameters {
  // Head Rotation（-30~30）
  angleX: number
  angleY: number
  angleZ: number
  // Eyes（0~1）
  leftEyeOpen: number
  rightEyeOpen: number
  leftEyeSmile: number
  // Eyebrows（-1~1）
  leftEyebrowLR: number
  rightEyebrowLR: number
  leftEyebrowY: number
  rightEyebrowY: number
  leftEyebrowAngle: number
  rightEyebrowAngle: number
  leftEyebrowForm: number
  rightEyebrowForm: number
  // Mouth（0~1 / -1~1）
  mouthOpen: number
  mouthForm: number
  // Face（0~1）
  cheek: number
  // Body（-30~30）
  bodyAngleX: number
  bodyAngleY: number
  bodyAngleZ: number
  // Breath（-1~1）
  breath: number
}

/** 动画与渲染设置 */
export interface ModelAnimationSettings {
  /** 鼠标跟踪 */
  mouseTracking: boolean
  /** 眼睛偏移百分比（X/Y） */
  eyeOffsetX: number
  eyeOffsetY: number
  /** 空闲眼神动画 */
  idleEyeMovement: boolean
  /** 启用眨眼 */
  enableBlink: boolean
  /** 眨眼模式 */
  blinkMode: BlinkMode
  /** 空闲动作组名（空字符串 = 不指定） */
  idleAnimation: string
  /** 渲染缩放（影响清晰度，0.5~2） */
  renderScale: number
  /** 最大 FPS（0 = 无限制） */
  maxFps: number
  /** 投射阴影 */
  dropShadow: boolean
  /** 表情系统 */
  expressionEnabled: boolean
  /** 选中的表情名称（空字符串 = 不应用表情） */
  selectedExpression: string
}

/** 缩放与位置 */
export interface ModelViewSettings {
  scale: number
  x: number
  y: number
}

/** 完整的模型设置（持久化到 model-settings.json） */
export interface ModelSettings {
  parameters: ModelParameters
  animation: ModelAnimationSettings
  view: ModelViewSettings
  /** 当前全局选中的 Live2D 模型 id（角色卡未绑定时使用） */
  selectedModelId: string | null
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
    /** 读取指定模型的动作组名列表（从 model3.json 的 FileReferences.Motions 解析） */
    motionGroups: (modelId: string) => Promise<string[]>
    /** 读取指定模型的表情列表（从 model3.json 的 FileReferences.Expressions + exp3.json 解析） */
    expressionList: (modelId: string) => Promise<ExpressionMeta[]>
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
    /** 获取当前数据目录信息（当前路径、默认路径、是否自定义） */
    getDataDir: () => Promise<{ current: string; default: string; isCustom: boolean }>
    /** 选择新目录并迁移数据，成功后需手动重启应用 */
    changeDataDir: () => Promise<{ success: boolean; error?: string; needRestart?: boolean }>
    /** 重置数据目录为默认位置，成功后需手动重启应用 */
    resetDataDir: () => Promise<{ success: boolean; error?: string; needRestart?: boolean }>
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
    /** 订阅模型设置变化（设置窗口修改后广播到桌宠窗口） */
    onModelSettingsChanged: (cb: (settings: ModelSettings) => void) => () => void
    /** 订阅全局鼠标坐标变化（窗口相对坐标，由主进程轮询 screen.getCursorScreenPoint） */
    onCursorMove: (cb: (pos: { x: number; y: number }) => void) => () => void
  }
  /** 模型设置（缩放/位置/动画/参数） */
  modelSettings: {
    /** 读取持久化的模型设置 */
    get: () => Promise<ModelSettings>
    /** 保存模型设置（部分合并），并广播到桌宠窗口 */
    save: (patch: Partial<ModelSettings>) => Promise<void>
  }
}
