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
import type { Live2DModelMeta, ModelSettings, ModelParameters, ModelAnimationSettings, ExpressionMeta, ExpressionParameter, CharacterModelOverride, RenderMode, StandardEmotion, PetCardPayload } from '../types'
import { DEFAULT_EMOTION } from '../types'
import { DEFAULT_MODEL_SETTINGS } from '../store/modelSettingsStore'
import { LipSyncController } from './lipSync'

export interface PetStageHandle {
  zoom: (factor: number) => void
  playTap: () => void
  switchModel: (modelId: string) => void
  /** 当前模型缩放比例（缩放百分比徽标读取） */
  getScale: () => number
  /** 播放语音并驱动口型同步：传入 wav ArrayBuffer */
  speak: (audio: ArrayBuffer) => Promise<void>
  /** 停止播放语音并清零口型参数 */
  stopSpeak: () => void
  /** 按句更新当前情绪（桌宠句级播放时由 PetApp 调用，驱动立绘/表情联动） */
  setEmotion: (emotion: StandardEmotion) => void
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
  /** 当前角色卡绑定的模型 id（null 表示未绑定，应使用全局选中模型） */
  const currentCardModelIdRef = useRef<string | null>(null)
  /** 当前角色卡的模型设置覆盖（表情/待机动作），null 表示无覆盖，跟随全局 */
  const cardModelOverrideRef = useRef<CharacterModelOverride | null>(null)
  const [banner, setBanner] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  /** 当前形象渲染模式：'live2d'（动画）| 'sprite'（2D 静态立绘） */
  const [mode, setMode] = useState<RenderMode>('live2d')
  /** 立绘模式下当前展示的立绘（null = 不显示） */
  const [sprite, setSprite] = useState<{ url: string; name: string } | null>(null)
  /** 当前模型缩放比例（滚轮缩放百分比徽标读取） */
  const currentScaleRef = useRef(1)
  /** 当前渲染模式引用（供 effect 闭包读取最新值，避免依赖数组重跑） */
  const modeRef = useRef<RenderMode>('live2d')
  /** 角色卡显式设定的形象模式（null = 跟随全局当前形象），由 onCardChanged 维护 */
  const cardModeRef = useRef<RenderMode | null>(null)
  /** 当前生效情绪（由 AI 回复情绪联动更新，默认 neutral） */
  const currentEmotionRef = useRef<StandardEmotion>(DEFAULT_EMOTION)
  /** 当前角色卡绑定的立绘集 id（立绘模式渲染用） */
  const spriteIdRef = useRef<string | null>(null)
  /** 当前角色卡的情绪 → 立绘文件名 映射 */
  const emotionMapRef = useRef<Partial<Record<StandardEmotion, string>> | null>(null)
  /** 当前角色卡的情绪 → exp3 表情名 映射（Live2D 模式） */
  const live2dExpressionMapRef = useRef<Partial<Record<StandardEmotion, string>> | null>(null)
  /** 全局当前立绘集 id（modelSettings.selectedSpriteId，角色卡未绑定立绘时回退用） */
  const selectedSpriteIdRef = useRef<string | null>(null)
  /** 桌面立绘展示状态：idle(情绪态) / speaking(说话) / thinking(思考) */
  const displayStateRef = useRef<'idle' | 'speaking' | 'thinking'>('idle')
  /** 上一帧说话状态（检测翻转以触发说话立绘切换） */
  const lastSpeakingRef = useRef(false)

  /** 解析当前立绘模式实际使用的立绘集 id：角色卡绑定优先，否则全局当前立绘集 */
  function getEffectiveSpriteId(): string | null {
    return spriteIdRef.current ?? selectedSpriteIdRef.current ?? null
  }

  /** 解析当前 Live2D 模式实际使用的模型 id：角色卡绑定优先，否则全局当前模型 */
  function getEffectiveModelId(): string | null {
    return currentCardModelIdRef.current ?? settingsRef.current.selectedModelId ?? null
  }

  /**
   * 计算当前有效渲染模式：
   *   角色卡显式设定了形象模式 → 用之；否则跟随全局（全局选中立绘集则立绘，否则 Live2D）。
   */
  function effectiveRenderMode(): RenderMode {
    if (cardModeRef.current) return cardModeRef.current
    return selectedSpriteIdRef.current ? 'sprite' : 'live2d'
  }

  /** 模型设置引用（每帧读取，不触发重渲染） */
  const settingsRef = useRef<ModelSettings>(DEFAULT_MODEL_SETTINGS)
  /** 鼠标位置（屏幕坐标，用于鼠标跟踪） */
  const mouseRef = useRef<{ x: number; y: number; active: boolean; lastMoveAt: number }>({ x: 0, y: 0, active: false, lastMoveAt: 0 })
  /** 当前注视焦点（lerp 平滑后的值，让模型缓慢追踪鼠标而非瞬间跟随） */
  const focusRef = useRef({ x: 0, y: 0 })
  /** 眨眼状态机 */
  const blinkRef = useRef(createBlinkState())
  /** 空闲眼神状态 */
  const idleEyeRef = useRef(createIdleEyeState())
  /** 当前模型的表情列表（模型加载时从主进程读取） */
  const expressionListRef = useRef<ExpressionMeta[]>([])
  /** 当前应用的表情参数（从 expressionListRef 中匹配选中表情得到） */
  const currentExpressionParamsRef = useRef<ExpressionParameter[]>([])
  /** 表情修改前的参数基础值（每帧还原后再应用新表情，避免叠加残留） */
  const expressionBaseValuesRef = useRef<Map<string, number>>(new Map())
  /** 口型同步控制器：播放音频并驱动 ParamMouthOpen */
  const lipSyncRef = useRef<LipSyncController>(new LipSyncController())

