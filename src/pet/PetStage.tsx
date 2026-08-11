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
import { motion } from 'framer-motion'
import { AlertTriangle, Settings } from 'lucide-react'
import * as PIXI from 'pixi.js'
import type { Live2DModel } from 'pixi-live2d-display'
import { api } from '../api'
import { IconTile } from '../components/IconTile'
import type { Live2DModelMeta } from '../types'

export interface PetStageHandle {
  zoom: (factor: number) => void
  playTap: () => void
  switchModel: (modelId: string) => void
  /** 当前模型缩放比例（缩放百分比徽标读取） */
  getScale: () => number
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
  const [loading, setLoading] = useState(false)
  /** 当前模型缩放比例（滚轮缩放百分比徽标读取） */
  const currentScaleRef = useRef(1)

  useImperativeHandle(stageRef, () => ({
    zoom: (factor) => {
      currentScaleRef.current = zoomModel(modelRef.current, factor)
    },
    playTap: () => playTap(modelRef.current),
    getScale: () => currentScaleRef.current,
    switchModel: (modelId) => {
      void loadModel(modelId)
    },
  }))

  /** 按容器尺寸缩放并居中角色（以角色实际顶点包围盒为准，而非整个画布） */
  function fitModel() {
    const model = modelRef.current
    const app = appRef.current
    if (!model || !app) return
    const w = app.screen.width
    const h = app.screen.height

    // 画布（internalModel.width/height）可能远大于角色本身（例如 3500x8888 的画布中
    // 角色只有 ~2887x3342，上下留大量空白），按画布缩放会把角色缩得很小。
    // 用 internalModel.getDrawableVertices()（已是显示局部坐标）算角色真实包围盒。
    const internal = (model as unknown as {
      internalModel?: { width?: number; height?: number }
    }).internalModel
    const char = computeCharacterBounds(model)

    const canvasW = internal?.width || 1024
    const canvasH = internal?.height || 1024
    const mw = char?.width || canvasW
    const mh = char?.height || canvasH

    const scale = Math.min(w / mw, h / mh) * 0.9
    currentScaleRef.current = scale
    model.scale.set(scale, scale)
    model.anchor.set(0.5, 0.5)

    if (char) {
      // 角色中心相对画布中心的偏移，换算到世界坐标后，让角色中心落在窗口中心
      const cx = char.x + char.width / 2
      const cy = char.y + char.height / 2
      model.position.set(
        w / 2 - (cx - canvasW / 2) * scale,
        h / 2 - (cy - canvasH / 2) * scale,
      )
    } else {
      model.position.set(w / 2, h / 2)
    }
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
    setLoading(true)

    const models = await api.model.list()
    if (gen !== loadGenRef.current || cancelledRef.current) return // 已被更新的加载请求取代
    console.log('[pet] 模型列表数量:', models.length, '当前选中:', currentModelIdRef.current ?? null)
    if (models.length === 0) {
      clearModel()
      setLoading(false)
      onStatus('no-model')
      setBanner('尚未导入 Live2D 模型，请在设置 → 角色模型中导入')
      return
    }
    const meta = (modelId ? models.find((m) => m.id === modelId) : undefined) ?? (models[0] as Live2DModelMeta)
    currentModelIdRef.current = meta.id

    clearModel()
    const url = api.pet.modelUrl(meta.id, meta.model3Path)
    console.log('[pet] 开始加载模型:', meta.id, meta.name, url)
    try {
      let model: Live2DModel
      try {
        model = await cls.from(url, { autoInteract: false })
      } catch (err) {
        // 导入后首次加载偶尔因文件尚未完全就绪而失败，短暂等待后重试一次
        console.warn('[pet] 首次加载失败，600ms 后重试:', err instanceof Error ? err.message : err)
        await new Promise((r) => setTimeout(r, 600))
        model = await cls.from(url, { autoInteract: false })
      }
      if (gen !== loadGenRef.current || cancelledRef.current) {
        model.destroy()
        return
      }
      modelRef.current = model
      app.stage.addChild(model as unknown as PIXI.DisplayObject)
      // 等 physics（长发/飘带）跑几帧稳定后再测量拟合：首帧包围盒会被甩动部件撑大
      await waitFrames(app, 10)
      if (gen !== loadGenRef.current || cancelledRef.current) return
      try {
        fitModel()
      } catch (err) {
        // 拟合失败不阻塞模型渲染，保留默认缩放
        console.error('[pet] fitModel 出错（忽略）', err)
      }
      console.log('[pet] 模型加载成功:', meta.name, 'w=', model.width, 'h=', model.height, 'scale=', model.scale.x)
      const dbgInternal = (model as unknown as {
        internalModel?: { width?: number; height?: number; originalWidth?: number; originalHeight?: number }
      }).internalModel
      const dbgChar = computeCharacterBounds(model)
      const dbgBounds = model.getBounds()
      const dbgTextures = (model as unknown as {
        textures?: Array<{ valid?: boolean; width?: number; height?: number }>
      }).textures
      console.log(
        '[pet] debug: canvas=', JSON.stringify({ w: dbgInternal?.width, h: dbgInternal?.height }),
        'char=', JSON.stringify(dbgChar),
        'scale=', model.scale.x,
        'pos=', JSON.stringify([model.position.x, model.position.y]),
        'worldBounds=', JSON.stringify({ x: dbgBounds.x, y: dbgBounds.y, w: dbgBounds.width, h: dbgBounds.height }),
        'textures=', JSON.stringify(dbgTextures?.map((t) => ({ valid: t.valid, w: t.width, h: t.height }))),
      )
      // 诊断：掩码（clipping/mask）使用情况——若大量 drawable 有 mask 且渲染异常，疑点在此
      try {
        const dbgDrawables = (model as unknown as {
          internalModel?: { coreModel?: { _model?: { drawables?: { maskCounts?: Int32Array } } } }
        }).internalModel?.coreModel?._model?.drawables
        const mc = dbgDrawables?.maskCounts
        const maskSum = mc && mc.length ? Array.from(mc).reduce((a, b) => a + b, 0) : -1
        console.log('[pet] masks: 有 mask 的 drawable 数=', mc ? Array.from(mc).filter((n) => n > 0).length : -1, 'mask 引用总数=', maskSum)
      } catch {
        // 忽略
      }
      setLoading(false)
      onStatus('ready')
      setBanner(null)
      // 诊断：等几帧后分析画布上实际渲染出的非透明内容
      setTimeout(() => analyzeRender(app), 500)
    } catch (err) {
      console.error('Live2D 模型加载失败', meta.id, err)
      // 诊断：直接请求 model3.json，确认 pet-res:// 协议是否可访问（200=文件在，404=路径错）
      void fetch(url)
        .then((r) => console.log('[pet] model3.json fetch:', r.status, r.statusText, url))
        .catch((e) => console.log('[pet] model3.json fetch 失败:', e instanceof Error ? e.message : String(e), url))
      setLoading(false)
      onStatus('error', `模型加载失败：${meta.name}`)
      setBanner(`模型「${meta.name}」加载失败：${err instanceof Error ? err.message : String(err)}（${url}）`)
    }
  }

