/**
 * 共享类型定义 —— 主进程（electron/）与渲染进程（src/）复用。
 * 主进程通过 preload.ts 将 window.api 白名单方法暴露给渲染进程。
 */

export type ChatRole = 'system' | 'user' | 'assistant'

/** 句子级情绪段：从某一句起切换到该情绪（炉语联动用） */
export interface EmotionSegment {
  /** 起始消息内句子索引（0 基，来自 splitSentences） */
  startSentence: number
  emotion: StandardEmotion
}

/** 语音合成分段：一次回复的一个"对话段"（JSON dialogue 一项），整段一次合成，段内不再按标点切碎 */
export interface DialogueChunk {
  text: string
  emotion: StandardEmotion
}

/** 单条聊天消息（落盘到 sessions/{id}.json 的 messages 数组） */
export interface ChatMessage {
  role: ChatRole
  content: string
  timestamp?: number
  /**
   * AI 回复的结构化情绪标签（仅 assistant 消息；缺省 = 未解析/平静）。
   * 由主进程从回复末尾的 {@emotion:xxx} 标签解析并归一化到标准情绪。
   */
  emotion?: StandardEmotion
  /** 按标点切分的句子序列（语音/朗读句级同步与高亮共用，仅 assistant 消息） */
  sentences?: string[]
  /** 句子级情绪切换点（内嵌 {@emo:xxx} 解析所得，仅 assistant 消息） */
  emotionSegments?: EmotionSegment[]
  /** 语音合成分段（JSON dialogue 逐项，段级合成与切换立绘用，仅 assistant 消息） */
  chunks?: DialogueChunk[]
}

/** 角色卡 schema 版本，用于未来迁移 */
export const CHARACTER_CARD_VERSION = 2

/** 角色级 TTS 配置覆盖：解决日文/中文角色共用全局 language 的问题。null 字段表示跟随全局 */
export interface CharacterTTSOverride {
  /** null = 跟随全局；'zh'/'ja' = 角色强制语言 */
  language: TTSLanguage | null
}

/** 角色级模型设置覆盖：让同一 Live2D 模型在不同角色下有不同表情/待机动作。null 字段表示跟随全局 */
export interface CharacterModelOverride {
  /** null = 跟随全局；空串 = 清除表情 */
  selectedExpression: string | null
  /** null = 跟随全局；空串 = 无待机动作 */
  idleAnimation: string | null
}

/**
 * 角色卡 · 人设结构（动漫角色复刻模板，混合式）。
 * 全部为可选字段，运行时只注入非空字段，控制 system prompt 长度。
 * 组装顺序（优先级从高到低）：存在锚点 → 内心结构 → 感知方式 → 关系模式 →
 * 语言质感 → 状态系统 → 世界观碎片 → 禁止项 → 自由补充。
 */