  useImperativeHandle(stageRef, () => ({
    zoom: (factor) => {
      currentScaleRef.current = zoomModel(modelRef.current, factor)
    },
    playTap: () => playTap(modelRef.current, settingsRef.current.animation.idleAnimation || undefined),
    getScale: () => currentScaleRef.current,
    switchModel: (modelId) => {
      void loadModel(modelId)
    },
    /** 播放音频并启动口型同步 */
    speak: async (audio: ArrayBuffer) => {
      await lipSyncRef.current.play(audio)
    },
    /** 停止播放并清零口型 */
    stopSpeak: () => {
      lipSyncRef.current.stop()
    },
    /** 按句更新情绪：写 emotion 并重应用立绘/表情 */
    setEmotion: (emotion: StandardEmotion) => {
      currentEmotionRef.current = emotion
      if (modeRef.current === 'sprite') {
        applySprite()
      } else {
        updateCurrentExpression()
      }
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

    // 基础缩放 × 用户设置的缩放系数
    const view = settingsRef.current.view
    const baseScale = Math.min(w / mw, h / mh) * 0.9
    const scale = baseScale * view.scale
    currentScaleRef.current = scale
    model.scale.set(scale, scale)
    model.anchor.set(0.5, 0.5)

    if (char) {
      // 角色中心相对画布中心的偏移，换算到世界坐标后，让角色中心落在窗口中心
      // 再叠加用户设置的 X/Y 偏移
      const cx = char.x + char.width / 2
      const cy = char.y + char.height / 2
      model.position.set(
        w / 2 - (cx - canvasW / 2) * scale + view.x,
        h / 2 - (cy - canvasH / 2) * scale + view.y,
      )
    } else {
      model.position.set(w / 2 + view.x, h / 2 + view.y)
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
    // 清空表情状态，防止旧模型的表情基础值残留到新模型
    expressionListRef.current = []
    currentExpressionParamsRef.current = []
    expressionBaseValuesRef.current.clear()
  }

  /**
   * 立绘模式：解析当前应显示的立绘图并设置 to sprite state。
   * 规则：emotionMap[emotion] 优先，缺映射或缺文件时回退 neutral，再退回立绘集第一张。
   * @param spriteId 绑定的立绘集 id
   * @param emotionMap 角色卡的情绪 → 文件名映射（可为 null）
   * @param emotion 当前情绪（默认 neutral）
   */
  async function resolveSprite(
    spriteId: string | null,
    emotionMap: Partial<Record<StandardEmotion, string>> | null | undefined,
    emotion: StandardEmotion = DEFAULT_EMOTION,
    variant: 'idle' | 'speaking' | 'thinking' = 'idle',
  ) {
    if (!spriteId) {
      setSprite(null)
      return
    }
    try {
      const list = await api.sprite.list()
      const spr = list.find((s) => s.id === spriteId)
      if (!spr || spr.images.length === 0) {
        setSprite(null)
        return
      }
      const has = (f: string | null | undefined) => !!f && spr.images.some((i) => i.filePath === f)
      // 变体立绘优先：思考 > 说话(仅平静情绪时) > 情绪映射图
      let file: string | null = null
      if (variant === 'thinking' && has(spr.thinkingImage)) {
        file = spr.thinkingImage
      } else if (variant === 'speaking' && emotion === DEFAULT_EMOTION && has(spr.speakingImage)) {
        file = spr.speakingImage
      }
      if (!file) {
        // 情绪映射优先级：角色卡传入的映射 > 立绘集自身的映射(spr.emotionMap) > 无映射
        const sourceMap = emotionMap ?? spr.emotionMap ?? null
        const want = pickEmotionAsset(sourceMap, emotion)
        file = (want && spr.images.some((i) => i.filePath === want)) ? want : (spr.images[0]!.filePath)
      }
      setSprite({ url: api.pet.spriteUrl(spriteId, file), name: spr.name })
    } catch {
      setSprite(null)
    }
  }

  /** 立绘模式统一重新解析当前立绘（依据当前情绪 + 说话/思考状态） */
  function applySprite() {
    if (modeRef.current !== 'sprite') return
    const hasCardSprite = !!spriteIdRef.current
    void resolveSprite(
      getEffectiveSpriteId(),
      hasCardSprite ? emotionMapRef.current : null,
      currentEmotionRef.current,
      displayStateRef.current,
    )
  }

  /**
   * 获取当前生效的表情名。优先级从高到低：
   *   情绪映射(live2dExpressionMap[当前情绪]) → 角色卡覆盖 → 全局设置。
   * 返回空串表示不应用表情。
   */
  function getEffectiveExpression(): string {
    const override = cardModelOverrideRef.current
    // 情绪联动：当前情绪配置了专属表情时优先使用
    const emoExpr = pickEmotionAsset(live2dExpressionMapRef.current, currentEmotionRef.current)
    if (emoExpr) return emoExpr
    if (override && override.selectedExpression !== null) return override.selectedExpression
    return settingsRef.current.animation.selectedExpression
  }

  /**
   * 获取当前生效的待机动作组：角色卡覆盖优先，否则跟随全局设置。
   * 返回空串表示无指定动作组（随机选择）。
   */
  function getEffectiveIdleAnimation(): string {
    const override = cardModelOverrideRef.current
    if (override && override.idleAnimation !== null) return override.idleAnimation
    return settingsRef.current.animation.idleAnimation
  }

  /**
   * 根据当前设置（expressionEnabled + 生效表情名）和已加载的表情列表，
   * 更新 currentExpressionParamsRef。每帧由 ticker 读取并应用到 coreModel。
   * 参考 airi 的 expression-controller.ts：不使用 SDK 的 Expression Manager，直接管理参数。
   * 角色卡 modelOverride.selectedExpression 非 null 时覆盖全局 selectedExpression。
   */
  function updateCurrentExpression() {
    const anim = settingsRef.current.animation
    // 角色卡覆盖表情：若 override.selectedExpression 非 null，强制启用表情（即使全局 expressionEnabled=false）
    const override = cardModelOverrideRef.current
    const expressionEnabled = override?.selectedExpression !== null && override?.selectedExpression !== undefined
      ? true
      : anim.expressionEnabled
    const selectedExpression = getEffectiveExpression()
    if (!expressionEnabled || !selectedExpression) {
      currentExpressionParamsRef.current = []
      return
    }
    const expr = expressionListRef.current.find((e) => e.name === selectedExpression)
    currentExpressionParamsRef.current = expr?.parameters ?? []
  }

  /** 加载（或切换）指定模型；不传 modelId 时按优先级选择：角色卡绑定 > 全局选中 > 列表第一个 */
  async function loadModel(modelId?: string) {
    const app = appRef.current
    const cls = live2dClassRef.current
    if (!app || !cls || cancelledRef.current) return
    const gen = ++loadGenRef.current
    setLoading(true)

    const models = await api.model.list()
    if (gen !== loadGenRef.current || cancelledRef.current) return // 已被更新的加载请求取代
    console.log('[pet] 模型列表数量:', models.length, '当前展示:', currentModelIdRef.current ?? null, '角色卡绑定:', currentCardModelIdRef.current ?? null, '全局选中:', settingsRef.current.selectedModelId ?? null)
    if (models.length === 0) {
      clearModel()
      setLoading(false)
      onStatus('no-model')
      setBanner('尚未导入 Live2D 模型，请在设置 → 角色模型中导入')
      return
    }
    // 确定目标模型 id：显式传入 > 角色卡绑定 > 全局选中 > 列表第一个
    const findModel = (id?: string | null) => id ? models.find((m) => m.id === id) : undefined
    const meta =
      findModel(modelId) ??
      findModel(currentCardModelIdRef.current) ??
      findModel(settingsRef.current.selectedModelId) ??
      (models[0] as Live2DModelMeta)
    currentModelIdRef.current = meta.id

    clearModel()
    const url = api.pet.modelUrl(meta.id, meta.model3Path)
    console.log('[pet] 开始加载模型:', meta.id, meta.name, url)
    try {
      let model: Live2DModel
      try {
        model = await cls.from(url, { autoInteract: false, autoUpdate: false })
      } catch (err) {
        // 导入后首次加载偶尔因文件尚未完全就绪而失败，短暂等待后重试一次
        console.warn('[pet] 首次加载失败，600ms 后重试:', err instanceof Error ? err.message : err)
        await new Promise((r) => setTimeout(r, 600))
        model = await cls.from(url, { autoInteract: false, autoUpdate: false })
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
      // 加载模型的表情列表（参考 airi 的 expression-store.ts：自行解析 exp3.json）
      try {
        const expressions = await api.model.expressionList(meta.id)
        if (gen !== loadGenRef.current || cancelledRef.current) return
        expressionListRef.current = expressions
        updateCurrentExpression()
        console.log('[pet] 表情列表已加载:', expressions.length, expressions.map((e) => e.name))
      } catch {
        expressionListRef.current = []
        currentExpressionParamsRef.current = []
      }
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
    let unsubSettings = () => {}
    let unsubEmotion = () => {}
    let unsubThinking = () => {}
    let unsubSprites = () => {}
    let unsubCursor = () => {}
    let ro: ResizeObserver | null = null
    let booting = false

    /** 每帧参数引擎回调（注册到 PIXI ticker） */
    const tickerFn = (delta: number) => {
      // 立绘模式：检测说话态翻转，切换说话/空闲立绘（思考态优先不被覆盖）
      if (modeRef.current === 'sprite') {
        const speakingNow = lipSyncRef.current.isPlaying
        if (speakingNow !== lastSpeakingRef.current) {
          lastSpeakingRef.current = speakingNow
          if (speakingNow) {
            if (displayStateRef.current !== 'thinking') displayStateRef.current = 'speaking'
          } else if (displayStateRef.current === 'speaking') {
            displayStateRef.current = 'idle'
          }
          applySprite()
        }
      }
      const model = modelRef.current
      if (!model) return
      const settings = settingsRef.current
      const animation = settings.animation
      const params = settings.parameters

      // 获取 internalModel（暴露 coreModel 和 focusController）
      const internal = (model as unknown as {
        internalModel?: InternalModelLike
      }).internalModel
      const coreModel = internal?.coreModel
      if (!coreModel) return

      // 驱动模型自身的内部更新（动作/呼吸/SDK 眨眼/物理）。
      // 模型以 autoUpdate:false 创建，脱离 PIXI 共享 ticker；这里在本应用 ticker 上
      // 手动累计 deltaMS，供稍后 _render 的 internalModel.update() 消费，否则动作冻结。
      const app = appRef.current
      if (app) {
        model.update(app.ticker.deltaMS || 16.667)
      }

      // 判断鼠标跟踪是否激活（鼠标超过 1 秒未移动则切换到空闲眼神，参考 airi 的 1s 超时）
      if (mouseRef.current.active && performance.now() - mouseRef.current.lastMoveAt > 1000) {
        mouseRef.current.active = false
      }
      const mouseTrackingActive = animation.mouseTracking && mouseRef.current.active

      // 执行顺序（参考 airi：用户参数 → 表情 → 眨眼 → 眼神）：
      // 1. 应用用户参数（写 angleZ + eyeOpen + eyebrow + mouth + body + breath）
      //    鼠标跟踪激活时跳过 angleX/Y（由 updateEyeTracking 覆盖）
      applyModelParameters(coreModel, params, mouseTrackingActive)

      // 2. 表情（在用户参数之后、眨眼之前应用，参考 airi 的表情应用顺序）
      //    每帧先还原上一帧的表情参数基础值，再应用当前表情，避免叠加残留。
      //    currentExpressionParamsRef 由 updateCurrentExpression 维护，已合并角色卡覆盖。
      if (currentExpressionParamsRef.current.length > 0) {
        applyExpression(coreModel, currentExpressionParamsRef.current, expressionBaseValuesRef.current)
      } else if (expressionBaseValuesRef.current.size > 0) {
        // 表情已关闭或未选中：还原之前被表情修改的参数
        restoreExpressionBase(coreModel, expressionBaseValuesRef.current)
      }

      // 3. 眨眼（读回 eyeOpen 值，乘以眨眼系数）
      if (animation.enableBlink) {
        updateBlink(coreModel, blinkRef.current, animation.blinkMode, delta, params)
      }

      // 4. 鼠标跟踪 / 空闲眼神（覆盖 angleX/Y 和 eyeBallX/Y）
      if (mouseTrackingActive) {
        updateEyeTracking(coreModel, mouseRef.current, animation, focusRef.current)
      } else if (animation.idleEyeMovement) {
        updateIdleEyes(internal!, idleEyeRef.current, delta)
      }

      // 5. 口型同步（最后应用，覆盖嘴巴开合参数）
      //    执行顺序：用户参数 → 表情 → 眨眼 → 眼神 → 口型同步
      //    口型放在最后，确保说话时嘴巴开合优先于其他参数对口型的修改。
      //    同时设置 ParamMouthOpen 和 ParamMouthOpenY：
      //    不同 Live2D 模型使用的嘴巴参数名不同（有的只有 ParamMouthOpenY，
      //    有的只有 ParamMouthOpen），两个都设置确保兼容。
      if (lipSyncRef.current.isPlaying) {
        const mouthOpen = lipSyncRef.current.getMouthOpen()
        coreModel.setParameterValueById?.('ParamMouthOpen', mouthOpen)
        coreModel.setParameterValueById?.('ParamMouthOpenY', mouthOpen)
      }
    }

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

        // 注册每帧参数引擎
        app.ticker.add(tickerFn)

        // 应用 FPS 限制
        const anim = settingsRef.current.animation
        app.ticker.maxFPS = anim.maxFps === 0 ? 0 : anim.maxFps

        // 监听窗口尺寸变化：始终恢复到基准尺寸，忽略拖动中的失真读数
        ro = new ResizeObserver(() => {
          if (!container || cancelledRef.current) return
          app.renderer.resize(baseW, baseH)
          fitModel()
        })
        ro.observe(container)

        // 鼠标跟踪：通过主进程全局轮询获取鼠标坐标（参考 airi 桌面端用 OS API）
        // 透明窗口 + -webkit-app-region: drag 导致 window.mousemove 无法正常触发，
        // 且需要跟踪屏幕任意位置的鼠标，不仅限于 300x440 的桌宠窗口内。
        // 主进程每 33ms 发送 cursor:move 事件，坐标已转换为窗口相对坐标。
        unsubCursor = api.pet.onCursorMove((pos) => {
          mouseRef.current.x = pos.x
          mouseRef.current.y = pos.y
          mouseRef.current.lastMoveAt = performance.now()
          mouseRef.current.active = true
        })

        // ---- 3. 渲染形象分发 ----
        // 不再在此直接 loadModel：统一交给 applyRenderState 按当前有效模式/设置分发，
        // 避免 init 在设置就绪前抢先加载 Live2D，导致与立绘并存。
        applyRenderState()

        // 随机待机动作（角色卡覆盖优先，否则跟随全局设置）
        idleTimer = setInterval(() => {
          const idleAnim = getEffectiveIdleAnimation()
          playRandomIdle(modelRef.current, idleAnim || undefined)
        }, IDLE_MS)
      } finally {
        booting = false
      }
    }

    void init()

    // 订阅始终注册（即使 core 缺失也会收到导入事件后重试）：
    // 角色卡切换 → 换模型 + 应用表情/待机动作覆盖；模型列表变化 / Cubism Core 导入 → 重新初始化
    unsubModel = api.pet.onCardChanged((payload: PetCardPayload) => {
      const { modelId, modelOverride, renderMode, spriteId, emotionMap, live2dExpressionMap } = payload ?? {}
      // 记录角色卡的模型覆盖配置，触发表情参数刷新
      cardModelOverrideRef.current = modelOverride ?? null
      // 记录形象呈现相关配置（立绘/情绪映射/渲染模式），供渲染分发与情绪联动使用
      spriteIdRef.current = spriteId ?? null
      emotionMapRef.current = emotionMap ?? null
      live2dExpressionMapRef.current = live2dExpressionMap ?? null
      // 角色卡显式设定的形象模式（null = 跟随全局当前形象）
      cardModeRef.current = renderMode ?? null
      currentCardModelIdRef.current = modelId ?? null
      updateCurrentExpression()
      // 统一按当前有效模式与资源刷新桌面形象
      applyRenderState()
    })
    unsubModels = api.pet.onModelsChanged(() => {
      void init()
    })
    unsubCore = api.pet.onCoreChanged(() => {
      void init()
    })

    /** 按当前角色卡/全局配置的渲染模式与资源，统一刷新桌面形象（Live2D 或立绘） */
    const applyRenderState = () => {
      const nextMode = effectiveRenderMode()
      const modeChanged = nextMode !== modeRef.current
      if (modeChanged) {
        modeRef.current = nextMode
        setMode(nextMode)
      }
      if (nextMode === 'sprite') {
        // 立绘：作废在途的 Live2D 加载请求并销毁已加载模型，避免初始阶段二者并存
        loadGenRef.current++
        clearModel()
        applySprite()
      } else {
        // Live2D：清空残留立绘状态，只渲染动画模型
        setSprite(null)
        const mid = getEffectiveModelId()
        // 模式发生切换（例如从立绘切回 Live2D）或模型 id 变化时，重新加载模型，
        // 避免守卫误判"模型未变"而漏加载导致形象消失
        if (modeChanged || mid !== currentModelIdRef.current) {
          void loadModel(mid ?? undefined)
        }
      }
    }

    /** 应用模型设置（更新 ticker、拟合，并按全局形象刷新桌面） */
    const applySettings = (settings: ModelSettings) => {
      const prevIdle = settingsRef.current.animation.idleAnimation
      settingsRef.current = settings
      // 全局当前立绘集变化时记录，供立绘回退用
      selectedSpriteIdRef.current = settings.selectedSpriteId ?? null
      // FPS 变化时更新 ticker
      if (appRef.current) {
        appRef.current.ticker.maxFPS = settings.animation.maxFps === 0 ? 0 : settings.animation.maxFps
      }
      // 缩放/位置变化时重新拟合
      fitModel()
      // 表情设置变化时更新当前表情参数
      updateCurrentExpression()
      // 空闲动作组变化时立即播放一次，第一时间看到效果（无需等待 10s 定时器）
      if (prevIdle !== settings.animation.idleAnimation) {
        playRandomIdle(modelRef.current, settings.animation.idleAnimation || undefined)
      }
      // 全局当前形象变化（model/sprite 切换）时统一刷新桌面形象
      applyRenderState()
    }

    // 订阅模型设置变化（设置窗口修改后实时同步）
    unsubSettings = api.pet.onModelSettingsChanged((settings) => {
      applySettings(settings)
    })

    // 订阅 AI 回复情绪：立绘切图 / Live2D 切表情（情绪联动核心）
    unsubEmotion = api.pet.onEmotion((emotion: StandardEmotion) => {
      currentEmotionRef.current = emotion
      if (modeRef.current === 'sprite') {
        // 回复完成：退出思考态，回到情绪/空闲态
        displayStateRef.current = 'idle'
        applySprite()
      } else {
        updateCurrentExpression()
      }
    })

    // 订阅"思考中"状态：立绘模式切换到思考立绘（开始准备回答到输出文本前）
    unsubThinking = api.pet.onThinking((thinking: boolean) => {
      if (modeRef.current !== 'sprite') return
      if (thinking) {
        // 新一轮输入：情绪归零（natural 平静），进入思考态
        currentEmotionRef.current = DEFAULT_EMOTION
        displayStateRef.current = 'thinking'
      } else if (displayStateRef.current === 'thinking') {
        displayStateRef.current = 'idle'
      }
      applySprite()
    })

    // 订阅立绘集列表变化（导入/删除/切全局后重解析）
    unsubSprites = api.sprite.onChanged(() => {
      if (modeRef.current === 'sprite') applyRenderState()
    })

    // 启动时加载已保存的模型设置
    void api.modelSettings.get().then((settings) => {
      applySettings(settings)
    })

    return () => {
      cancelledRef.current = true
      idleTimer && clearInterval(idleTimer)
      unsubModel()
      unsubModels()
      unsubCore()
      unsubSettings()
      unsubEmotion()
      unsubThinking()
      unsubSprites()
      unsubCursor()
      ro?.disconnect()
      // 停止口型同步并释放 AudioContext
      lipSyncRef.current.stop()
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
      {/* 加载中：居中品牌渐变环形加载（立绘模式不显示） */}
      {loading && !banner && mode !== 'sprite' && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="brand-spinner" />
        </div>
      )}

      {/* 2D 立绘展示层：仅立绘模式显示，覆盖在 Live2D 画布上方（避免切换后与 Live2D 并存） */}
      {mode === 'sprite' && sprite && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.25 }}
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-4"
        >
          <img
            src={sprite.url}
            alt={sprite.name}
            draggable={false}
            className="max-h-full max-w-full select-none object-contain"
          />
        </motion.div>
      )}

      {banner && mode !== 'sprite' && (
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

/**
 * 从情绪映射中取某情绪对应的资源名；缺失时回退 neutral。
 * 用于立绘模式选图与 Live2D 模式选表情。
 */
function pickEmotionAsset(
  map: Partial<Record<StandardEmotion, string>> | null | undefined,
  emotion: StandardEmotion,
): string {
  return map?.[emotion] ?? map?.[DEFAULT_EMOTION] ?? ''
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

function playTap(model: Live2DModel | null, idleAnimation?: string) {
  if (!model) return
  try {
    const groups = getMotionGroups(model)
    const tapGroup = ['TapBody', 'TapHead', 'Tap'].find((g) => groups.includes(g))
    if (tapGroup) {
      model.motion(tapGroup, 0, PRIORITY_FORCE)
      return
    }
    playRandomIdle(model, idleAnimation)
  } catch {
    // 忽略动作播放失败
  }
}

function playRandomIdle(model: Live2DModel | null, preferredGroup?: string) {
  if (!model) return
  try {
    // 如果指定了空闲动作组，优先播放该组
    if (preferredGroup) {
      const groups = getMotionGroups(model)
      if (groups.includes(preferredGroup)) {
        model.motion(preferredGroup, 0, PRIORITY_IDLE)
        return
      }
      // 选中的动作组名与模型实际加载的动作组不匹配（常见于下拉框取自别的模型）时给出提示
      console.warn('[pet] 空闲动作组不存在于当前展示模型:', preferredGroup, '实际可用:', groups)
    }
    // 否则从非 Tap 开头的动作组中随机选择
    const groups = getMotionGroups(model).filter((g) => !g.toLowerCase().startsWith('tap'))
    if (groups.length === 0) {
      console.warn('[pet] 当前模型没有可播放的空闲动作组（model3.json 未声明 Motions 或动作文件缺失）')
      return
    }
    const pick = groups[Math.floor(Math.random() * groups.length)] as string
    model.motion(pick, 0, PRIORITY_IDLE)
  } catch (err) {
    console.warn('[pet] 播放空闲动作失败:', err instanceof Error ? err.message : err)
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

// ==================== 参数引擎 ====================

/** Cubism Core 模型接口（仅声明参数引擎用到的部分） */
interface CoreModelLike {
  setParameterValueById?: (id: string, value: number) => void
  getParameterValueById?: (id: string) => number
  addParameterValueById?: (id: string, value: number, weight?: number) => void
  multiplyParameterValueById?: (id: string, value: number, weight?: number) => void
}

/** pixi-live2d-display 的 focusController 接口（驱动头部旋转平滑过渡） */
interface FocusControllerLike {
  focus?: (x: number, y: number, instant?: boolean) => void
  update?: (deltaTime: number) => void
}

/** InternalModel 接口（暴露 coreModel 和 focusController） */
interface InternalModelLike {
  coreModel?: CoreModelLike
  focusController?: FocusControllerLike
}

/**
 * 将用户设置的模型参数写入 Cubism Core（每帧调用，覆盖 SDK 动画的同名参数）。
 * 对应 airi 的 Model.vue 第 339-359 行参数映射。
 * 当 mouseTrackingActive=true 时跳过 angleX/angleY，让 model.focus() 的 focusController 控制头部旋转。
 */
function applyModelParameters(core: CoreModelLike, p: ModelParameters, mouseTrackingActive: boolean): void {
  if (!core.setParameterValueById) return
  // Head Rotation（鼠标跟踪激活时跳过 X/Y，由 focusController 控制）
  if (!mouseTrackingActive) {
    core.setParameterValueById('ParamAngleX', p.angleX)
    core.setParameterValueById('ParamAngleY', p.angleY)
  }
  core.setParameterValueById('ParamAngleZ', p.angleZ)
  // Eyes（注意：ParamEyeBallX/Y 不在此处设置，由鼠标跟踪/空闲眼神控制）
  core.setParameterValueById('ParamEyeLOpen', p.leftEyeOpen)
  core.setParameterValueById('ParamEyeROpen', p.rightEyeOpen)
  core.setParameterValueById('ParamEyeSmile', p.leftEyeSmile)
  // Eyebrows
  core.setParameterValueById('ParamBrowLX', p.leftEyebrowLR)
  core.setParameterValueById('ParamBrowRX', p.rightEyebrowLR)
  core.setParameterValueById('ParamBrowLY', p.leftEyebrowY)
  core.setParameterValueById('ParamBrowRY', p.rightEyebrowY)
  core.setParameterValueById('ParamBrowLAngle', p.leftEyebrowAngle)
  core.setParameterValueById('ParamBrowRAngle', p.rightEyebrowAngle)
  core.setParameterValueById('ParamBrowLForm', p.leftEyebrowForm)
  core.setParameterValueById('ParamBrowRForm', p.rightEyebrowForm)
  // Mouth
  core.setParameterValueById('ParamMouthOpenY', p.mouthOpen)
  core.setParameterValueById('ParamMouthForm', p.mouthForm)
  // Face
  core.setParameterValueById('ParamCheek', p.cheek)
  // Body
  core.setParameterValueById('ParamBodyAngleX', p.bodyAngleX)
  core.setParameterValueById('ParamBodyAngleY', p.bodyAngleY)
  core.setParameterValueById('ParamBodyAngleZ', p.bodyAngleZ)
  // Breath
  core.setParameterValueById('ParamBreath', p.breath)
}

// ---------------- 表情参数应用 ----------------

/**
 * 将 exp3.json 的表情参数应用到 Cubism Core（每帧调用）。
 * 参考 airi 的 expression-tools.ts：自行实现三种混合模式，不依赖 SDK 的 ExpressionManager。
 *
 * 防残留机制（修复切换/关闭表情时旧参数不消失的 bug）：
 * - 每帧应用表情前，先把上一帧被表情修改过的参数还原到基础值（baseValues）
 * - 然后重新记录当前帧的基础值（applyModelParameters 设定的值），再叠加表情
 * - 当表情被关闭或切换为不含某参数的新表情时，该参数自动还原
 *
 * 混合模式（对应 exp3.json 的 Blend 字段）：
 * - Add: 在基础值上叠加（addParameterValueById）
 * - Multiply: 与基础值相乘（multiplyParameterValueById）
 * - Overwrite: 直接覆盖（setParameterValueById）
 *
 * 注意：airi 有意忽略 FadeInTime / FadeOutTime，此处同样不实现淡入淡出。
 */
function applyExpression(
  core: CoreModelLike,
  params: ExpressionParameter[],
  baseValues: Map<string, number>,
): void {
  // 1. 还原上一帧被表情修改的参数到基础值
  for (const [id, val] of baseValues) {
    core.setParameterValueById?.(id, val)
  }
  baseValues.clear()

  // 2. 记录当前帧的基础值，然后应用表情
  for (const p of params) {
    const base = core.getParameterValueById?.(p.Id) ?? 0
    baseValues.set(p.Id, base)

    switch (p.Blend) {
      case 'Add':
        core.addParameterValueById?.(p.Id, p.Value, 1)
        break
      case 'Multiply':
        core.multiplyParameterValueById?.(p.Id, p.Value, 1)
        break
      case 'Overwrite':
        core.setParameterValueById?.(p.Id, p.Value)
        break
    }
  }
}

/**
 * 还原所有被表情修改过的参数到基础值，并清空记录。
 * 在表情系统关闭或模型切换时调用，确保表情参数彻底清除。
 */
function restoreExpressionBase(core: CoreModelLike, baseValues: Map<string, number>): void {
  for (const [id, val] of baseValues) {
    core.setParameterValueById?.(id, val)
  }
  baseValues.clear()
}

// ---------------- 眨眼状态机 ----------------

interface BlinkState {
  phase: 'idle' | 'closing' | 'opening'
  progress: number
  startLeft: number
  startRight: number
  delayMs: number
  openDurationMs: number
}

/** 创建眨眼状态机初始值 */
function createBlinkState(): BlinkState {
  return {
    phase: 'idle',
    progress: 0,
    startLeft: 1,
    startRight: 1,
    delayMs: 3000 + Math.random() * 5000,
    openDurationMs: 300,
  }
}

/** 眨眼时间常量（参考 airi） */
const BLINK_CLOSE_MS = 75
const BLINK_OPEN_MIN_MS = 150
const BLINK_OPEN_MAX_MS = 300
const BLINK_DELAY_MIN_MS = 3000
const BLINK_DELAY_MAX_MS = 8000

/** 限制到 0~1 */
function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

/** easeOutQuad: 1 - (1-t)² */
function easeOutQuad(t: number): number {
  return 1 - (1 - t) * (1 - t)
}

/** easeInQuad: t² */
function easeInQuad(t: number): number {
  return t * t
}

/**
 * 每帧更新眨眼。支持两种模式（参考 airi 的 useMotionUpdatePluginAutoEyeBlink）：
 * - Auto：调用 SDK 内置 eyeBlink 控制器，再与用户设置的 eyeOpen 相乘
 * - Force：自定义状态机（idle → closing → opening），3-8 秒随机间隔
 *
 * 眨眼在 applyModelParameters 之后执行（对应 airi 的 final 阶段），
 * 读回 applyModelParameters 写入的 base 值，乘以眨眼系数后覆盖。
 */
function updateBlink(
  core: CoreModelLike,
  state: BlinkState,
  mode: 'auto' | 'force',
  delta: number,
  params: ModelParameters,
): void {
  const dtMs = delta * (1000 / 60)
  const baseLeft = params.leftEyeOpen
  const baseRight = params.rightEyeOpen

  // ---- Auto 模式：SDK eyeBlink × 用户 eyeOpen ----
  if (mode === 'auto') {
    // SDK eyeBlink 已在 motionManager.update 中执行，这里读回值并乘以用户系数
    const curL = core.getParameterValueById?.('ParamEyeLOpen') ?? 1
    const curR = core.getParameterValueById?.('ParamEyeROpen') ?? 1
    core.setParameterValueById?.('ParamEyeLOpen', clamp01(curL * baseLeft))
    core.setParameterValueById?.('ParamEyeROpen', clamp01(curR * baseRight))
    return
  }

  // ---- Force 模式：自定义状态机 ----

  // idle 阶段：倒计时到下次眨眼，同时每帧写入 base 值保持眼睛打开
  if (state.phase === 'idle') {
    state.delayMs = Math.max(0, state.delayMs - dtMs)
    if (state.delayMs === 0) {
      state.phase = 'closing'
      state.progress = 0
      state.startLeft = baseLeft
      state.startRight = baseRight
    }
    // idle 阶段也写入 base 值，防止其他参数覆盖
    core.setParameterValueById?.('ParamEyeLOpen', baseLeft)
    core.setParameterValueById?.('ParamEyeROpen', baseRight)
    return
  }

  // closing 阶段：easeOutQuad 从 start 向 0 收敛
  if (state.phase === 'closing') {
    state.progress = Math.min(1, state.progress + dtMs / BLINK_CLOSE_MS)
    const eased = easeOutQuad(state.progress)
    core.setParameterValueById?.('ParamEyeLOpen', clamp01(state.startLeft * (1 - eased)))
    core.setParameterValueById?.('ParamEyeROpen', clamp01(state.startRight * (1 - eased)))
    if (state.progress >= 1) {
      state.phase = 'opening'
      state.progress = 0
      state.openDurationMs = BLINK_OPEN_MIN_MS + Math.random() * (BLINK_OPEN_MAX_MS - BLINK_OPEN_MIN_MS)
    }
    return
  }

  // opening 阶段：easeInQuad 从 0 向 start 回归
  if (state.phase === 'opening') {
    state.progress = Math.min(1, state.progress + dtMs / state.openDurationMs)
    const eased = easeInQuad(state.progress)
    core.setParameterValueById?.('ParamEyeLOpen', clamp01(state.startLeft * eased))
    core.setParameterValueById?.('ParamEyeROpen', clamp01(state.startRight * eased))
    if (state.progress >= 1) {
      // 回到 idle，重置延迟
      state.phase = 'idle'
      state.delayMs = BLINK_DELAY_MIN_MS + Math.random() * (BLINK_DELAY_MAX_MS - BLINK_DELAY_MIN_MS)
      core.setParameterValueById?.('ParamEyeLOpen', baseLeft)
      core.setParameterValueById?.('ParamEyeROpen', baseRight)
    }
  }
}

// ---------------- 空闲眼神 ----------------

interface IdleEyeState {
  nextSaccadeAt: number
  targetX: number
  targetY: number
  elapsed: number
  lastSaccadeAt: number
}

/** 创建空闲眼神状态初始值 */
function createIdleEyeState(): IdleEyeState {
  return {
    nextSaccadeAt: -1,
    targetX: 0,
    targetY: 0,
    elapsed: 0,
    lastSaccadeAt: 0,
  }
}

/**
 * 加权概率分布生成扫视间隔（参考 airi 的 utils/eye-motions.ts）。
 * 间隔范围 800ms~4400ms，大部分概率集中在 1200-2400ms。
 */
function randomSaccadeInterval(): number {
  const SACCADE_STEP = 400
  const cumulative = [0.075, 0.185, 0.310, 0.450, 0.575, 0.625, 0.665, 0.695, 0.715, 1.0]
  const r = Math.random()
  for (let i = 0; i < cumulative.length; i++) {
    if (r <= cumulative[i]!) {
      return 800 + i * SACCADE_STEP + Math.random() * SACCADE_STEP
    }
  }
  return 800 + 9 * SACCADE_STEP + Math.random() * SACCADE_STEP
}

/** 线性插值 */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/**
 * 空闲眼神动画（参考 airi 的 useLive2DIdleEyeFocus）。
 * 无鼠标跟踪时随机扫视，模拟人类眼球运动：
 * - 通过 focusController 驱动头部旋转平滑过渡（ParamAngleX/Y/Z）
 * - 直接写 ParamEyeBallX/Y 用 lerp 平滑（绕过 focusController 的眼球控制）
 */
function updateIdleEyes(
  internal: InternalModelLike,
  state: IdleEyeState,
  delta: number,
): void {
  const core = internal.coreModel
  if (!core) return
  const dtMs = delta * (1000 / 60)
  state.elapsed += dtMs

  // 到达下次扫视时间，或时间倒流（模型重载），生成新目标
  if (state.elapsed >= state.nextSaccadeAt || state.elapsed < state.lastSaccadeAt) {
    state.targetX = Math.random() * 2 - 1            // -1 ~ 1
    state.targetY = Math.random() * 1.7 - 1          // -1 ~ 0.7
    state.lastSaccadeAt = state.elapsed
    state.nextSaccadeAt = state.elapsed + randomSaccadeInterval()
    // 通过 focusController 设置头部注视方向（乘 0.5 缩小幅度，参考 airi）
    internal.focusController?.focus?.(state.targetX * 0.5, state.targetY * 0.5, false)
  }

  // 每帧推进 focusController 插值（驱动 ParamAngleX/Y/Z 平滑过渡）
  internal.focusController?.update?.((state.elapsed - state.lastSaccadeAt) / 1000)

  // 直接写 ParamEyeBallX/Y，用 lerp 平滑过渡（参考 airi 的 animation.ts）
  const curX = core.getParameterValueById?.('ParamEyeBallX') ?? 0
  const curY = core.getParameterValueById?.('ParamEyeBallY') ?? 0
  core.setParameterValueById?.('ParamEyeBallX', lerp(curX, state.targetX, 0.3))
  core.setParameterValueById?.('ParamEyeBallY', lerp(curY, state.targetY, 0.3))
}

// ---------------- 鼠标跟踪 ----------------

/**
 * 鼠标跟踪（参考 airi 的 useLive2DEyeFocusFor）。
 * 将鼠标在画布内的位置映射为 -1~1 的归一化坐标，
 * 通过 lerp 平滑插值后写入 ParamEyeBallX/Y（眼球）和 ParamAngleX/Y（头部旋转）。
 *
 * 每帧用 focusRef 中的缓存值朝目标值缓慢逼近（系数 0.08），
 * 让模型"追"着鼠标走而非瞬间跳到目标位置，视觉上更自然。
 *
 * mouse.x/y 是窗口相对坐标（由主进程 screen.getCursorScreenPoint - windowPosition 计算），
 * 可超出画布范围（鼠标在窗口外时），通过 clamp 限制到 -1~1。
 *
 * eyeOffset 是百分比，换算为像素后加到鼠标坐标上，微调注视点基准位置。
 */
function updateEyeTracking(
  core: CoreModelLike,
  mouse: { x: number; y: number; active: boolean; lastMoveAt: number },
  animation: ModelAnimationSettings,
  focus: { x: number; y: number },
): void {
  const canvasEl = document.querySelector('canvas')
  if (!canvasEl) return

  const rect = canvasEl.getBoundingClientRect()
  // mouse.x/y 是窗口相对坐标，rect.left/top 在透明窗口中通常为 0
  // eyeOffset: 百分比 → 像素偏移
  const offsetX = (animation.eyeOffsetX / 100) * rect.width
  const offsetY = (animation.eyeOffsetY / 100) * rect.height
  const cssX = mouse.x - rect.left + offsetX
  const cssY = mouse.y - rect.top + offsetY

  // 归一化到 -1~1（画布中心为 0,0），clamp 防止超出范围
  const targetX = Math.max(-1, Math.min(1, (cssX / rect.width) * 2 - 1))
  const targetY = Math.max(-1, Math.min(1, (cssY / rect.height) * 2 - 1))

  // lerp 平滑：每帧朝目标移动 8%，产生缓动的追踪效果
  focus.x = lerp(focus.x, targetX, 0.08)
  focus.y = lerp(focus.y, targetY, 0.08)

  // 眼球跟随（ParamEyeBallX/Y 范围 -1~1）
  core.setParameterValueById?.('ParamEyeBallX', focus.x)
  core.setParameterValueById?.('ParamEyeBallY', -focus.y) // Y 轴翻转：鼠标在上方时眼睛看上

  // 头部旋转跟随（ParamAngleX/Y 范围 -30~30）
  core.setParameterValueById?.('ParamAngleX', focus.x * 30)
  core.setParameterValueById?.('ParamAngleY', -focus.y * 30)
}