  useEffect(() => {
    cancelledRef.current = false // 组件重挂载时复位（防 StrictMode 双挂载等场景）
    let idleTimer: ReturnType<typeof setInterval> | null = null
    let unsubModel = () => {}
    let unsubModels = () => {}
    let unsubCore = () => {}
    let ro: ResizeObserver | null = null
    let booting = false

    /** 完整初始化（幂等）：
     *  - core 缺失时停在提示横幅，收到 core 导入事件后重试
     *  - 已初始化 PIXI 应用时（模型导入/删除）仅重新加载模型，避免重复建画布 */
    async function init() {
      if (booting || cancelledRef.current) return
      booting = true
      try {
        const container = containerRef.current
        if (!container || cancelledRef.current) return

        // 已初始化：仅刷新模型（导入/删除模型后保持当前模型，被删则回退）
        if (appRef.current) {
          await loadModel(currentModelIdRef.current ?? undefined)
          return
        }

        // ---- 1. Cubism Core ----
        const coreOk = await ensureCubismCore()
        console.log('[pet] Cubism Core 状态:', coreOk)
        if (cancelledRef.current) return
        if (!coreOk) {
          onStatus('no-core')
          setBanner('未导入 Cubism Core 运行库，请在设置 → 角色模型中导入')
          return
        }

        // ---- 2. PIXI + pixi-live2d-display ----
        const cls = await getLive2DModelClass()
        console.log('[pet] Live2DModel 类已加载:', !!cls)
        if (cancelledRef.current) return
        if (!cls) {
          onStatus('error', 'Live2D 渲染库加载失败')
          setBanner('Live2D 渲染库加载失败，请重启应用')
          return
        }
        live2dClassRef.current = cls

        // 基准尺寸：桌宠窗口固定不可缩放，画布始终钉住初始尺寸。
        // 注意：Windows 上拖动透明无边框窗口时 container.clientWidth 可能瞬时失真，
        // 若 ResizeObserver 跟随它缩放画布，就会出现「拖动时框一直自动延长」。
        const baseW = container.clientWidth || 380
        const baseH = container.clientHeight || 440

        let app: PIXI.Application
        try {
          app = new PIXI.Application({
            width: baseW,
            height: baseH,
            backgroundAlpha: 0,
            antialias: true,
            autoStart: true,
            resolution: window.devicePixelRatio || 1,
            autoDensity: true,
            // 诊断用：保留绘图缓冲，便于 toDataURL 分析实际渲染内容（正式版可移除）
            preserveDrawingBuffer: true,
          })
        } catch (err) {
          console.error('创建 PIXI 渲染器失败', err)
          setBanner('创建渲染器失败（可能是显卡/WebGL 兼容问题），请尝试关闭硬件加速后重试')
          return
        }
        if (cancelledRef.current) {
          app.destroy(true)
          return
        }
        appRef.current = app
        container.appendChild(app.view as unknown as HTMLElement)
        console.log('[pet] PIXI app 创建成功', baseW, baseH)

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
      } finally {
        booting = false
      }
    }

    void init()

    // 订阅始终注册（即使 core 缺失也会收到导入事件后重试）：
    // 角色卡切换 → 换模型；模型列表变化 / Cubism Core 导入 → 重新初始化
    unsubModel = api.pet.onModelChanged((modelId) => {
      if (modelId) void loadModel(modelId)
    })
    unsubModels = api.pet.onModelsChanged(() => {
      void init()
    })
    unsubCore = api.pet.onCoreChanged(() => {
      void init()
    })

    return () => {
      cancelledRef.current = true
      idleTimer && clearInterval(idleTimer)
      unsubModel()
      unsubModels()
      unsubCore()
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
      {/* 加载中：居中品牌渐变环形加载 */}
      {loading && !banner && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="brand-spinner" />
        </div>
      )}

      {banner && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
          className="app-no-drag absolute inset-x-0 bottom-0 flex justify-center p-3"
        >
          <div className="flex w-[300px] items-start gap-3 rounded-[var(--radius-lg)] border border-[var(--border-strong)] bg-[var(--bg-panel)]/90 px-4 py-3 text-left shadow-[var(--shadow-card-hover)] backdrop-blur-xl">
            <IconTile icon={AlertTriangle} size="sm" gradient="accent" />
            <div className="min-w-0">
              <p className="text-xs leading-relaxed text-text">{banner}</p>
              <button
                onClick={() => api.app.openSettings()}
                className="mt-2 inline-flex items-center gap-1 rounded-[var(--radius-sm)] bg-brand-gradient px-3 py-1.5 text-xs font-medium text-[var(--on-brand)] transition-all hover:brightness-110"
              >
                <Settings size={12} strokeWidth={2} />
                打开设置
              </button>
            </div>
          </div>
        </motion.div>
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

/** 确保 window.PIXI 就绪后动态加载 pixi-live2d-display 的 Cubism 4 入口。
 * 注意：主入口（pixi-live2d-display）在模块加载时会强制要求 Cubism 2 运行库
 * （live2d.min.js）存在，否则直接抛「Could not find Cubism 2 runtime」；
 * 本应用只使用 Cubism 4（live2dcubismcore.min.js），因此改用 /cubism4 子路径，
 * 只需 Live2DCubismCore 即可。 */
function getLive2DModelClass(): Promise<typeof Live2DModel | null> {
  if (!live2dModulePromise) {
    ;(window as unknown as { PIXI: typeof PIXI }).PIXI = PIXI
    live2dModulePromise = import('pixi-live2d-display/cubism4')
      .then((mod) => {
        patchCubismCoreCompatibility(mod as unknown as Record<string, unknown>)
        return mod.Live2DModel
      })
      .catch((err) => {
        console.error('加载 pixi-live2d-display 失败', err)
        live2dModulePromise = null
        return null
      })
  }
  return live2dModulePromise
}

/**
 * 兼容新版 Cubism Core（6.x）：
 * Cubism 6 把 drawables.renderOrders 更名为 drawables.drawOrders，
 * 而 pixi-live2d-display 0.4.0 仍读取 renderOrders，导致第一帧绘制抛
 * 「Cannot read properties of undefined (reading '0')」→ 模型不显示。
 * 这里在 CubismModel 原型上打补丁：renderOrders 缺失时回退到 drawOrders。
 */
function patchCubismCoreCompatibility(mod: Record<string, unknown>): void {
  interface Drawables {
    renderOrders?: unknown
    drawOrders?: unknown
  }
  interface CubismModelInstance {
    _model?: { drawables?: Drawables }
  }
  const proto = (mod.CubismModel as { prototype?: unknown } | undefined)?.prototype as
    | { getDrawableRenderOrders?: (this: CubismModelInstance) => unknown }
    | undefined
  if (!proto || typeof proto.getDrawableRenderOrders !== 'function') return
  proto.getDrawableRenderOrders = function (this: CubismModelInstance) {
    const drawables = this._model?.drawables
    return drawables?.renderOrders ?? drawables?.drawOrders
  }
}

function zoomModel(model: Live2DModel | null, factor: number): number {
  if (!model) return 1
  const next = Math.min(3, Math.max(0.2, model.scale.x * factor))
  const ratio = next / model.scale.x
  model.scale.x = next
  model.scale.y = model.scale.y * ratio
  return next
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

/** 等待 PIXI ticker 跑够 n 帧（用于让模型 physics 先稳定，避免首帧包围盒被甩动部件撑大） */
function waitFrames(app: PIXI.Application, n: number): Promise<void> {
  return new Promise((resolve) => {
    let count = 0
    const tick = () => {
      count++
      if (count >= n) {
        app.ticker.remove(tick)
        resolve()
      }
    }
    app.ticker.add(tick)
  })
}

/** 诊断：统计 WebGL 画布上实际渲染出的非透明像素范围（判断模型到底画出了什么） */
function analyzeRender(app: PIXI.Application): void {
  try {
    const canvas = app.view as HTMLCanvasElement
    const url = canvas.toDataURL('image/png')
    const img = new Image()
    img.onload = () => {
      try {
        const c = document.createElement('canvas')
        c.width = img.width
        c.height = img.height
        const ctx = c.getContext('2d')
        if (!ctx) return
        ctx.drawImage(img, 0, 0)
        const data = ctx.getImageData(0, 0, c.width, c.height).data
        let minX = c.width
        let minY = c.height
        let maxX = -1
        let maxY = -1
        let nonTransparent = 0
        for (let y = 0; y < c.height; y++) {
          for (let x = 0; x < c.width; x++) {
            if (data[(y * c.width + x) * 4 + 3]! > 0) {
              nonTransparent++
              if (x < minX) minX = x
              if (x > maxX) maxX = x
              if (y < minY) minY = y
              if (y > maxY) maxY = y
            }
          }
        }
        console.log(
          '[pet] render: 非透明像素=', nonTransparent,
          '画布=', JSON.stringify({ w: c.width, h: c.height }),
          '内容包围盒=', JSON.stringify({ minX, minY, maxX, maxY }),
        )
      } catch (err) {
        console.error('[pet] 渲染分析失败', err)
      }
    }
    img.onerror = () => console.error('[pet] toDataURL 图片解析失败')
    img.src = url
  } catch (err) {
    console.error('[pet] toDataURL 失败', err)
  }
}

/**
 * 计算角色实际顶点包围盒（显示局部坐标，与 internalModel.width/height 同单位）。
 * 用 raw 顶点 + 手动换算（× pixelsPerUnit + 画布中心），逐项容错：
 * 某些 drawable 可能没有顶点数据，直接跳过，避免影响模型加载。
 */
function computeCharacterBounds(
  model: Live2DModel,
): { x: number; y: number; width: number; height: number } | null {
  try {
    const internal = (model as unknown as {
      internalModel?: {
        originalWidth?: number
        originalHeight?: number
        pixelsPerUnit?: number
        coreModel?: {
          getDrawableCount?: () => number
          getDrawableVertexPositions?: (i: number) => Float32Array | undefined
          getDrawableDynamicFlagIsVisible?: (i: number) => boolean
          getDrawableOpacities?: () => Float32Array | undefined
          getDrawableOpacity?: (i: number) => number
        }
      }
    }).internalModel
    const core = internal?.coreModel
    if (
      !core ||
      typeof core.getDrawableCount !== 'function' ||
      typeof core.getDrawableVertexPositions !== 'function'
    ) {
      return null
    }
    const count = core.getDrawableCount()
    const ppu = internal?.pixelsPerUnit || 1
    const ow = internal?.originalWidth || 0
    const oh = internal?.originalHeight || 0

    // 预取所有 drawable 的透明度（如果 API 存在），逐个判断可见性
    const opacities =
      typeof core.getDrawableOpacities === 'function' ? core.getDrawableOpacities() : undefined

    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    let skipped = 0
    for (let i = 0; i < count; i++) {
      // 跳过被标记为不可见的部件（永久隐藏的换装差分、参考图层等）
      if (
        typeof core.getDrawableDynamicFlagIsVisible === 'function' &&
        !core.getDrawableDynamicFlagIsVisible(i)
      ) {
        skipped++
        continue
      }
      // 跳过完全透明的部件
      const opacity = opacities ? opacities[i] : core.getDrawableOpacity?.(i)
      if (opacity !== undefined && opacity <= 0) {
        skipped++
        continue
      }

      let raw: Float32Array | undefined
      try {
        raw = core.getDrawableVertexPositions(i)
      } catch {
        continue
      }
      if (!raw) continue
      for (let j = 0; j < raw.length; j += 2) {
        const x = raw[j]! * ppu + ow / 2
        const y = -raw[j + 1]! * ppu + oh / 2
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
    console.log('[pet] computeCharacterBounds: 总 drawable 数=', count, '跳过（不可见/透明）=', skipped)
    if (!(minX <= maxX && minY <= maxY)) return null
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
  } catch {
    return null
  }
}