export interface CharacterPersona {
  /** 〇 存在锚点：1-3 句话定义角色的本质（不是介绍，是定性），注入最前、优先级最高 */
  anchor: string
  /** 〇 内心结构 */
  inner: {
    /** 核心渴望：真正想要什么（最深的驱动） */
    desire: string
    /** 内在恐惧：本能回避什么、什么会让她/他动摇 */
    fear: string
    /** 核心矛盾：A，但同时又 B 的张力，以及如何体现在行为中 */
    conflict: string
    /** 自我认知状态：她/他怎么看自己，认知是否准确、盲区在哪 */
    selfView: string
  }
  /** 〇 感知方式 */
  perception: {
    /** 她/他注意什么：对什么敏感、会忽略什么 */
    attention: string
    /** 情绪处理机制：表达还是内化、爆发还是沉默 */
    emotion: string
    /** 对外部世界的态度：世界在她/他眼里什么样，人是否可信 */
    worldview: string
  }
  /** 〇 关系模式 */
  relation: {
    /** 靠近人的方式：主动还是被动、直接还是迂回 */
    approach: string
    /** 亲密建立的节奏：怎么从陌生到熟悉、何时真正打开 */
    intimacy: string
    /** 她/他的边界：不可触碰之物、被越界时的反应 */
    boundary: string
    /** 对"被需要"的态度：喜欢还是抗拒、怎么回应依赖 */
    need: string
  }
  /** 〇 你的身份：角色与"你"的具体关系设定（承接关系模式，引出语言质感） */
  you: {
    /** 你是谁：在角色世界里你的身份定位（原作角色/原创/无身份观察者），含名字/年龄/相识时长 */
    identity: string
    /** 你们之间的关系：是什么连接彼此、处于什么阶段（写"是什么让我们走到现在"，不写"我们是好朋友"类结论） */
    bond: string
    /** AI 角色怎么看你：从角色视角写如何感知你，允许"还没搞清楚"的不确定性 */
    stance: string
    /** 特殊约定或记忆：只属于你们的细节，每行一条，越小越好 */
    memories: string[]
  }
  /** 〇 语言质感 */
  language: {
    /** 说话节奏：快/慢、停顿、留白 */
    rhythm: string
    /** 用词特征：正式/口语、习惯句式 */
    words: string
    /** 不会说的话：5-8 句"出戏"的表达（比正面描述更有效） */
    neverSay: string[]
    /** 特殊的语言行为：反问、自言自语、重复、口头禅等 */
    habits: string
  }
  /** 〇 状态系统 */
  state: {
    /** 日常状态：默认的样子 */
    daily: string
    /** 触发变化的开关：什么会让她/他突然不一样 */
    triggers: string
    /** 不同情境下的状态变化：开心/难过/被激怒/感到安全/感到危险 */
    situations: string
  }
  /** 〇 世界观碎片：3-6 条角色会真实说出口的观点（角色口吻） */
  worldview: string[]
  /** 〇 禁止项：精简为 3-5 条最高优先级的硬性边界 */
  prohibitions: string[]
  /** 〇 自由补充：模板之外的自定义内容 */
  extra: string
}

/** 角色卡：AI 桌宠的"身份"与"意识"，人设采用动漫角色复刻结构（CharacterPersona） */
export interface CharacterCard {
  id: string
  name: string
  /** schema 版本号，迁移用 */
  version: number

  /** 人设结构（存在锚点/内心结构/感知方式/关系模式/语言质感/状态系统/世界观碎片/禁止项/自由补充） */
  persona: CharacterPersona

  // --- 对话增强 ---
  /** 示例对话 few-shot，格式 "{{char}}: xxx\n{{user}}: yyy"，作为 system prompt 的一部分注入 */
  messageExample: string

  // --- 绑定 ---
  /** 绑定的 Live2D 模型 id（null = 使用全局当前模型） */
  modelId: string | null
  /** 绑定的参考音频 id（null = 不启用 TTS） */
  voiceId: string | null

  // --- 形象呈现（2D 立绘 / Live2D 并行切换）---
  /** 形象渲染模式：'live2d'（默认）| 'sprite'（2D 静态立绘） */
  renderMode: RenderMode | null
  /** 绑定的立绘集 id（null = 未绑定；renderMode='sprite' 时生效） */
  spriteId: string | null
  /** 立绘模式的情绪映射：8 情绪 → 立绘集内图片文件名。缺项回退 neutral */
  emotionMap: Partial<Record<StandardEmotion, string>> | null
  /** Live2D 模式的情绪映射（可选）：8 情绪 → 现有 exp3.json 表情名。缺项跟随全局/覆盖表情 */
  live2dExpressionMap: Partial<Record<StandardEmotion, string>> | null

  /** 角色级配置覆盖（null = 跟随全局）--- */
  /** TTS 配置覆盖：解决日文/中文角色共用全局 language 的问题 */
  ttsOverride: CharacterTTSOverride | null
  /** 模型设置覆盖：让同模型不同角色有不同表情/待机动作 */
  modelOverride: CharacterModelOverride | null

  /** 头像文件名（相对 avatars/，null = 用首字占位） */
  avatar: string | null
  createdAt: number
  updatedAt: number
}

