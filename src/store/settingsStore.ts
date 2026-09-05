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
}))
