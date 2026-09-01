/**
 * 模型设置 store —— 管理缩放/位置、动画、模型参数等 Live2D 显示设置。
 * 持久化走 api.modelSettings.save()，跨窗口同步走 onModelSettingsChanged 事件。
 */
import { create } from 'zustand'
import { api } from '../api'
import type { ModelSettings, ModelParameters, ModelAnimationSettings, ModelViewSettings } from '../types'

/** 模型参数默认值（对应 airi 的 defaultModelParameters） */
export const DEFAULT_PARAMETERS: ModelParameters = {
  angleX: 0,
  angleY: 0,
  angleZ: 0,
  leftEyeOpen: 1,
  rightEyeOpen: 1,
  leftEyeSmile: 0,
  leftEyebrowLR: 0,
  rightEyebrowLR: 0,
  leftEyebrowY: 0,
  rightEyebrowY: 0,
  leftEyebrowAngle: 0,
  rightEyebrowAngle: 0,
  leftEyebrowForm: 0,
  rightEyebrowForm: 0,
  mouthOpen: 0,
  mouthForm: 0,
  cheek: 0,
  bodyAngleX: 0,
  bodyAngleY: 0,
  bodyAngleZ: 0,
  breath: 0,
}

/** 动画与渲染默认值 */
export const DEFAULT_ANIMATION: ModelAnimationSettings = {
  mouseTracking: true,
  eyeOffsetX: 0,
  eyeOffsetY: 0,
  idleEyeMovement: true,
  enableBlink: true,
  blinkMode: 'force',
  idleAnimation: '',
  renderScale: 2,
  maxFps: 0,
  dropShadow: true,
  expressionEnabled: false,
  selectedExpression: '',
}

/** 缩放与位置默认值 */
export const DEFAULT_VIEW: ModelViewSettings = {
  scale: 1,
  x: 0,
  y: 0,
}

/** 完整默认设置 */
export const DEFAULT_MODEL_SETTINGS: ModelSettings = {
  parameters: { ...DEFAULT_PARAMETERS },
  animation: { ...DEFAULT_ANIMATION },
  view: { ...DEFAULT_VIEW },
  selectedModelId: null,
  selectedSpriteId: null,
}

interface ModelSettingsState {
  settings: ModelSettings
  loaded: boolean
  /** 从磁盘加载设置 */
  load: () => Promise<void>
  /** 保存部分设置并更新本地状态 */
  save: (patch: Partial<ModelSettings>) => Promise<void>
  /** 仅更新本地状态（不落盘，用于实时拖拽时的性能优化） */
  updateLocal: (patch: Partial<ModelSettings>) => void
  /** 落盘当前状态 */
  persist: () => Promise<void>
  /** 从外部事件更新（桌宠窗口接收广播） */
  applyFromRemote: (settings: ModelSettings) => void
  /** 重置模型参数为默认值 */
  resetParameters: () => Promise<void>
}

export const useModelSettingsStore = create<ModelSettingsState>((set, get) => ({
  settings: DEFAULT_MODEL_SETTINGS,
  loaded: false,

  load: async () => {
    try {
      const data = await api.modelSettings.get()
      set({
        settings: {
          parameters: { ...DEFAULT_PARAMETERS, ...data.parameters },
          animation: { ...DEFAULT_ANIMATION, ...data.animation },
          view: { ...DEFAULT_VIEW, ...data.view },
          selectedModelId: data.selectedModelId ?? DEFAULT_MODEL_SETTINGS.selectedModelId,
          selectedSpriteId: data.selectedSpriteId ?? DEFAULT_MODEL_SETTINGS.selectedSpriteId,
        },
        loaded: true,
      })
    } catch (err) {
      console.error('加载模型设置失败', err)
      set({ loaded: true })
    }
  },

  save: async (patch) => {
    const next = {
      parameters: { ...get().settings.parameters, ...(patch.parameters ?? {}) },
      animation: { ...get().settings.animation, ...(patch.animation ?? {}) },
      view: { ...get().settings.view, ...(patch.view ?? {}) },
      selectedModelId: patch.selectedModelId !== undefined ? patch.selectedModelId : get().settings.selectedModelId,
      selectedSpriteId: patch.selectedSpriteId !== undefined ? patch.selectedSpriteId : get().settings.selectedSpriteId,
    }
    set({ settings: next })
    await api.modelSettings.save(patch)
  },

  updateLocal: (patch) => {
    const cur = get().settings
    set({
      settings: {
        parameters: { ...cur.parameters, ...(patch.parameters ?? {}) },
        animation: { ...cur.animation, ...(patch.animation ?? {}) },
        view: { ...cur.view, ...(patch.view ?? {}) },
        selectedModelId: patch.selectedModelId !== undefined ? patch.selectedModelId : cur.selectedModelId,
        selectedSpriteId: patch.selectedSpriteId !== undefined ? patch.selectedSpriteId : cur.selectedSpriteId,
      },
    })
  },

  persist: async () => {
    await api.modelSettings.save(get().settings)
  },

  applyFromRemote: (settings) => {
    set({
      settings: {
        parameters: { ...DEFAULT_PARAMETERS, ...settings.parameters },
        animation: { ...DEFAULT_ANIMATION, ...settings.animation },
        view: { ...DEFAULT_VIEW, ...settings.view },
        selectedModelId: settings.selectedModelId ?? DEFAULT_MODEL_SETTINGS.selectedModelId,
        selectedSpriteId: settings.selectedSpriteId ?? DEFAULT_MODEL_SETTINGS.selectedSpriteId,
      },
    })
  },

  resetParameters: async () => {
    await get().save({ parameters: { ...DEFAULT_PARAMETERS } })
  },
}))
