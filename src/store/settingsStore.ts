import { create } from 'zustand'
import { api } from '../api'
import type { AppSettings, ThemeMode } from '../types'
import { applyTheme } from '../lib/theme'

export const DEFAULT_SETTINGS: AppSettings = {
  baseURL: '',
  model: '',
  temperature: 0.8,
  maxTokens: 1024,
  stream: true,
  theme: 'dark',
  contextWindowTokens: 32768,
  enableAutoCompact: true,
  enableMemoryExtraction: true,
  userName: '用户',
  // 文字显示速度：0-100 速度档（越大越快；0=即时显示，不逐字）
  textSpeed: 80,
}

interface SettingsState {
  settings: AppSettings
  hasApiKey: boolean
  loaded: boolean
  load: () => Promise<void>
  save: (patch: Partial<AppSettings>) => Promise<void>
  /** 设置主题并立即应用到当前窗口 */
  setTheme: (theme: ThemeMode) => Promise<void>
  /** 保存 API Key 成功后刷新 hasApiKey（面板占位符/提示据此更新） */
  markKeyConfigured: () => void
  /** 主进程广播的最新设置整体写回本地（settings:changed），并应用主题；供各窗口实时同步 */
  applyRemote: (full: AppSettings) => void
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  hasApiKey: false,
  loaded: false,
  load: async () => {
    try {
      const data = await api.settings.get()
      set({
        settings: {
          baseURL: data.baseURL,
          model: data.model,
          temperature: data.temperature,
          maxTokens: data.maxTokens,
          stream: data.stream,
          theme: data.theme,
          contextWindowTokens: data.contextWindowTokens,
          enableAutoCompact: data.enableAutoCompact,
          enableMemoryExtraction: data.enableMemoryExtraction,
          userName: data.userName,
          textSpeed: data.textSpeed,
        },
        hasApiKey: data.hasApiKey,
        loaded: true,
      })
    } catch (err) {
      console.error('加载设置失败', err)
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
  markKeyConfigured: () => set({ hasApiKey: true }),
  applyRemote: (full) => {
    applyTheme(full.theme)
    // 广播负载（settings:save 返回值）为 AppSettings，不含 hasApiKey；沿用本地值即可
    set((s) => ({ settings: { ...s.settings, ...full }, loaded: true }))
  },
}))

/** 文字速度档（0-100）→ 每字间隔毫秒（参考 LingChat：1→200ms，100→10ms）；<=0 视为即时显示 */
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