/** 桌宠窗口切换角色卡的形象同步负载：Live2D 模型 + 立绘/渲染模式 + 情绪映射 */
export interface PetCardPayload {
  /** 角色卡 id（宠物窗用于同步当前角色名的名牌显示） */
  cardId?: string | null
  /** 绑定的 Live2D 模型 id（null = 使用全局当前模型） */
  modelId: string | null
  /** 模型设置覆盖（表情/待机动作），null = 跟随全局 */
  modelOverride: CharacterModelOverride | null
  /** 形象渲染模式：null = 跟随默认（live2d） */
  renderMode: RenderMode | null
  /** 绑定的立绘集 id（renderMode='sprite' 时生效） */
  spriteId: string | null
  /** 立绘模式情绪映射：情绪 → 立绘集内文件名 */
  emotionMap: Partial<Record<StandardEmotion, string>> | null
  /** Live2D 模式情绪映射：情绪 → exp3 表情名 */
  live2dExpressionMap: Partial<Record<StandardEmotion, string>> | null
}

/** 角色卡创建/更新时的业务输入字段（不含 id/时间戳/版本，由主进程生成） */
export type CharacterCardInput = Pick<
  CharacterCard,
  | 'name'
  | 'persona'
  | 'messageExample'
  | 'modelId'
  | 'voiceId'
  | 'ttsOverride'
  | 'modelOverride'
  | 'renderMode'
  | 'spriteId'
  | 'emotionMap'
  | 'live2dExpressionMap'
  | 'avatar'
>

/** AI 生成角色人设的入参：角色名（可选）+ 角色来源描述（必填，可贴原作设定/台词/简介） */
export interface PersonaGenerateInput {
  name: string
  source: string
}

/** 参考音频元信息（voices/index.json，用于 MiMo 声音克隆） */
export interface VoiceReference {
  id: string
  /** 用户起名，如"小夜子声线" */
  name: string
  /** 相对 voices/ 的文件名（如 voice_xxx.wav） */
  filePath: string
  /** 音频时长（秒），0 表示未解析 */
  durationSec: number
  createdAt: number
}

/** TTS 输出语言（影响 MiMo 合成的语言指令） */
export type TTSLanguage = 'zh' | 'ja'

