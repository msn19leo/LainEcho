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
/** 消息来源标记（落盘持久化，用于 UI 弱化渲染与记忆抽取豁免等） */
export interface ChatMessageMeta {
  /** 主动搭话旁白消息（主进程写入，渲染为弱化旁白样式，不参与记忆抽取） */
  proactive?: boolean
  /** 剧情演出消息标记（仅存在于剧情 run 存档的 messages 中，聊天会话不会出现） */
  story?: boolean
  /**
   * 剧情消息子类（仅 meta.story=true 时有意义）：
   * - narration：剧本旁白/导演指令 → 剧情窗居中斜体呈现；
   * - player：剧本编排的玩家独白 → 剧情窗对话框呈现（backlog 同步）；
   * - choice：玩家选择的选项文本 → 只入 backlog，不占对话框；
   * - free：自由对话轮的真实用户输入 → 只入 backlog，不占对话框；
   * - 缺省：assistant 台词 → 正常呈现。
   */
  storyKind?: 'narration' | 'player' | 'choice' | 'free'
  /**
   * AI 背景联动（仅剧情 AI 轮次的 assistant 消息；设计文档 7.3）：
   * 模型在输出 JSON 顶层输出的可选 "background" 键原样透传，
   * 引擎校验其在背景清单内后走现有 background 事件通道。
   */
  storyBackground?: string
}

