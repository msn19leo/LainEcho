/**
 * 桌宠舞台：pixi.js + pixi-live2d-display 渲染 Live2D 模型。
 *
 * 流程：
 *  1. 检测 Cubism Core（live2dcubismcore.min.js）是否已导入，未导入则提示；
 *  2. 动态 import pixi-live2d-display（依赖 window.PIXI + Live2DCubismCore 全局）；
 *  3. 通过 pet-res://models/{id}/{model3} 加载模型并居中/缩放。
 *
 * 通过 useImperativeHandle 暴露 zoom / playTap / switchModel 给外层交互层。
 */
import { useEffect, useImperativeHandle, useRef, useState } from 'react'
import * as PIXI from 'pixi.js'
import type { Live2DModel } from 'pixi-live2d-display'
import { api } from '../api'
import type { Live2DModelMeta } from '../types'

export interface PetStageHandle {
  zoom: (factor: number) => void
  playTap: () => void
  switchModel: (modelId: string) => void
}

interface PetStageProps {
  stageRef: React.Ref<PetStageHandle>
  onStatus: (status: 'loading' | 'ready' | 'no-core' | 'no-model' | 'error', message?: string) => void
}

const IDLE_MS = 10_000

export function PetStage({ stageRef, onStatus }: PetStageProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const appRef = useRef<PIXI.Application | null>(null)
  const modelRef = useRef<Live2DModel | null>(null)
  const live2dClassRef = useRef<typeof Live2DModel | null>(null)
  const cancelledRef = useRef(false)
  /** 加载序号：后发请求覆盖先发请求，丢弃过期加载结果，避免两个模型叠加 */
  const loadGenRef = useRef(0)
  /** 当前展示的模型 id（模型列表变化时保持，不跳回 models[0]） */
  const currentModelIdRef = useRef<string | null>(null)
  const [banner, setBanner] = useState<string | null>(null)

  useImperativeHandle(stageRef, () => ({
    zoom: (factor) => zoomModel(modelRef.current, factor),
    playTap: () => playTap(modelRef.current),
    switchModel: (modelId) => {
      void loadModel(modelId)
    },
  }))

  /** 按容器尺寸居中模型 */
  function fitModel() {
    const model = modelRef.current
    const app = appRef.current
    if (!model || !app) return
    const w = app.screen.width
    const h = app.screen.height
    const mw = model.width || 1024
    const mh = model.height || 1024
    const scale = Math.min(w / mw, h / mh) * 0.9
    model.scale.set(scale, scale)
    model.position.set((w - mw * scale) / 2, (h - mh * scale) / 2)
  }

  function clearModel() {
    const model = modelRef.current
    if (model) {
      try {
        model.destroy()
      } catch {
        // 忽略
      }
    }
    modelRef.current = null
  }

  /** 加载（或切换）指定模型；不传 modelId 时取模型列表第一个 */
  async function loadModel(modelId?: string) {
    const app = appRef.current
    const cls = live2dClassRef.current
    if (!app || !cls || cancelledRef.current) return
    const gen = ++loadGenRef.current

    const models = await api.model.list()
    if (gen !== loadGenRef.current || cancelledRef.current) return // 已被更新的加载请求取代
    if (models.length === 0) {
      clearModel()
      onStatus('no-model')
      setBanner('尚未导入 Live2D 模型，请在设置 → 角色模型中导入')
      return
    }
    const meta = (modelId ? models.find((m) => m.id === modelId) : undefined) ?? (models[0] as Live2DModelMeta)
    currentModelIdRef.current = meta.id

    clearModel()
    const url = api.pet.modelUrl(meta.id, meta.model3Path)
    try {
      const model = await cls.from(url, { autoInteract: false })
      if (gen !== loadGenRef.current || cancelledRef.current) {
        model.destroy()
        return
      }
      modelRef.current = model
      app.stage.addChild(model as unknown as PIXI.DisplayObject)
      fitModel()
      onStatus('ready')
      setBanner(null)
    } catch (err) {
      console.error('Live2D 模型加载失败', meta.id, err)
      onStatus('error', `模型加载失败：${meta.name}`)
    }
  }

  useEffect(() => {
    cancelledRef.current = false // 组件重挂载时复位（防 StrictMode 双挂载等场景）
    let idleTimer: ReturnType<typeof setInterval> | null = null
    let unsubModel = () => {}
    let unsubModels = () => {}
    let ro: ResizeObserver | null = null

    async function init() {
      const container = containerRef.current
      if (!container) return

      // ---- 1. Cubism Core ----
      const coreOk = await ensureCubismCore()
      if (cancelledRef.current) return
      if (!coreOk) {
        onStatus('no-core')
        setBanner('未导入 Cubism Core 运行库，请在设置 → 角色模型中导入')
        return
      }

      // ---- 2. PIXI + pixi-live2d-display ----
      const cls = await getLive2DModelClass()
      if (cancelledRef.current) return
      if (!cls) {
        onStatus('error', 'Live2D 渲染库加载失败')
        return
      }
      live2dClassRef.current = cls

      // 基准尺寸：桌宠窗口固定不可缩放，画布始终钉住初始尺寸。
      // 注意：Windows 上拖动透明无边框窗口时 container.clientWidth 可能瞬时失真，
      // 若 ResizeObserver 跟随它缩放画布，就会出现「拖动时框一直自动延长」。
      const baseW = container.clientWidth || 380
      const baseH = container.clientHeight || 440

      const app = new PIXI.Application({
        width: baseW,
        height: baseH,
        backgroundAlpha: 0,
        antialias: true,
        autoStart: true,
        resolution: window.devicePixelRatio || 1,
        autoDensity: true,
      })
      if (cancelledRef.current) {
        app.destroy(true)
        return
      }
      appRef.current = app
      container.appendChild(app.view as unknown as HTMLElement)

      // 监听窗口尺寸变化：始终恢复到基准尺寸，忽略拖动中的失真读数
      ro = new ResizeObserver(() => {
        if (!container || cancelledRef.current) return
        app.renderer.resize(baseW, baseH)
        fitModel()
      })
      ro.observe(container)

      // ---- 3. 加载模型 ----
      await loadModel()

      // 随机待机动作
      idleTimer = setInterval(() => playRandomIdle(modelRef.current), IDLE_MS)

      // 订阅：角色卡切换 → 换模型；模型列表变化 → 保持当前模型刷新（被删则回退）
      unsubModel = api.pet.onModelChanged((modelId) => {
        if (modelId) void loadModel(modelId)
      })
      unsubModels = api.pet.onModelsChanged(() => {
        void loadModel(currentModelIdRef.current ?? undefined)
      })
    }

    void init()

    return () => {
      cancelledRef.current = true
      idleTimer && clearInterval(idleTimer)
      unsubModel()
      unsubModels()
      ro?.disconnect()
      clearModel()
      appRef.current?.destroy(true, { children: true, texture: true })
      appRef.current = null
      const container = containerRef.current
      if (container) container.innerHTML = ''
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div ref={containerRef} className="relative h-full w-full">
      {banner && (
        <div className="absolute inset-x-0 bottom-0 flex justify-center p-3">
          <div className="w-[300px] rounded-lg border border-border bg-panel/90 px-3 py-2 text-center text-xs leading-relaxed text-text-2 shadow-lg">
            {banner}
            <button
              className="app-no-drag mt-1.5 block w-full rounded bg-accent px-2 py-1 text-xs font-medium text-white hover:brightness-110"
              onClick={() => api.app.openSettings()}
            >
              打开设置
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------- 全局辅助 ----------------

/** 动态注入 Cubism Core 脚本并等待加载 */
function ensureCubismCore(): Promise<boolean> {
  if ((window as unknown as { Live2DCubismCore?: unknown }).Live2DCubismCore) return Promise.resolve(true)
  return new Promise((resolve) => {
    const script = document.createElement('script')
    script.src = 'pet-res://core/live2dcubismcore.min.js'
    script.onload = () => resolve(!!(window as unknown as { Live2DCubismCore?: unknown }).Live2DCubismCore)
    script.onerror = () => resolve(false)
    document.head.appendChild(script)
  })
}

let live2dModulePromise: Promise<typeof Live2DModel | null> | null = null

/** 确保 window.PIXI 就绪后动态加载 pixi-live2d-display */
function getLive2DModelClass(): Promise<typeof Live2DModel | null> {
  if (!live2dModulePromise) {
    ;(window as unknown as { PIXI: typeof PIXI }).PIXI = PIXI
    live2dModulePromise = import('pixi-live2d-display')
      .then((mod) => mod.Live2DModel)
      .catch((err) => {
        console.error('加载 pixi-live2d-display 失败', err)
        live2dModulePromise = null
        return null
      })
  }
  return live2dModulePromise
}

function zoomModel(model: Live2DModel | null, factor: number) {
  if (!model) return
  const next = Math.min(3, Math.max(0.2, model.scale.x * factor))
  const ratio = next / model.scale.x
  model.scale.x = next
  model.scale.y = model.scale.y * ratio
}

// pixi-live2d-display 的动作优先级：None=0 / Idle=1 / Normal=2 / Force=3
const PRIORITY_IDLE = 1
const PRIORITY_FORCE = 3

function playTap(model: Live2DModel | null) {
  if (!model) return
  try {
    const groups = getMotionGroups(model)
    const tapGroup = ['TapBody', 'TapHead', 'Tap'].find((g) => groups.includes(g))
    if (tapGroup) {
      model.motion(tapGroup, 0, PRIORITY_FORCE)
      return
    }
    playRandomIdle(model)
  } catch {
    // 忽略动作播放失败
  }
}

function playRandomIdle(model: Live2DModel | null) {
  if (!model) return
  try {
    const groups = getMotionGroups(model).filter((g) => !g.toLowerCase().startsWith('tap'))
    if (groups.length === 0) return
    const pick = groups[Math.floor(Math.random() * groups.length)] as string
    model.motion(pick, 0, PRIORITY_IDLE)
  } catch {
    // 忽略
  }
}

function getMotionGroups(model: Live2DModel | null): string[] {
  if (!model) return []
  const internal = (model as unknown as {
    internalModel?: { motionManager?: { definitions?: Record<string, unknown> } }
  }).internalModel
  const defs = internal?.motionManager?.definitions
  if (!defs) return []
  return Object.keys(defs)
}