/** TTS 全局配置（voice-settings.json，非敏感） */
export interface TTSConfig {
  /** 输出语言：中文 / 日文 */
  language: TTSLanguage
  /** MiMo 模型名（如 mimo-v2.5-tts-voiceclone） */
  model: string
  /** 语音是否跟读文本：开启后桌宠"说一个字出一个字"，文本随音频播放逐段 reveal */
  followText: boolean
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

// ---------------- 情绪标签（结构化情绪输出） ----------------

/**
 * 标准情绪：AI 回复的情绪标签、角色卡情绪映射的唯一定义。
 * 顺序即语义，全小写下划线命名，保证 prompt 与解析一致。
 * 原「担心」「亲近」已删除，分别回退到 sad(难过) / happy(开心)。
 * 解析失败 / 缺图一律回退 DEFAULT_EMOTION(neutral)，保证任何输入都有确定输出。
 */
export const STANDARD_EMOTIONS = [
  'neutral', // 平静：默认/兜底
  'happy', // 开心
  'sad', // 难过
  'angry', // 生气
  'surprised', // 惊讶
  'shy', // 害羞
] as const

export type StandardEmotion = (typeof STANDARD_EMOTIONS)[number]

/** 兜底情绪：任何未映射/解析失败的情绪都收敛到这里 */
export const DEFAULT_EMOTION: StandardEmotion = 'neutral'

// ---------------- 2D 立绘 ----------------

/** 立绘渲染模式：Live2D 动画 或 2D 静态切图（并行切换，统一形象层分发） */
export type RenderMode = 'live2d' | 'sprite'

/** 立绘集内单张图片：按情绪映射的目标文件（相对 sprites/{id}/） */
export interface CharacterSpriteImage {
  /** 文件名（含扩展名，相对 userData/sprites/{id}/） */
  filePath: string
}

/**
 * 立绘集元信息（sprites/index.json）。
 * 一个立绘集 = 导入的一个文件夹，内含多张情绪切图（png/jpg/webp 等）。
 * 通过角色卡的 emotionMap 或本集的 emotionMap 把 8 标准情绪映射到某张图。
 */
export interface CharacterSprite {
  id: string
  /** 展示名，默认取导入文件夹名 */
  name: string
  /** 该立绘集下的图片列表 */
  images: CharacterSpriteImage[]
  /** 立绘集自身的情绪 → 立绘图 映射（全局使用该立绘集时生效，缺项回退 neutral/首图） */
  emotionMap: Partial<Record<StandardEmotion, string>> | null
  /** 说话立绘图（相对文件路径，空 = 未配置）：情绪为平静且正在说话时使用 */
  speakingImage: string | null
  /** 思考立绘图（相对文件路径，空 = 未配置）：AI 开始准备回答到输出文本前使用 */
  thinkingImage: string | null
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
  /** 2D 立绘集的缩放与位置（与 Live2D view 独立） */
  spriteView: ModelViewSettings
  /** 当前全局选中的 Live2D 模型 id（角色卡未绑定时使用） */
  selectedModelId: string | null
  /** 当前全局选中的 2D 立绘集 id（角色卡未绑定时、且立绘模式下使用） */
  selectedSpriteId: string | null
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

/** AI 流式用户消息广播（跟随窗口即时补上用户气泡） */
export interface StreamUserPayload {
  sessionId: string
  content: string
  timestamp: number
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
    /** 订阅主进程广播的用户消息（跟随窗口即时补上用户气泡，无需等 stream-done 全量拉取） */
    onStreamUser: (cb: (payload: StreamUserPayload) => void) => () => void
    /** 订阅"进行中的流"会话 id 补发（窗口重载/就绪后，用于认领漏掉的当前会话；null 表示无流） */
    onActiveSession: (cb: (sessionId: string | null) => void) => () => void
    /** 取消当前流式请求 */
    cancel: () => void
    testConnection: () => Promise<TestConnectionResult>
  }
  characterCard: {
    list: () => Promise<CharacterCard[]>
    /** 创建角色卡：传业务字段，id/时间戳/版本由主进程生成 */
    create: (card: CharacterCardInput) => Promise<CharacterCard>
    /** 更新角色卡：传部分业务字段 */
    update: (id: string, patch: Partial<CharacterCardInput>) => Promise<void>
    remove: (id: string) => Promise<void>
    /** 用 AI 按角色来源描述生成人设草稿（返回结构化的 CharacterPersona，不入库） */
    generate: (input: PersonaGenerateInput) => Promise<CharacterPersona>
    /** 订阅角色卡列表变化（其他窗口增删改时），返回取消订阅函数 */
    onChanged: (cb: () => void) => () => void
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
    /** 修改会话标题（Data 面板重命名） */
    rename: (id: string, title: string) => Promise<void>
    exportMarkdown: (id: string) => Promise<ExportResult | null>
    /** 订阅会话列表变化（其他窗口新建/删除/重命名会话时），返回取消订阅函数 */
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
  sprite: {
    /** 列出所有已导入的立绘集 */
    list: () => Promise<CharacterSprite[]>
    /** 弹原生文件夹选择框导入立绘集（复制到 userData/sprites/），返回导入结果 */
    importFromFolder: () => Promise<CharacterSprite | null>
    /** 删除指定立绘集（同时删除资源目录与索引条目） */
    remove: (spriteId: string) => Promise<void>
    /** 更新立绘集展示资产：情绪→立绘图映射 / 说话立绘 / 思考立绘 */
    update: (spriteId: string, patch: Partial<Pick<CharacterSprite, 'emotionMap' | 'speakingImage' | 'thinkingImage'>>) => Promise<void>
    /** 订阅立绘集列表变化（导入/删除后刷新），返回取消订阅函数 */
    onChanged: (cb: () => void) => () => void
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
    /** 打开聊天窗口，并可指定要进入的会话 id（宠物窗点开时带当前会话） */
    openChatWithSession: (sessionId: string) => void
    openSettings: () => void
    /** 通知桌宠窗口切换角色卡（模型 + 表情/待机动作覆盖 + 立绘/渲染模式 + 情绪映射） */
    setPetCard: (payload: PetCardPayload) => void
    quit: () => void
    /** 通知桌宠窗口播放语音（AI 回复后由聊天窗口调用，触发 TTS 合成+口型同步）。
     *  payload 携带主进程切好的合成分段（dialogue 逐项），供桌宠段级合成并联动。 */
    speak: (
      text: string,
      voiceId: string | null,
      languageOverride?: TTSLanguage | null,
      payload?: { chunks?: DialogueChunk[] },
    ) => void
    /** 上报当前会话（聊天窗切会话/新建会话时调用，主进程转发给宠物窗同步内容框；null 表示清空） */
    notifyCurrentSession: (sessionId: string | null) => void
    /** 宠物窗内容框高度联动：调整宠物窗总高度（模型区恒定，顶边固定向下生长） */
    setPetPanelHeight: (panelH: number) => void
  }
  pet: {
    /** 订阅角色卡切换事件（chat 窗口切卡后同步模型/覆盖/立绘到桌宠） */
    onCardChanged: (cb: (payload: PetCardPayload) => void) => () => void
    /** 订阅 Live2D 模型列表变化（导入/删除后刷新） */
    onModelsChanged: (cb: () => void) => () => void
    /** 订阅 Cubism Core 运行库导入事件（导入后桌宠重新初始化） */
    onCoreChanged: (cb: () => void) => () => void
    /** 获取 Live2D 模型资源的 file:// 前缀（用于拼 model3.json 地址） */
    modelUrl: (modelId: string, model3Path: string) => string
    /** 拼接立绘图片资源地址（pet-res://sprites/{spriteId}/{filePath}） */
    spriteUrl: (spriteId: string, filePath: string) => string
    /** 订阅模型设置变化（设置窗口修改后广播到桌宠窗口） */
    onModelSettingsChanged: (cb: (settings: ModelSettings) => void) => () => void
    /** 订阅全局鼠标坐标变化（窗口相对坐标，由主进程轮询 screen.getCursorScreenPoint） */
    onCursorMove: (cb: (pos: { x: number; y: number }) => void) => () => void
    /** 订阅"说话"事件（聊天窗口 AI 回复后触发，桌宠窗口合成并播放语音+口型同步），
     *  payload 含主进程拆好的合成分段（dialogue 逐项）供段级合成播放 */
    onSpeak: (cb: (payload: { text: string; voiceId: string | null; languageOverride: TTSLanguage | null; chunks?: DialogueChunk[]; follow?: boolean }) => void) => () => void
    /** 订阅 AI 回复情绪事件（主进程在聊天完成时广播，驱动桌宠切表情/切立绘） */
    onEmotion: (cb: (emotion: StandardEmotion) => void) => () => void
    /** 订阅"思考中"状态（AI 开始准备回答到输出文本前），立绘模式切思考立绘 */
    onThinking: (cb: (thinking: boolean) => void) => () => void
    /** 订阅流式开始时的"本轮语音模式"（是否有语音 / 是否跟读），宠物窗提前决定文本展示方式 */
    onVoiceMode: (cb: (opts: { voiceEnabled: boolean; followText: boolean }) => void) => () => void
    /** 上报宠物窗"当前已朗读到"的段落文本（段变化时调用），经主进程转发给聊天窗随语音显示 */
    reportReadingText: (text: string) => void
    /** 上报语音朗读是否进行中（经主进程转发给聊天窗控制光标显隐） */
    reportReadingActive: (active: boolean) => void
    /** renderer 就绪通知（用于向主进程补发最近的语音模式） */
    reportRendererReady: () => void
    /** 订阅"当前会话变化"（聊天窗切会话/新建会话时主进程转发，宠物窗内容框同步） */
    onCurrentSessionChanged: (cb: (sessionId: string | null) => void) => () => void
  }
  /** 语音合成（TTS）：MiMo 声音克隆 */
  tts: {
    /** 读取 TTS 配置（含 API Key 是否已配置，不回显明文） */
    getConfig: () => Promise<TTSConfig & { hasApiKey: boolean }>
    /** 保存 TTS 配置（语言、自动播放），返回保存后的完整配置 */
    saveConfig: (patch: Partial<TTSConfig>) => Promise<TTSConfig>
    /** 单独保存 MiMo API Key（加密存储，与 LLM Key 隔离） */
    saveApiKey: (key: string) => Promise<void>
    /** MiMo API Key 是否已配置 */
    hasApiKey: () => Promise<boolean>
    /** 弹原生文件选择框并导入参考音频（wav/mp3，建议 5-30 秒）。
     *  返回 voice + 质量警告（时长不在推荐范围时非空）。 */
    importReference: () => Promise<{ voice: VoiceReference; warning: string | null } | null>
    /** 列出所有已导入的参考音频 */
    listReferences: () => Promise<VoiceReference[]>
    /** 删除指定参考音频（同时删除文件与索引条目） */
    removeReference: (id: string) => Promise<void>
    /** 合成语音：传入文本与参考音频 id，返回 wav 格式的 ArrayBuffer。
     *  languageOverride 覆盖全局语言（角色级 TTS 覆盖）。 */
    synthesize: (params: { text: string; voiceId: string; languageOverride?: TTSLanguage | null }) => Promise<ArrayBuffer | null>
    /** 重命名参考音频，返回更新后的对象 */
    renameReference: (id: string, name: string) => Promise<VoiceReference>
  }
  /** 模型设置（缩放/位置/动画/参数） */
  modelSettings: {
    /** 读取持久化的模型设置 */
    get: () => Promise<ModelSettings>
    /** 保存模型设置（部分合并），并广播到桌宠窗口 */
    save: (patch: Partial<ModelSettings>) => Promise<void>
  }
  /** 聊天窗口事件（宠物窗点开聊天时进入指定会话） */
  chat: {
    /** 订阅"打开聊天窗口并进入指定会话"，聊天窗据此 loadSession；返回取消订阅函数 */
    onOpenSession: (cb: (sessionId: string) => void) => () => void
    /** 订阅"语音朗读到当前段落文本"（宠物窗朗读时经主进程转发），聊天窗随语音段段显示 */
    onReadingText: (cb: (text: string) => void) => () => void
    /** 订阅"语音朗读是否进行中"（控制聊天窗跳动光标显隐） */
    onReadingActive: (cb: (active: boolean) => void) => () => void
    /** 订阅流式开始的"本轮语音模式"，与宠物窗一致决定段落跟读显示 */
    onVoiceMode: (cb: (opts: { voiceEnabled: boolean; followText: boolean }) => void) => () => void
    /** renderer 就绪通知（用于向主进程补发最近的语音模式） */
    reportRendererReady: () => void
  }
  /** 自动更新：check 触发检查，download/skip/install 控制流程，其余为事件订阅 */
  updater: {
    /** 触发「检查更新」（仅打包版可用，开发模式抛错） */
    check: () => Promise<void>
    /** 读取当前应用版本号 */
    getVersion: () => Promise<string>
    /** 用户确认「开始下载」 */
    download: () => Promise<void>
    /** 用户放弃本次更新 */
    skip: () => Promise<void>
    /** 用户确认「立即重启安装」 */
    install: () => Promise<void>
    /** 订阅「发现新版本」事件（传新版本号），返回取消订阅函数 */
    onAvailable: (cb: (version: string) => void) => () => void
    /** 订阅「检查完成且无新版本」事件（结束"检查中"状态），返回取消订阅函数 */
    onNotAvailable: (cb: () => void) => () => void
    /** 订阅「下载完成」事件，返回取消订阅函数 */
    onDownloaded: (cb: () => void) => () => void
    /** 订阅「下载进度」事件（0-100），返回取消订阅函数 */
    onProgress: (cb: (percent: number) => void) => () => void
    /** 订阅「检查/下载出错」事件，返回取消订阅函数 */
    onError: (cb: (message: string) => void) => () => void
    /** 订阅「托盘触发检查更新」事件（设置窗已打开，等待弹窗），返回取消订阅函数 */
    onCheckRequest: (cb: () => void) => () => void
  }
}