export interface ChatMessage {
  role: ChatRole
  content: string
  timestamp?: number
  /** 消息来源标记（普通聊天无此字段） */
  meta?: ChatMessageMeta
  /**
   * 本轮生成失败的错误信息（仅 user 消息；轮次失败时由主进程落盘）。
   * 渲染端据此在「末条无回复」提示中展示具体原因，重开窗口后依然可见。
   */
  error?: string
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

/** 角色卡声音模式：不启用 / 本地 Genie-TTS / 云端声音克隆 */
export type CharacterVoiceMode = 'none' | 'genie' | 'mimo'

/** 角色级 Genie-TTS 覆盖：该角色绑定哪个本地 TTS 模型卡（null = 用全局默认） */
export interface CharacterGenieOverride {
  /** 绑定的 TTS 模型卡 id */
  ttsModelId: string
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
  /** 绑定的参考音频 id（仅 voiceMode='mimo' 时使用；null = 无） */
  voiceId: string | null
  /** 角色声音模式：不启用 / 本地 Genie-TTS / 云端声音克隆 */
  voiceMode: CharacterVoiceMode
  /** 角色级 Genie-TTS 覆盖（voiceMode='genie' 时；null = 跟随全局 Genie 配置） */
  genieOverride: CharacterGenieOverride | null

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
  | 'voiceMode'
  | 'genieOverride'
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
  /** MiMo 模型名（如 mimo-v2.5-tts-voiceclone）；engine=genie 时忽略 */
  model: string
  /** 语音引擎：genie 本地声库语音服务(GenieTTS) / mimo 云端声音克隆 */
  engine: 'genie' | 'mimo'
  /** 整段合音（默认为关）：开启时一段回复的多个合成分段合并为整段一次合成（音调更连贯），代价是失去逐句实时朗读与逐句切立绘。中文/日文均适用。 */
  mergeSpeech?: boolean
}

/** GenieTTS(本地声库语音服务) 配置 */
export interface TTSGenieConfig {
  /** 服务地址（GenieTTS start_server 默认 8000 端口） */
  baseUrl: string
  /** GenieTTS 环境/项目目录（含 python.exe；用于自动拉起服务，可空则用系统 python） */
  workPath: string
  /** GenieData 资源目录（含 speaker_encoder.onnx、chinese-hubert-base 等；spawn 时写入 GENIE_DATA_DIR） */
  dataDir: string
}

/** 角色 TTS 模型卡：一组本地 GenieTTS 声库参数 */
export interface TTSModelCard {
  id: string
  /** 模型卡名称（如 "菲比"） */
  name: string
  /** GenieTTS 角色名（对应 onnx 模型） */
  characterName: string
  /** 角色 onnx 模型目录（包含转换后的 *.onnx） */
  onnxModelDir: string
  /** 参考音频路径（可选，用于语气/情绪素材；留空用声库默认） */
  refAudioPath: string
  /** 参考音频对应文本（可选） */
  refAudioText: string
  createdAt: number
}

/** 创建/更新 TTS 模型卡的输入 */
export interface TTSModelCardInput {
  name: string
  characterName: string
  onnxModelDir: string
  refAudioPath: string
  refAudioText: string
}

/** 记忆主题分类：用户信息 / 长期经历 / 约定与承诺 */
export type MemoryCategory = 'user_info' | 'long_term' | 'promises'

/** 记忆体：按角色隔离 + 分主题 + 待确认候选 */
export interface MemoryItem {
  id: string
  content: string
  createdAt: number
  /** 主题分类；旧数据缺省归一为 long_term */
  category: MemoryCategory
  /** 归属角色卡 id；null = 全局共享背景（兼容旧数据，注入时对所有角色生效） */
  characterCardId: string | null
  /** 是否已确认（false = 待确认候选，不注入 system prompt） */
  confirmed: boolean
  /** 自动沉淀来源会话 id（追溯用，手动添加无） */
  sourceSessionId?: string | null
}

/** 编年史条目（长期经历的按期滚动摘要，分层压缩产物） */
export interface ChronicleEntry {
  id: string
  text: string
  createdAt: number
}

/** 单个角色（或全局）的记忆分层压缩档案 */
export interface MemoryProfile {
  /** 归属键：角色卡 id，'_global' = 全局 */
  key: string
  /** 用户画像压缩稿（已采纳生效，常驻注入 system prompt；空串 = 尚无） */
  personaDigest: string
  personaUpdatedAt: number
  /** 已被画像吸收的 user_info 记忆 id 列表（增量整理的游标） */
  personaSourceIds: string[]
  /** 待采纳的画像草稿（LLM 整理产物，用户确认后转正） */
  pendingDigest: string | null
  /** 待采纳草稿对应的来源记忆 id 列表（采纳时并入 personaSourceIds） */
  pendingSourceIds: string[]
  /** 编年史条目（滚动摘要，作为长期经历的检索候选与兜底注入） */
  chronicle: ChronicleEntry[]
  /** 已被编年史吸收的 long_term 记忆 id 列表 */
  chronicleSourceIds: string[]
  /** 最近一次整理（画像+编年史）时间 */
  lastConsolidatedAt: number
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
  /** 模型上下文窗口 token 数（A1 预算装填 / A2 摘要触发的基准；0 = 不限制、保持旧行为） */
  contextWindowTokens: number
  /** 是否启用自动摘要压缩（A2：旧历史超阈值时交给 LLM 生成摘要） */
  enableAutoCompact: boolean
  /** 是否启用记忆自动沉淀（会话结束后后台从对话抽取候选记忆，需用户确认后生效） */
  enableMemoryExtraction: boolean
  /** 是否启用主动搭话（桌宠在长时间无交互后由角色主动开口；旁白入史走完整聊天管线） */
  enableProactive: boolean
  /** 是否启用屏幕感知（与主动搭话同时开启时：先感知屏幕内容再搭话；截图不落盘） */
  enableScreenSense: boolean
  /** 每日主动搭话次数上限（用户回复后会重置计数） */
  maxProactivePerDay: number
  /** 主动搭话兴趣值增长间隔（秒）：每 X 秒累积一轮兴趣值（+5~10），默认 30，范围 10~600 */
  proactiveInterestIntervalSec: number
  /** 话题搭话旁白由 LLM 随机生成（关闭 = 固定模板；LLM 失败自动回退模板） */
  proactiveLlmNarration: boolean
  /** 免打扰时段（'HH:MM' 24 小时制；start/end 任一为空 = 不启用；支持跨零点，如 23:00-08:00） */
  quietHours: { start: string; end: string }
  /** 屏幕感知视觉模型 API 地址（OpenAI 兼容 chat/completions，支持图片输入；独立配置） */
  visionBaseURL: string
  /** 屏幕感知视觉模型名（Key 走独立加密存储，不随 settings 明文保存） */
  visionModel: string
  /** 是否启用记忆向量检索（按当前对话语义检索相关记忆注入；关闭或未配置嵌入模型时回退「最近 N 条」） */
  memoryRetrievalEnabled: boolean
  /** 嵌入 API 地址（OpenAI 兼容 /embeddings 端点；独立于主 LLM 的 baseURL，灵活性更高） */
  embeddingBaseURL: string
  /** 嵌入模型名（对应 embeddingBaseURL 的服务商；Key 走独立加密存储，不随 settings 明文保存） */
  embeddingModel: string
  /** 语义去重相似度阈值（0-1，cos ≥ 该值的候选记忆视为重复；默认 0.92） */
  memoryDedupThreshold: number
  /** 你的称呼（%player% 占位符在人设/示例对话中的替换值，默认「用户」） */
  userName: string
  /** 文字显示速度（0-100 速度档，越大越快；参考 默认 80；0 = 即时显示，不逐字） */
  textSpeed: number
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
  /** 空闲动作组名（空字符串 = 不应用动作，模型静止只保留物理/眨眼） */
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

/** 上下文 token 用量（主进程每次 AI 组装 / 手动压缩后广播，供桌宠窗显示） */
export interface ContextStats {
  sessionId: string
  /** system prompt 占用 token */
  system: number
  /** 会话历史 token（净化后原始消息总量，压缩前） */
  history: number
  /** 最终发给模型的上下文总 token（system + 摘要 + 近段历史） */
  total: number
  /** 模型上下文窗口 token 数（0 = 不限制） */
  window: number
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
  /** 消息来源标记（主动搭话旁白 → 渲染端弱化样式） */
  meta?: ChatMessageMeta | null
}

/**
 * AI 流式"开头括号旁白前置"事件负载（ai:stream-narration，仅语音跟读模式广播）：
 * 回答最前面的连续括号旁白在流式阶段即时上屏，不等语音；台词仍段随语音。
 */
export interface StreamNarrationPayload {
  /** 重试轮重置：渲染端清空已前置旁白，等待重新增量接收 */
  reset?: boolean
  /** 增量旁白文本（已闭合括号组原文，逐段追加） */
  delta?: string
}

/**
 * Live2D 模型资产扫描结果（model:scan-assets）：
 * 自动识别模型文件夹下的 *.exp3.json / *.motion3.json 并合并写回 model3.json。
 */
export interface ModelScanResult {
  /** 本次新并入 model3.json 的表情数 */
  addedExpressions: number
  /** 本次新发现（此前 model3.json 未登记）的动作数 */
  addedMotions: number
  /** 动作组结构是否被重组（组名一律改为文件名后的结构变化，即使无新文件也可能为 true） */
  reorganized: boolean
  /** 合并后表情总数 */
  totalExpressions: number
  /** 合并后动作总数 */
  totalMotions: number
  /** 合并后动作组名列表（排序） */
  groups: string[]
}

/** 主动搭话调度状态（proactive:get-state / proactive:state 广播负载） */
export interface ProactiveState {
  /** 当前兴趣值（0-100；>50 后按概率触发搭话，用户回复清零） */
  interest: number
  /** 今日（按本地日期）已搭话次数 */
  timesToday: number
  /** 每日上限（settings.maxProactivePerDay 快照，展示用） */
  maxPerDay: number
  /** 最近一次成功搭话时间（null = 本次安装后尚未搭话） */
  lastSpokeAt: number | null
  /** 用户最近一次发消息时间（2 分钟冷却与兴趣重置依据） */
  lastUserMessageAt: number | null
}

/** 桌宠窗口交互（拖动/缩放） */
export interface WindowState {
  x: number
  y: number
  width: number
  height: number
}

// ---------------- 剧情演出系统 ----------------

/** 剧本事件上的动作（choices 选项 / input 事件触发） */
export interface StoryAction {
  type: 'set_var' | 'add_line'
  /** set_var：变量名；add_line：写入会话历史的文本 */
  name?: string
  /** set_var 赋值操作：= / += / -=（缺省 =） */
  op?: '=' | '+=' | '-='
  /** set_var 值（数字/字符串/布尔）；add_line 无此字段 */
  value?: number | string | boolean
  /** add_line：写入会话历史的内容（作为 user 消息，参与 AI 上下文） */
  content?: string
}

/**
 * 剧本事件条件子句：{var, op?, value?}。
 * op 缺省 = 裸变量真值判定（变量存在且非 false / 非 0 / 非空串）；
 * 比较运算做宽松对齐：数值优先按数字比较，否则按字符串/布尔相等。
 */
export interface StoryConditionClause {
  /** 变量名 */
  var: string
  /** 比较操作（二期扩展：数值/字符串比较；缺省 = 真值判定） */
  op?: '==' | '!=' | '>=' | '<=' | '>' | '<'
  /** 比较目标值 */
  value?: number | string | boolean
}

/** 组合条件：clauses 按 mode 求值（all = 全部满足/缺省，any = 任一满足） */
export interface StoryConditionGroup {
  mode?: 'all' | 'any'
  clauses: StoryConditionClause[]
}

/** 剧本事件条件（子句或组合；字符串形如 "metBefore"、"closeness >= 3"、"closeness >= 3 && metBefore"） */
export type StoryCondition = StoryConditionClause | StoryConditionGroup

/** chapter_end 分支项：when 条件满足时跳转到 nextChapter（按序求值，首个满足者生效） */
export interface StoryChapterBranch {
  when: StoryCondition
  nextChapter: string
}

/** AI 判定分支选项（chapter_end.aiJudge）：章末由 LLM 依据整局 run 对话表现选择其一 */
export interface StoryAiJudgeOption {
  /** 选项标识（LLM 输出匹配键 + 判定结果变量值） */
  id: string
  /** 选项人类可读描述（一并交给 LLM 帮助权衡） */
  label: string
  /** 命中后跳转的章节 */
  nextChapter: string
}

/** AI 判定结局配置（判定失败/输出无法匹配时回退 nextChapter 缺省行为） */
export interface StoryAiJudge {
  /** 判定提示词（告诉 LLM 从哪些结局维度权衡） */
  prompt: string
  /** 判定结果写入的变量名（缺省 ending；供后续章节条件引用） */
  varName?: string
  options: StoryAiJudgeOption[]
}

/** 剧本事件（一期 12 种，源自 LingChat schema 裁剪；所有事件可携带 condition 条件） */
export type StoryEvent = ({
    type: 'background'; image: string; duration?: number
  } | {
    type: 'music'; file?: string; loop?: boolean; stop?: boolean
  } | {
    type: 'modify_character'; emotion: StandardEmotion
  } | {
    type: 'narration'; text: string
  } | {
    type: 'player'; text: string
  } | {
    type: 'dialogue'; character?: string; text: string; emotion?: StandardEmotion
  } | {
    type: 'ai_dialogue'; prompt: string
  } | {
    type: 'free_dialogue'; maxRounds?: number; endHint?: string
  } | {
    type: 'choices'; options: Array<{ text: string; actions?: StoryAction[] }>; allowFree?: boolean
  } | {
    type: 'input'; actions?: StoryAction[]
  } | {
    type: 'set_var'; name: string; op?: '=' | '+=' | '-='; value: number | string | boolean
  } | {
    type: 'chapter_end'; nextChapter?: string; branches?: StoryChapterBranch[]; aiJudge?: StoryAiJudge
  }) & { /** 演出条件（不满足则跳过该事件；支持比较与 && / || 组合） */
    condition?: StoryCondition
  }

/** 剧本元信息（story.yaml） */
export interface ScriptMeta {
  id: string
  title: string
  summary?: string
  /** 封面图（剧本目录相对路径，可选） */
  cover?: string
  /** 绑定角色卡（一期单角色；cardId 为系统角色卡 id，如 card_xxxxxxxxxxxx） */
  characters?: Array<{ cardId?: string }>
  /** 起始章节文件名（chapters/ 下的 yaml 文件名，如 01-intro） */
  startChapter: string
  version: number
}

/** 章节定义（chapters/*.yaml） */
export interface ScriptChapterDef {
  name: string
  events: StoryEvent[]
  /** 进入条件（7.5）：游标进入本章前求值一次，不满足 → 落 fallbackChapter 或静默跳过整章；缺省视为真 */
  enterWhen?: StoryCondition
  /** enterWhen 不满足时的备选章节（chapters/ 下文件名；进入前同样过 enterWhen 检查，visited 防环） */
  fallbackChapter?: string
}

/** 已加载的剧本（引擎运行时结构） */
export interface ScriptBundle {
  meta: ScriptMeta
  /** 按剧本声明顺序或文件名排序的章节 */
  chapters: Array<{ file: string; def: ScriptChapterDef }>
  /** 剧本资源目录绝对路径（背景/音乐/封面解析用） */
  dir: string
}

/** 剧本库列表条目（story:list） */
export interface ScriptIndexItem {
  id: string
  title: string
  summary: string
  cover: string | null
  chapters: number
  /** story.yaml 建议绑定的角色卡（存在性由渲染端校验） */
  characterCardId: string | null
}

/** 剧本导入/导出校验报告 */
export interface StoryImportReport {
  ok: boolean
  errors: Array<{ file: string; message: string }>
}

/** 剧情 2D 立绘视图调整（大小/水平/垂直；随 run 存档，类似角色模型设置的立绘缩放与位置） */
export interface StorySpriteView {
  /** 缩放倍率（1 = 适应高度基准） */
  scale: number
  /** 水平偏移（% 窗口宽度，负左正右） */
  x: number
  /** 垂直偏移（% 窗口高度，负上正下） */
  y: number
}

/** 剧情语音配置（随 run 存档；与角色卡声音模块解耦，仅支持本地 Genie 声库） */
export interface StoryVoiceConfig {
  /** 本地声库模型卡 id（tts-model_xxx） */
  ttsModelId: string
  /** 语音输出语言：zh 中文 / ja 日语（日语模式自动翻译，复用现有 Genie 逻辑） */
  language: 'zh' | 'ja'
}

/** 剧情 run 存档（data/story-runs/{runId}.json）——与聊天系统完全分离，永不进入聊天会话 */
export interface StoryRun {
  runId: string
  scriptId: string
  /** 剧情用角色卡（人设/示例对话来源） */
  cardId: string
  /** 2D 立绘集（必选；剧情与 Live2D 无关） */
  spriteId: string
  /** 语音配置；null = 不启用语音 */
  voice: StoryVoiceConfig | null
  /** 覆盖背景（可选；本次演出强制使用，优先级高于剧本 background 事件） */
  backgroundOverride?: string | null
  /** 2D 立绘视图（大小/位置调整；缺省用默认值） */
  spriteView?: StorySpriteView
  createdAt: number
  updatedAt: number
  storyState: StoryState
  /** 演出对话记录（backlog 与 AI 上下文来源） */
  messages: ChatMessage[]
}

/** 存档列表条目（story:list-runs） */
export interface StoryRunIndexItem {
  runId: string
  scriptId: string
  scriptTitle: string
  cardId: string
  cardName: string
  spriteId: string
  voice: StoryVoiceConfig | null
  chapterIndex: number
  chapterCount: number
  status: 'running' | 'ended'
  createdAt: number
  updatedAt: number
}

/** 剧情运行时状态（run 文件的 storyState 字段） */
export interface StoryState {
  scriptId: string
  chapterIndex: number
  /** 事件游标：重启/重开窗口后从此处继续（指向未完成的事件） */
  eventIndex: number
  vars: Record<string, unknown>
  status: 'running' | 'ended'
}

/** 渲染端等待提交的交互（挂起中的 choices/input/free_dialogue） */
export interface StoryPendingInteraction {
  kind: 'choices' | 'input' | 'free'
  /** choices：完整选项定义；input/free：附加说明 */
  choices?: Array<{ text: string }>
  allowFree?: boolean
  maxRounds?: number
  /** free：剩余轮次 */
  roundsLeft?: number
  endHint?: string
}

/** 剧情状态快照（story:state 广播 / story:get-state / 剧情窗迟到接入的恢复依据） */
export interface StorySnapshot {
  runId: string
  scriptId: string
  title: string
  status: 'running' | 'ended'
  /**
   * 本次接入的演出方式：
   * - start：刚从新建 run 开始 → 剧情窗从第一条消息完整播放；
   * - resume：中途接入/重开窗口 → 只把最后一条消息作为当前句，不重播全文。
   */
  mode: 'start' | 'resume'
  cardId: string
  spriteId: string
  /** 语音配置（null = 不启用；剧情窗据此决定是否合成） */
  voice: StoryVoiceConfig | null
  /** 立绘视图（大小/位置） */
  spriteView: StorySpriteView
  chapterIndex: number
  chapterName: string
  eventIndex: number
  vars: Record<string, unknown>
  /** 当前背景图（剧本资源相对路径 / user: 前缀引用背景库；null = 无）——窗口重开时恢复演出终态 */
  background: string | null
  /** 当前 BGM（null = 无） */
  music: string | null
  /** 挂起中的交互（choices/input/free；无则 null） */
  pending: StoryPendingInteraction | null
  /** AI 轮次等待期（思考立绘显示依据；首个文本段开始播放时由渲染端自行退出） */
  thinking: boolean
}

/** 剧情演出事件广播（story:event） */
export interface StoryEventPayload {
  runId: string
  event: StoryEvent
  /** 章节名（演出显示用） */
  chapterName: string
}

/** 渲染端提交的交互结果（story:respond） */
export type StoryResponse =
  | { kind: 'choice'; index: number }
  | { kind: 'input'; text: string }
  | { kind: 'free'; text?: string; end?: boolean }
  | { kind: 'retry' }

/** 剧情 TTS 合成结果（story:tts-synthesize；WAV 32kHz mono int16 → base64） */
export interface StoryTtsResult {
  ok: boolean
  audioBase64?: string
  error?: string
}

// ---------------- 可视化编辑器（7.6） ----------------

/** 编辑器读取结果：结构化（表单用）+ 原文（文本微调用）双份 */
export interface EditorReadResult {
  ok: boolean
  error?: string
  errors?: Array<{ file: string; message: string }>
  scriptId?: string
  storyYaml?: string
  meta?: {
    id: string
    title: string
    summary: string
    startChapter: string
    characterCardId: string | null
    /** 手写剧本默认只读：仅 story.yaml 带 editedVia: form 时允许表单写回 */
    editedVia: boolean
  } | null
  chapters?: Array<{
    file: string
    name: string
    enterWhen: StoryCondition | null
    fallbackChapter: string | null
    events: StoryEvent[]
    yaml: string
  }>
}

/** 编辑器保存载荷（form = 结构化；text = 原文微调） */
export type EditorSavePayload =
  | {
      mode: 'form'
      scriptId: string
      meta: { title: string; summary: string; startChapter: string; characterCardId: string | null }
      chapters: Array<{ file: string; name: string; enterWhen?: StoryCondition | null; fallbackChapter?: string | null; events: StoryEvent[] }>
    }
  | {
      mode: 'text'
      scriptId: string
      storyYaml: string
      chapters: Array<{ file: string; yaml: string }>
    }

/** AI 剧本草稿生成结果（草稿为单文件 YAML：元信息 + chapters 内联，校验通过后导入拆分入库） */
export interface StoryDraftResult {
  ok: boolean
  /** 生成的草稿 YAML 文本（失败时缺省） */
  draft?: string
  /** 草稿校验报告（ok=true 且 errors 为空 = 可直接导入） */
  errors: Array<{ file: string; message: string }>
  error?: string
}

/** 剧本导出请求结果 */
export interface StoryExportResult {
  ok: boolean
  path?: string
  canceled?: boolean
  error?: string
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
    /** 订阅"开头括号旁白前置"流（语音跟读模式下旁白流式即时上屏，不等语音） */
    onStreamNarration: (cb: (payload: StreamNarrationPayload) => void) => () => void
    onStreamDone: (cb: (payload: StreamDonePayload) => void) => () => void
    onStreamError: (cb: (payload: StreamErrorPayload) => void) => () => void
    /** 订阅主进程广播的用户消息（跟随窗口即时补上用户气泡，无需等 stream-done 全量拉取） */
    onStreamUser: (cb: (payload: StreamUserPayload) => void) => () => void
    /** 订阅"进行中的流"会话 id 补发（窗口重载/就绪后，用于认领漏掉的当前会话；null 表示无流） */
    onActiveSession: (cb: (sessionId: string | null) => void) => () => void
    /** 取消当前流式请求 */
    cancel: () => void
    testConnection: () => Promise<TestConnectionResult>
    /** 手动压缩指定会话历史：较早对话（最近 20 条之外）生成摘要并落盘复用，返回最新上下文用量 */
    compactNow: (sessionId: string) => Promise<{ ok: boolean; error?: string; compacted?: boolean; stats?: ContextStats }>
    /** 只读查询指定会话的上下文 token 用量（不触发摘要/发送），供桌宠窗切换会话时展示 */
    getContextStats: (sessionId: string) => Promise<{ ok: boolean; error?: string; stats?: ContextStats }>
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
    /** 列出全部记忆（含已确认与待确认候选，按创建时间倒序） */
    list: () => Promise<MemoryItem[]>
    /** 仅列待确认候选（自动沉淀产物） */
    listPending: () => Promise<MemoryItem[]>
    /** 手动新增一条记忆（category 缺省 long_term；characterCardId null = 全局背景），返回新条目 */
    add: (input: { content: string; category: MemoryCategory; characterCardId: string | null }) => Promise<MemoryItem>
    /** 更新记忆内容或分类 */
    update: (id: string, patch: { content?: string; category?: MemoryCategory }) => Promise<void>
    /** 确认待确认候选（确认后注入 system prompt） */
    confirm: (id: string) => Promise<void>
    remove: (id: string) => Promise<void>
    /** 订阅记忆变更（自动沉淀 / 其它窗口修改后刷新），返回取消订阅函数 */
    onChanged: (cb: () => void) => () => void
    /** 语义搜索已确认记忆（向量检索；嵌入未配置时返回空数组，前端回退本地过滤） */
    semanticSearch: (query: string, topK?: number) => Promise<Array<{ item: MemoryItem; score: number }>>
    /** 手动重嵌全部已确认记忆（换嵌入模型/大量缺失时用） */
    reembedAll: () => Promise<{ embedded: number; failed: number; unavailable?: boolean }>
    /** 测试嵌入配置连通性（独立地址/模型/Key），成功返回向量维度 */
    testEmbedding: () => Promise<{ ok: boolean; dim?: number; error?: string }>
    /** 读取指定角色（或全局）的画像/编年史档案 */
    getProfile: (cardId?: string | null) => Promise<MemoryProfile | null>
    /** 触发画像/编年史整理（画像草稿待采纳，编年史直接生效） */
    consolidateProfile: (cardId?: string | null) => Promise<{ ok: boolean; draft: string | null; chronicleAdded: number; error?: string }>
    /** 采纳/放弃画像草稿（采纳后常驻注入 system prompt） */
    adoptProfile: (cardId: string | null, adopt: boolean) => Promise<void>
    /** 编辑已生效画像文本（面板手动修改整理结果；空串 = 清除画像） */
    updateProfileDigest: (cardId: string | null, text: string) => Promise<void>
    /** 删除已生效画像（来源记忆恢复"未吸收"，可重新整理生成） */
    deleteProfileDigest: (cardId: string | null) => Promise<void>
    /** 编辑单条编年史条目文本 */
    updateChronicleEntry: (cardId: string | null, entryId: string, text: string) => Promise<void>
    /** 删除单条编年史条目（原始记忆保持不变，仅移除摘要） */
    deleteChronicleEntry: (cardId: string | null, entryId: string) => Promise<void>
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
    /**
     * 扫描模型文件夹自动识别表情（*.exp3.json）/动作（*.motion3.json）文件，
     * 合并写回 model3.json（手写条目保留、File 路径去重、写前备份）。
     * 新增条目时主进程广播 models-changed 触发桌宠重载模型。
     */
    scanAssets: (modelId: string) => Promise<ModelScanResult>
    /** 弹原生文件夹选择框并导入 Live2D 模型 */
    importFromFolder: () => Promise<Live2DModelMeta | null>
    /** 重命名模型（仅展示名，不动磁盘目录与 model3.json） */
    rename: (modelId: string, name: string) => Promise<void>
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
    /** 更新立绘集展示资产：名称 / 情绪→立绘图映射 / 说话立绘 / 思考立绘 */
    update: (spriteId: string, patch: Partial<Pick<CharacterSprite, 'name' | 'emotionMap' | 'speakingImage' | 'thinkingImage'>>) => Promise<void>
    /** 订阅立绘集列表变化（导入/删除后刷新），返回取消订阅函数 */
    onChanged: (cb: () => void) => () => void
  }
  settings: {
    /** 返回非敏感配置 + 是否已配置 Key（不回显明文；hasEmbeddingApiKey/hasVisionApiKey 为独立服务 Key 状态） */
    get: () => Promise<AppSettings & { hasApiKey: boolean; hasEmbeddingApiKey: boolean; hasVisionApiKey: boolean }>
    save: (settings: Partial<AppSettings>) => Promise<void>
    saveApiKey: (key: string) => Promise<void>
    hasApiKey: () => Promise<boolean>
    /** 保存嵌入服务独立 API Key（safeStorage 加密落盘，与主 LLM Key 隔离） */
    saveEmbeddingApiKey: (key: string) => Promise<void>
    /** 嵌入服务 Key 是否已配置（仅回显掩码用） */
    hasEmbeddingApiKey: () => Promise<boolean>
    /** 保存屏幕感知视觉模型独立 API Key（safeStorage 加密落盘） */
    saveVisionApiKey: (key: string) => Promise<void>
    /** 视觉模型 Key 是否已配置（仅回显掩码用） */
    hasVisionApiKey: () => Promise<boolean>
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
      payload?: { chunks?: DialogueChunk[]; follow?: boolean; engine?: 'genie' | 'mimo'; genieOverride?: CharacterGenieOverride | null },
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
    onSpeak: (cb: (payload: { text: string; voiceId: string | null; languageOverride: TTSLanguage | null; chunks?: DialogueChunk[]; follow?: boolean; engine?: 'genie' | 'mimo'; genieOverride?: CharacterGenieOverride | null }) => void) => () => void
    /** 订阅 AI 回复情绪事件（主进程在聊天完成时广播，驱动桌宠切表情/切立绘） */
    onEmotion: (cb: (emotion: StandardEmotion) => void) => () => void
    /** 订阅"思考中"状态（AI 开始准备回答到输出文本前），立绘模式切思考立绘 */
    onThinking: (cb: (thinking: boolean) => void) => () => void
    /** 订阅流式开始时的"本轮语音模式"（是否有语音），宠物窗提前决定文本展示方式 */
    onVoiceMode: (cb: (opts: { voiceEnabled: boolean }) => void) => () => void
    /** 上报宠物窗"当前已朗读到"的段落文本（段变化时调用），经主进程转发给聊天窗随语音显示 */
    reportReadingText: (text: string) => void
    /** 上报语音朗读是否进行中（经主进程转发给聊天窗控制光标显隐） */
    reportReadingActive: (active: boolean) => void
    /** renderer 就绪通知（用于向主进程补发最近的语音模式） */
    reportRendererReady: () => void
    /** 订阅"当前会话变化"（聊天窗切会话/新建会话时主进程转发，宠物窗内容框同步） */
    onCurrentSessionChanged: (cb: (sessionId: string | null) => void) => () => void
    /** 订阅主进程广播的上下文 token 用量（每次 AI 组装 / 手动压缩后更新），返回取消订阅函数 */
    onContextStats: (cb: (stats: ContextStats) => void) => () => void
    /** 订阅设置变更（保存后主进程广播，桌宠窗据此同步「模型上下文窗口」等展示字段），返回取消订阅函数 */
    onSettingsChanged: (cb: (settings: AppSettings) => void) => () => void
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
     *  languageOverride 覆盖全局语言（角色级 TTS 覆盖）；
     *  engine=genie 时 voiceId 可空（本地声库语音服务不需要参考音频）。 */
    synthesize: (params: { text: string; voiceId: string | null; languageOverride?: TTSLanguage | null; emotion?: StandardEmotion | null; engine?: 'genie' | 'mimo'; genieOverride?: CharacterGenieOverride | null }) => Promise<ArrayBuffer | null>
    /** 重命名参考音频，返回更新后的对象 */
    renameReference: (id: string, name: string) => Promise<VoiceReference>
    /** 读取 GenieTTS(本地声库语音服务) 配置 */
    genieConfig: () => Promise<TTSGenieConfig>
    /** 保存 GenieTTS 配置（部分合并） */
    genieSaveConfig: (patch: Partial<TTSGenieConfig>) => Promise<TTSGenieConfig>
    /** 检测 GenieTTS 服务是否在线 */
    genieCheck: (baseUrl: string) => Promise<{ ok: boolean; error?: string }>
    /** 用 GenieTTS 环境 + GenieData 目录自动拉起服务 */
    genieStart: (workPath: string, dataDir: string) => Promise<{ ok: boolean; error?: string }>
    /** 弹目录选择框，返回选中目录（取消返回 null） */
    chooseFolder: () => Promise<string | null>
    /** 弹文件选择框选择音频（wav/mp3），返回路径（取消返回 null） */
    chooseAudioFile: () => Promise<string | null>
  }
  /** 角色 TTS 模型卡管理 */
  ttsModel: {
    /** 列出所有 TTS 模型卡 */
    list: () => Promise<TTSModelCard[]>
    /** 创建 TTS 模型卡 */
    create: (input: TTSModelCardInput) => Promise<TTSModelCard>
    /** 更新 TTS 模型卡 */
    update: (id: string, input: TTSModelCardInput) => Promise<TTSModelCard>
    /** 删除 TTS 模型卡 */
    delete: (id: string) => Promise<void>
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
    onVoiceMode: (cb: (opts: { voiceEnabled: boolean }) => void) => () => void
    /** renderer 就绪通知（用于向主进程补发最近的语音模式） */
    reportRendererReady: () => void
  }
  /** 主动搭话（调度状态查询/订阅；开关与屏幕感知配置在 settings） */
  proactive: {
    /** 读取调度状态（兴趣值/当日次数/最近搭话时间） */
    getState: () => Promise<ProactiveState>
    /** 订阅调度状态变化（每次成功搭话/用户消息重置后广播） */
    onState: (cb: (state: ProactiveState) => void) => () => void
  }
  /** 剧情演出：剧本库/run 存档/演出控制/事件订阅（与聊天系统完全分离） */
  story: {
    /** 枚举已导入剧本（元信息 + 封面） */
    list: () => Promise<ScriptIndexItem[]>
    /** 打开文件对话框导入 zip 剧本包（含全量校验，返回校验报告） */
    import: () => Promise<StoryImportReport>
    /** 导出剧本为 zip 分发包（弹出保存对话框） */
    export: (scriptId: string) => Promise<StoryExportResult>
    /** 删除剧本（连同其资源目录） */
    remove: (scriptId: string) => Promise<{ ok: boolean; error?: string }>
    /** 存档列表（多周目；含剧本名/进度） */
    listRuns: () => Promise<StoryRunIndexItem[]>
    /** 删除 run 存档 */
    deleteRun: (runId: string) => Promise<{ ok: boolean }>
    /** 开始/继续演出：mode=start 新建 run 从头演，resume=按 runId 从游标续玩；backgroundOverride=本次演出强制背景 */
    start: (params: { scriptId: string; cardId: string; spriteId: string; voice: StoryVoiceConfig | null; mode: 'start' | 'resume'; runId?: string; backgroundOverride?: string | null }) => Promise<{ ok: boolean; runId?: string; error?: string }>
    /** 提交交互结果（选项索引/自由文本/自由对话轮/重试） */
    respond: (params: { runId: string; response: StoryResponse }) => Promise<{ ok: boolean; error?: string }>
    /** 暂停演出（保留 run 存档） */
    stop: (runId: string) => Promise<{ ok: boolean }>
    /** 读取剧情快照（null = 无进行中的演出） */
    getState: (runId: string) => Promise<StorySnapshot | null>
    /** 读取 run 存档全文（backlog 回看与重开重建用） */
    getRun: (runId: string) => Promise<StoryRun | null>
    /** 调整立绘视图（大小/位置；随 run 存档并广播快照） */
    setSpriteView: (runId: string, view: StorySpriteView) => Promise<{ ok: boolean }>
    /** 剧情 TTS 合成（本地 Genie 声库 + 语言）→ WAV base64 */
    synthesize: (params: { ttsModelId: string; language: 'zh' | 'ja'; text: string }) => Promise<StoryTtsResult>
    /** 背景库文件名列表（data/story-backgrounds/；背景事件 user: 前缀引用） */
    listBackgrounds: () => Promise<string[]>
    /** 打开文件对话框选择图片并导入背景库（返回新增文件名） */
    uploadBackgrounds: () => Promise<{ ok: boolean; added?: string[]; error?: string }>
    /** 删除背景库文件 */
    removeBackground: (name: string) => Promise<{ ok: boolean; error?: string }>
    /** AI 辅助写剧本：梗概（+可选参考角色卡）→ 单文件 YAML 剧本草稿（含校验报告，不直接入库） */
    generateDraft: (params: { premise: string; cardId?: string | null }) => Promise<StoryDraftResult>
    /** 导入 AI 剧本草稿：schema 全量校验通过后拆分写入剧本库 */
    importDraft: (draft: string) => Promise<{ ok: boolean; scriptId?: string; errors: Array<{ file: string; message: string }>; error?: string }>
    /** 打开/聚焦剧情窗（演出不中断，按快照恢复） */
    openWindow: () => void
    /** 订阅演出事件流（background/music/narration/player/dialogue/…，带 runId） */
    onEvent: (cb: (payload: StoryEventPayload) => void) => () => void
    /** 订阅剧情状态变更（章节切换/结束/挂起交互/thinking 变化） */
    onState: (cb: (snapshot: StorySnapshot) => void) => () => void
    /** 订阅 run 消息更新（演出显示驱动源：剧情窗按游标从 run.messages 增量补演） */
    onMessageSync: (cb: (payload: { runId: string }) => void) => () => void
    /** 订阅剧情轮次流式预览（7.7 性能第一批）：AI 生成中的可读文本累积全文 */
    onStreamDelta: (cb: (payload: { runId: string; text: string }) => void) => () => void
    /** 剧情窗 renderer 就绪通知（主进程补发最新活跃 run 快照） */
    reportRendererReady: () => void
    /** 剧本资源 URL（背景/音乐/封面）：pet-res://stories/{scriptId}/{relativePath}；user: 前缀自动指向背景库 */
    assetUrl: (scriptId: string, relativePath: string) => string
    /** 立绘资源 URL：pet-res://sprites/{spriteId}/{relativePath} */
    spriteUrl: (spriteId: string, relativePath: string) => string
    /** 打开/聚焦可视化编辑器窗口（7.6），并载入指定剧本 */
    openEditor: (scriptId: string) => Promise<{ ok: boolean; error?: string }>
    /** 新增骨架剧本并直接进入编辑器 */
    editorCreate: () => Promise<{ ok: boolean; scriptId?: string; error?: string }>
    /** 编辑器当前编辑的剧本 id */
    editorCurrent: () => Promise<string | null>
    /** 编辑器读取剧本（结构化 + 原文双份；允许带错读取） */
    editorRead: (scriptId: string) => Promise<EditorReadResult>
    /** 编辑器保存（form = 表单结构化；text = 原文微调；校验通过才原子写盘） */
    editorSave: (payload: EditorSavePayload) => Promise<{ ok: boolean; editedVia?: boolean; errors?: Array<{ file: string; message: string }>; error?: string }>
    /** 订阅编辑器重载（重复打开编辑器切换剧本时通知） */
    onEditorReload: (cb: () => void) => () => void
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