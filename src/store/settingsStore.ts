import { create } from 'zustand'
import { api } from '../api'
import type { AppSettings, ThemeMode } from '../types'
import { applyTheme } from '../lib/theme'

export const DEFAULT_SETTINGS: AppSettings = {
  // 全局服务商档案库（档案制配置）：主/辅/视觉/嵌入各自引用其中一个档案
  profiles: [],
  activeMainProfileId: null,
  activeAuxProfileId: null,
  activeVisionProfileId: null,
  activeEmbeddingProfileId: null,
  // ↓ 旧版单配置字段（已废弃，仅保留类型兼容；运行时以激活档案为准）
  baseURL: '',
  model: '',
  temperature: 0.8,
  maxTokens: 1024,
  stream: true,
  theme: 'dark',
  contextWindowTokens: 32768,
  enableAutoCompact: true,
  enableMemoryExtraction: true,
  // 回答仅含台词：普通聊天不生成也不显示（）内的描写（默认关闭 = 保留现状）
  stripParenNarration: false,
  // 记忆向量检索：默认关闭（需配置嵌入 API 地址/模型/Key 后开启）
  memoryRetrievalEnabled: false,
  embeddingBaseURL: '',
  embeddingModel: '',
  // 翻译/修复辅助模型（P0-2B：ja 翻译与 JSON 结构修复走快速小模型；留空回落主对话模型）
  translationBaseURL: '',
  translationModel: '',
  // AI 时间感知总开关：默认开启（当前时间锚点/对话间隔/记忆年龄/摘要时间线全链路）
  timeAwarenessEnabled: true,
  // 语音文本跟随语音逐字显示：默认开启（台词文本按音频播放进度逐字放行）
  voiceTextFollowAudio: true,
  // 语音段截断二次重试时重载模型：默认开启（首次截断免重载直接重试；仍截断才按本开关重载兜底）
  truncationReloadRetry: true,
  // Genie 多句段严格判定：默认开启（多句段使用单独阈值，取消 20 字豁免）
  genieMultiSentenceStrict: true,
  // 多句段截断阈值：默认 0.9
  genieMultiSentenceTruncationRatio: 0.9,
  // 单句截断阈值：默认 0.55（保持原行为）
  genieTruncationRatio: 0.55,
  // 情景摘要缓存：默认开启（每轮异步更新"此刻场景状态"，注入【当前情景】Section）
  enableSceneDigest: true,
  memoryDedupThreshold: 0.92,
  // 主动搭话：默认关闭（需用户显式开启；屏幕感知级联于本开关）
  enableProactive: false,
  enableScreenSense: false,
  // 视觉能力（设置页「视觉」模块）：默认转述模式 + 允许发图 + 仅当轮带原图 + 保留 30 天
  vision: {
    readMode: 'describe',
    chatImagesEnabled: true,
    captionRounds: 0,
    imageRetentionDays: 30,
    screenRange: 'window',
    readForeground: false,
    injectActivity: false,
    hideFromCapture: true,
    eyeReadMode: 'ambient',
  },
  maxProactivePerDay: 3,
  // 兴趣值增长间隔（秒）：每 X 秒累积一轮兴趣值（+5~10）
  proactiveInterestIntervalSec: 30,
  proactiveLlmNarration: true,
  // 屏幕搭话占比：默认 70%
  proactiveScreenWeight: 70,
  quietHours: { start: '', end: '' },
  visionBaseURL: '',
  visionModel: '',
  userName: '用户',
  // 文字显示速度：0-100 速度档（越大越快；0=即时显示，不逐字）——桌宠/聊天窗用
  textSpeed: 80,
  // 剧情窗对话框文字显示速度（独立于通用 textSpeed，仅剧情系统读取）
  storyTextSpeed: 80,
}

interface SettingsState {
  settings: AppSettings
  loaded: boolean
  load: () => Promise<void>
  save: (patch: Partial<AppSettings>) => Promise<void>
  /** 重新拉取设置（档案增删改/Key 保存后刷新掩码回显） */
  refresh: () => Promise<void>
  /** 设置主题并立即应用到当前窗口 */
  setTheme: (theme: ThemeMode) => Promise<void>
  /** 主进程广播的最新设置整体写回本地（settings:changed），并应用主题；供各窗口实时同步 */
  applyRemote: (full: AppSettings) => void
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  load: async () => {
    try {
      const data = await api.settings.get()
      set({ settings: { ...DEFAULT_SETTINGS, ...data }, loaded: true })
    } catch (err) {
      console.error('加载设置失败', err)
    }
  },
  refresh: async () => {
    try {
      const data = await api.settings.get()
      set({ settings: { ...get().settings, ...data } })
    } catch (err) {
      console.error('刷新设置失败', err)
    }
  },
  save: async (patch) => {
    await api.settings.save(patch)
    set({ settings: { ...get().settings, ...patch } })
  },
  setTheme: async (theme) => {
    applyTheme(theme)
    set({ settings: { ...get().settings, theme } })
    await api.settings.save({ theme })
  },
  applyRemote: (full) => {
    applyTheme(full.theme)
    // 广播负载为主进程落盘后的完整 AppSettings（含档案库），整体替换
    set({ settings: { ...DEFAULT_SETTINGS, ...full }, loaded: true })
  },
}))

/** 文字速度档（0-100）→ 每字间隔毫秒（1→200ms，100→10ms）；<=0 视为即时显示 */
export function typingSpeedToMs(speed: number): number {
  if (speed <= 0) return 0
  const s = Math.min(100, Math.max(1, speed))
  return Math.round(200 - ((s - 1) / 99) * 190)
}

/**
 * 初始化各窗口的 settings 远程同步：先加载一次持久化设置，再订阅主进程广播的
 * settings:changed（设置变更统一路由在 pet 命名空间，preload 对聊天/宠物/设置窗统一注入），
 * 把最新值实时写回本地 store（如文字速度在设置窗改动后立即对已打开的窗口生效）。
 * 返回取消订阅函数，供 useEffect cleanup 使用。
 */
export function initSettingsSync(): () => void {
  void useSettingsStore.getState().load()
  return api.pet.onSettingsChanged((s) => useSettingsStore.getState().applyRemote(s))
}
