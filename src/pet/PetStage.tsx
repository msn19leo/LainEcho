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
import type { Live2DModelMeta, ModelSettings, ModelParameters, ModelAnimationSettings, ExpressionMeta, ExpressionParameter, RenderMode, PetCardPayload, SpritePaletteEntry, ModelProfile, TouchRegion, SpriteTouchRegion, SpriteTouchFrame } from '../types'
import { BUILTIN_DEFAULT_EMOTION, labelMatches, paletteFromSprite, resolvePaletteImage, resolvePerformanceTarget } from '../types'
import { useCharacterStore } from '../store/characterStore'
import { DEFAULT_MODEL_SETTINGS, resolveModelParameters, resolveModelTouchRegions, resolveSpriteTouchRegions } from '../store/modelSettingsStore'
import { useSettingsStore } from '../store/settingsStore'
import { buildAppearanceCatalog, mergeAppearanceSelection } from '../lib/appearanceCatalog'
import { POSE_SLIDERS, buildModelProfile, paramRange, writeTarget } from '../lib/modelProfile'
import { buildTouchRegionsFromParts, pickRegion } from '../lib/touch'
import { LipSyncController } from './lipSync'

export interface PetStageHandle {
  zoom: (factor: number) => void
  playTap: () => void
  switchModel: (modelId: string) => void
  /** 当前模型缩放比例（缩放百分比徽标读取） */
  getScale: () => number
  /** 播放语音并驱动口型同步：传入 wav ArrayBuffer */
  speak: (audio: ArrayBuffer) => Promise<void>
  /** 当前语音播放进度（0~1；未播放返回 1）——播放进度插值上行用 */
  getPlayProgress: () => number
  /** 停止播放语音并清零口型参数 */
  stopSpeak: () => void
  /** 按句更新当前状态（桌宠句级播放时由 PetApp 调用，驱动立绘/表情联动；词表方案下为自由状态词） */
  setEmotion: (emotion: string) => void
  /** 按给定尺寸重建画布并重新适配角色（尺寸来自设置；不传则读容器） */
  resize: (width?: number, height?: number) => void
  /** 命中测试：窗口坐标 → 触点部位 id（未命中返回 null） */
  hitTest: (clientX: number, clientY: number) => string | null
  /** 播放一次触摸反应（动作 + 临时表情 + 语音 + 通知 AI） */
  playTouch: (regionId: string) => void
}

interface PetStageProps {
  stageRef: React.Ref<PetStageHandle>
  onStatus: (status: 'loading' | 'ready' | 'no-core' | 'no-model' | 'error', message?: string) => void
}

const IDLE_MS = 10_000

/**
 * 角色适配基准（常量，**不随窗口尺寸变化**）。
 *
 * 窗口只决定画布大小：放大窗口 = 角色周围多出留白（超出时裁切），而不是把角色放大。
 * 角色本身的大小归「角色模型 → 缩放」（settings.view.scale）管，两者正交。
 * 取值沿用旧版固定窗口的模型区尺寸（300×440），默认窗口下观感与旧版一致。
 */
const FIT_REF_W = 300
const FIT_REF_H = 440

// ===== 立绘 alpha 归一化（修复"横向姿态立绘显小"）=====
// 立绘渲染按整张 PNG 画布 object-contain 拟合：眺望等横向延展姿态的画布更宽，contain 受宽度
// 约束整图等比缩小 → 角色显小（2026-10-22 截图实锤）。改为按"非透明内容包围盒"拟合：首显时
// 解码扫描 alpha 边界（降采样 ≤512 扫描，误差亚像素级，按 URL 缓存一次），渲染按内容框等比
// 缩放，透明边不参与缩放——所有状态的角色本体尺寸一致。
type SpriteBBox = { w: number; h: number; x: number; y: number; bw: number; bh: number }
const spriteBBoxCache = new Map<string, Promise<SpriteBBox | null>>()

function loadSpriteBBox(url: string): Promise<SpriteBBox | null> {
  const hit = spriteBBoxCache.get(url)
  if (hit) return hit
  const p = (async (): Promise<SpriteBBox | null> => {
    try {
      // fetch → blob → createImageBitmap：blob 解码不污染 canvas（pet-res:// 直绘 img 会 taint，
      // getImageData 直接抛 SecurityError）；PetStage 既有路径已验证 pet-res 可 fetch
      const blob = await (await fetch(url)).blob()
      const bmp = await createImageBitmap(blob)
      try {
        const maxSide = 512
        const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height))
        const sw = Math.max(1, Math.round(bmp.width * k))
        const sh = Math.max(1, Math.round(bmp.height * k))
        const canvas = document.createElement('canvas')
        canvas.width = sw
        canvas.height = sh
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) return null
        ctx.drawImage(bmp, 0, 0, sw, sh)
        const data = ctx.getImageData(0, 0, sw, sh).data
        let minX = sw
        let minY = sh
        let maxX = -1
        let maxY = -1
        for (let y = 0; y < sh; y++) {
          for (let x = 0; x < sw; x++) {
            // alpha 阈值 8：忽略近全透明杂边（抗锯齿羽化边不参与包围盒）
            if ((data[(y * sw + x) * 4 + 3] ?? 0) > 8) {
              if (x < minX) minX = x
              if (x > maxX) maxX = x
              if (y < minY) minY = y
              if (y > maxY) maxY = y
            }
          }
        }
        if (maxX < 0) return null // 全透明（异常图）→ 回退整画布拟合
        const inv = 1 / k
        const box: SpriteBBox = {
          w: bmp.width,
          h: bmp.height,
          x: Math.floor(minX * inv),
          y: Math.floor(minY * inv),
          bw: Math.ceil((maxX - minX + 1) * inv),
          bh: Math.ceil((maxY - minY + 1) * inv),
        }
        console.log('[pet] 立绘 alpha 包围盒：%s 画布=%dx%d 内容=(%d,%d) %dx%d', url.slice(-40), box.w, box.h, box.x, box.y, box.bw, box.bh)
        return box
      } finally {
        bmp.close()
      }
    } catch {
      return null // 解码失败 → 渲染端回退整画布 contain（旧行为）
    }
  })()
  spriteBBoxCache.set(url, p)
  return p
}

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
  /** 上一次上报给主进程的"状态表情"（避免每次 ticker 都发 IPC） */
  const lastStateReportRef = useRef<string | null>(null)
  /** 当前模型的参数能力表（存在性/量程/物理驱动），模型加载后采集并上报 */
  const profileRef = useRef<ModelProfile | null>(null)
  /** beforeModelUpdate 钩子（每帧 core.update 之前回写用户姿态，保证「拖了就动」） */
  const beforeUpdateRef = useRef<(() => void) | null>(null)
  /** 当前模型的触摸命中区（用户覆盖 > 自动识别） */
  const touchRegionsRef = useRef<TouchRegion[]>([])
  /** 触摸触发的临时表情（压过状态词表与外观，到期自动失效） */
  const touchExprRef = useRef<{ names: string[]; until: number } | null>(null)
  /** 各部位上次触发时间（冷却） */
  const touchCooldownRef = useRef<Record<string, number>>({})
  /** 被用户手动取消的状态表情名：名字变了（新状态）就自动失效 */
  const dismissedStateRef = useRef<string | null>(null)
  /** 当前角色卡绑定的模型 id（null 表示未绑定，应使用全局选中模型） */
  const currentCardModelIdRef = useRef<string | null>(null)
  const [banner, setBanner] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  /** 当前形象渲染模式：'live2d'（动画）| 'sprite'（2D 静态立绘） */
  const [mode, setMode] = useState<RenderMode>('live2d')
  /** 立绘模式下当前展示的立绘（null = 不显示） */
  const [sprite, setSprite] = useState<{ url: string; name: string } | null>(null)
  /** 立绘 alpha 包围盒解析态（按 url）：ready=按内容框拟合；pending=暂不渲染防尺寸跳变；error=回退整画布拟合 */
  const [spriteBBoxState, setSpriteBBoxState] = useState<{ url: string; status: 'pending' | 'ready' | 'error'; box: SpriteBBox | null } | null>(null)
  /** 立绘展示层容器元素 + 内容盒实测尺寸（内容框拟合的可用空间，窗口/聊天区变化时跟随） */
  const [spriteLayerEl, setSpriteLayerEl] = useState<HTMLDivElement | null>(null)
  const [spriteLayerSize, setSpriteLayerSize] = useState<{ w: number; h: number } | null>(null)
  /** 当前模型缩放比例（滚轮缩放百分比徽标读取） */
  const currentScaleRef = useRef(1)
  /** 自适应得到的基准缩放（不含滚轮倍率） */
  const baseScaleRef = useRef(1)
  /** 滚轮缩放倍率（相对基准），1 = 原始大小 */
  const zoomFactorRef = useRef(1)
  /** 当前渲染模式引用（供 effect 闭包读取最新值，避免依赖数组重跑） */
  const modeRef = useRef<RenderMode>('live2d')
  /** 角色卡显式设定的形象模式（null = 跟随全局当前形象），由 onCardChanged 维护 */
  const cardModeRef = useRef<RenderMode | null>(null)
  /** 当前状态词（词表方案下为自由词，由 AI 回复状态联动更新） */
  const currentEmotionRef = useRef<string>(BUILTIN_DEFAULT_EMOTION)
  /** 当前立绘集词表的默认状态词（空闲/重置态的默认展示跟随它；resolveSprite 时刷新） */
  const paletteDefaultRef = useRef<string>(BUILTIN_DEFAULT_EMOTION)
  /** 上次已执行默认态迁移的默认状态词（迁移基准）：仅当词表默认词相对它变化且空闲时才迁移。
   *  不能用 paletteDefaultRef 当基准——refreshPalette 会先把它刷成新值，把"值变化"提前消费掉 */
  const migratedDefaultRef = useRef<string>(BUILTIN_DEFAULT_EMOTION)
  /** 当前生效演出词表快照（演出词表双轨，模式分轨）：sprite 模式 = 立绘集词表（查图）；
   *  live2d 模式 = Live2D 模型词表（查表情联动 expression）。由 refreshPalette 按模式刷新 */
  const paletteEntriesRef = useRef<Array<{ name: string; expression?: string }>>([])
  /** 当前角色卡绑定的立绘集 id（立绘模式渲染用） */
  const spriteIdRef = useRef<string | null>(null)
  /** 全局当前立绘集 id（modelSettings.selectedSpriteId，角色卡未绑定立绘时回退用） */
  const selectedSpriteIdRef = useRef<string | null>(null)
  /** 桌面立绘展示状态：idle(状态词展示) / speaking(说话) / thinking(思考) */
  const displayStateRef = useRef<'idle' | 'speaking' | 'thinking' | 'observing'>('idle')
  /** 上一帧说话状态（检测翻转以触发说话立绘切换） */
  const lastSpeakingRef = useRef(false)
  /** 立绘解析代数：每次 applySprite 递增，过期解析/重试结果作废 */
  const spriteGenRef = useRef(0)
  /** 立绘连续失败次数（成功清零；≤3 时自动重试，防失败风暴） */
  const spriteFailStreakRef = useRef(0)
  /** 立绘图片最近一次重试时间（按 URL 记录，30 秒内不重复重试） */
  const spriteImgRetryAtRef = useRef<Record<string, number>>({})
  /** 立绘模式失败提示（错误横幅在立绘模式不渲染，单独走此提示避免静默空白） */
  const [spriteNotice, setSpriteNotice] = useState<string | null>(null)
  /** Live2D 兜底加载是否已通过守卫尝试过（防"全局无选中 + 无卡绑定"守卫死区） */
  const live2dAttemptRef = useRef(false)
  /** 模型设置是否已就绪（首次 get() 返回后置 true；就绪前不做兜底加载） */
  const settingsLoadedRef = useRef(false)

  // 立绘 url 变化 → 解析 alpha 包围盒（模块级缓存，同 url 只扫一次；pending 态渲染层暂留空防尺寸跳变）
  useEffect(() => {
    if (!sprite) {
      setSpriteBBoxState(null)
      return
    }
    const url = sprite.url
    let alive = true
    setSpriteBBoxState({ url, status: 'pending', box: null })
    void loadSpriteBBox(url).then((box) => {
      if (alive && sprite.url === url) setSpriteBBoxState({ url, status: box ? 'ready' : 'error', box })
    })
    return () => {
      alive = false
    }
  }, [sprite])

  // 立绘展示层容器尺寸观测（窗口缩放/聊天区展开变化时重算内容框拟合）
  useEffect(() => {
    if (!spriteLayerEl) return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect
      if (r && r.width > 0 && r.height > 0) setSpriteLayerSize({ w: r.width, h: r.height })
    })
    ro.observe(spriteLayerEl)
    return () => ro.disconnect()
  }, [spriteLayerEl])

  /**
   * 本轮演出目标（模式 + 立绘集 + 模型）。
   *
   * 与主进程的词表解析共用 `resolvePerformanceTarget`——卡片绑定只在它自己的固定模式下生效，
   * 「跟随全局」时彻底忽略绑定。早先两处各写一套（渲染看了 renderMode、词表没看），
   * 于是"画面跟着全局换、AI 还在用卡片绑定的旧词表"（2026-10-31 定位）。
   */
  function performanceTarget() {
    return resolvePerformanceTarget({
      card: {
        renderMode: cardModeRef.current,
        spriteId: spriteIdRef.current,
        modelId: currentCardModelIdRef.current,
      },
      selectedSpriteId: selectedSpriteIdRef.current,
      selectedModelId: settingsRef.current.selectedModelId,
    })
  }

  /** 立绘内容框节点（alpha 包围盒对应的 div）：命中测试用它的屏幕矩形 */
  const spriteContentRef = useRef<HTMLDivElement | null>(null)
  /** 立绘模式下的触摸区域（按立绘集存） */
  const spriteTouchRegionsRef = useRef<SpriteTouchRegion[]>([])
  /** 立绘演出锁：演出期间丢弃情绪/说话/思考的切图请求，结束后补一次 */
  const spriteShowLockRef = useRef(false)
  /** 演出代数：重入/切模式时让旧演出的等待循环失效 */
  const spriteShowGenRef = useRef(0)
  /** 演出期间被丢弃的切图请求 */
  const spritePendingResolveRef = useRef(false)
  /** 当前 LipSync 播的是"触摸语音"（用于区分 AI 朗读：AI 朗读要让位，上一帧的触摸语音可以覆盖） */
  const touchVoiceActiveRef = useRef(false)
  const touchVoiceSeqRef = useRef(0)

  /** 播一句触摸台词（TTS 缓存命中即秒回；AI 朗读中由调用方跳过） */
  async function playTouchLine(line: string): Promise<void> {
    const text = line.trim()
    if (!text) return
    const seq = ++touchVoiceSeqRef.current
    const b64 = await api.touch.voice(text).catch(() => null)
    if (!b64) return
    // AI 正在朗读（且不是触摸自己播的）→ 让位，不掐断它
    if (lipSyncRef.current.isPlaying && !touchVoiceActiveRef.current) return
    // 触摸语音之间允许互相覆盖：立绘多帧演出时，下一帧的台词要顶掉上一句，
    // 否则单帧时长比语音短，后面几帧会被 isPlaying 挡掉（"只有第一帧出声"就是这样来的）
    touchVoiceActiveRef.current = true
    const bin = atob(b64)
    const buf = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
    try {
      await lipSyncRef.current.play(buf.buffer)
    } catch {
      // 播放被中断：忽略
    } finally {
      // 只有"最后一次触摸语音"播完才清标记，避免覆盖播放时误清
      if (touchVoiceSeqRef.current === seq) touchVoiceActiveRef.current = false
    }
  }

  /**
   * 2D 立绘的触摸反应。
   *
   * 与 Live2D 的差别：
   * - 没有动作/表情，触发的是"立绘序列"（逐帧切图 + 每帧台词 + 各自保持时长）；
   * - 开启「立即回应」时**整段跳过**：不切图、不播台词，只把旁白交给 AI。
   *   立绘有多段切换 + 思考图，和 AI 回复抢会非常乱，这是与 Live2D 的关键差异。
   */
  function playSpriteTouch(regionId: string): void {
    const region = spriteTouchRegionsRef.current.find((r) => r.id === regionId)
    if (!region) return
    const now = performance.now()
    const cfg = useSettingsStore.getState().settings.touch
    const cooldown = Math.max(200, cfg?.cooldownMs || 1200)
    if (now - (touchCooldownRef.current[regionId] ?? 0) < cooldown) return
    touchCooldownRef.current[regionId] = now

    const frames = (region.frames ?? []).filter((f) => !!f.image)
    if (cfg?.aiReply) {
      // 交给 AI：挡掉主动搭话，且不进入演出
      api.touch.reportPerforming(8000)
      void api.touch.notify({ label: region.label }).catch(() => undefined)
      console.log('[touch] 立绘区域「%s」：已开「立即回应」，跳过立绘切换与触摸台词', region.label)
      return
    }

    if (frames.length === 0) {
      console.warn('[touch] 立绘区域「%s」没有配置立绘序列，点了不会有视觉变化', region.label)
    }
    // 演出窗口：总时长 + 收尾余量，期间主动搭话让路
    const total = frames.reduce((sum, f) => sum + Math.max(200, f.holdMs || 1200), 0)
    api.touch.reportPerforming(total + 3000)

    void runSpriteShow(region, frames)
    // 旁白一次触摸一条（不是每帧一条，避免刷屏）
    void api.touch.notify({ label: region.label, line: frames[0]?.line ?? null }).catch(() => undefined)
  }

  /** 逐帧演出：切图 → 播该帧台词 → 等 holdMs；结束后按 restore 回到原图或停在最后一帧 */
  async function runSpriteShow(region: SpriteTouchRegion, frames: SpriteTouchFrame[]): Promise<void> {
    const spriteId = getEffectiveSpriteId()
    if (!spriteId || frames.length === 0) return
    const gen = ++spriteShowGenRef.current
    spriteShowLockRef.current = true
    spritePendingResolveRef.current = false
    try {
      for (const frame of frames) {
        if (gen !== spriteShowGenRef.current) return
        setSprite({ url: api.pet.spriteUrl(spriteId, frame.image), name: spriteId })
        const line = (frame.line ?? '').trim()
        if (line && useSettingsStore.getState().settings.touch?.voice) {
          void playTouchLine(line)
        }
        await sleep(Math.max(200, frame.holdMs || 1200))
      }
    } finally {
      // 代数不一致 = 被新演出/切模式作废，别去改共享状态
      if (gen === spriteShowGenRef.current) {
        const pendingDuringShow = spritePendingResolveRef.current
        spriteShowLockRef.current = false
        spritePendingResolveRef.current = false
        // restore=true：回到按当前情绪解析的图；
        // restore=false：停在最后一帧，但演出期间被挡下的请求要补上（否则会被"停住"吞掉）
        if (region.restore !== false || pendingDuringShow) applySprite()
      }
    }
  }

  /** 当前立绘模式实际使用的立绘集 id */
  function getEffectiveSpriteId(): string | null {
    return performanceTarget().spriteId
  }

  /** 当前 Live2D 模式实际使用的模型 id */
  function getEffectiveModelId(): string | null {
    return performanceTarget().modelId
  }

  /**
   * 计算当前有效渲染模式：
   *   角色卡显式设定了形象模式 → 用之；否则跟随全局（全局选中立绘集则立绘，否则 Live2D）。
   */
  function effectiveRenderMode(): RenderMode {
    return performanceTarget().mode
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
  /** 表情参数的当前显示值（P2b lerp 渐变层：跨帧插值，切换表情时向新目标平滑过渡） */
  const exprCurrentRef = useRef<Map<string, number>>(new Map())
  /** 表情参数的基线值（首次遇到该参数时记录的 coreModel 值；渐出终点 + Add/Multiply 叠加基准） */
  const exprBaseRefMap = useRef<Map<string, number>>(new Map())
  /** 口型同步控制器：播放音频并驱动 ParamMouthOpen */
  const lipSyncRef = useRef<LipSyncController>(new LipSyncController())

  useImperativeHandle(stageRef, () => ({
    zoom: (factor) => {
      const res = applyZoomFactor(modelRef.current, baseScaleRef.current, zoomFactorRef.current * factor)
      zoomFactorRef.current = res.factor
      currentScaleRef.current = res.scale
    },
    playTap: () => playTap(modelRef.current, settingsRef.current.animation.idleAnimation || undefined),
    getScale: () => currentScaleRef.current,

    hitTest: (clientX: number, clientY: number) => {
      // 立绘模式：内容框（alpha 包围盒对应的 div）的屏幕矩形就是归一化基准
      if (modeRef.current === 'sprite') {
        const el = spriteContentRef.current
        if (!el) return null
        const rect = el.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return null
        const u = (clientX - rect.left) / rect.width
        const v = (clientY - rect.top) / rect.height
        const hit = pickRegion(spriteTouchRegionsRef.current, u, v)
        console.log('[touch] sprite click u=%s v=%s regions=%d -> %s', u.toFixed(3), v.toFixed(3), spriteTouchRegionsRef.current.length, hit?.id ?? 'none')
        return hit?.id ?? null
      }
      const model = modelRef.current
      const canvasEl = document.querySelector('canvas')
      if (!model || !canvasEl) return null
      const b = computeCharacterBounds(model)
      if (!b || b.width <= 0 || b.height <= 0) return null
      // 包围盒是"模型本地像素"坐标，先换成屏幕坐标再和鼠标比，
      // 免得本地空间与画布空间的缩放/偏移约定不一致导致整体偏移
      const p0 = model.toGlobal(new PIXI.Point(b.x, b.y))
      const p1 = model.toGlobal(new PIXI.Point(b.x + b.width, b.y + b.height))
      const rect = canvasEl.getBoundingClientRect()
      const px = clientX - rect.left
      const py = clientY - rect.top
      const u = (px - p0.x) / (p1.x - p0.x)
      const v = (py - p0.y) / (p1.y - p0.y)
      const hit = pickRegion(touchRegionsRef.current, u, v)
      console.log('[touch] click u=%s v=%s regions=%d -> %s', u.toFixed(3), v.toFixed(3), touchRegionsRef.current.length, hit?.id ?? 'none')
      return hit?.id ?? null
    },

    playTouch: (regionId: string) => {
      if (modeRef.current === 'sprite') {
        playSpriteTouch(regionId)
        return
      }
      const region = touchRegionsRef.current.find((r) => r.id === regionId)
      if (!region) return
      const now = performance.now()
      const touchCfg = useSettingsStore.getState().settings.touch
      const cooldown = Math.max(200, touchCfg?.cooldownMs || 1200)
      if (now - (touchCooldownRef.current[regionId] ?? 0) < cooldown) return
      touchCooldownRef.current[regionId] = now
      // 演出窗口：主动搭话在此期间让路（动作时长未知，按表情保持时长 + 余量估）
      api.touch.reportPerforming(Math.max(5000, (region.holdMs ?? 1800) + 2500))
      // 动作：按配置顺序依次播（一个播完再下一个），播完按需回到空闲动作
      const motions = (region.motions ?? (region.motion ? [region.motion] : [])).filter(Boolean)
      if (motions.length > 0) {
        void playTouchMotions(
          modelRef.current,
          motions,
          region.restoreIdle !== false,
          settingsRef.current.animation.idleAnimation || undefined,
        )
      }
      // 表情：临时层（可多个同时套），压过状态词表与外观，到期自动回落
      const exprs = (region.expressions ?? (region.expression ? [region.expression] : [])).filter(Boolean)
      if (exprs.length > 0) {
        touchExprRef.current = { names: exprs, until: now + (region.holdMs ?? 1800) }
        updateCurrentExpression()
      }
      // 编辑时允许存在空行（否则按 Enter 不换行），真正播放前再过滤
      const lines = (region.lines ?? []).map((x) => x.trim()).filter(Boolean)
      // 命中但没有配任何反应时给一条日志：否则表现就是"点了没反应"，很难判断是没命中还是没配
      const hasReaction =
        (region.motions?.length ?? 0) > 0 ||
        !!region.motion ||
        (region.expressions?.length ?? 0) > 0 ||
        !!region.expression ||
        lines.length > 0
      if (!hasReaction) {
        console.warn('[touch] 命中「%s」，但该部位没有配置动作/表情/台词，所以看不到反应', region.label)
      }
      const line = lines.length > 0 ? lines[Math.floor(Math.random() * lines.length)] ?? null : null
      // 语音：AI 正在朗读时静默跳过；触摸语音之间允许覆盖（由 playTouchLine 统一处理）
      if (line && useSettingsStore.getState().settings.touch?.voice) {
        void playTouchLine(line)
      }
      // AI 感知：默认旁白入史，开启「立即回应」才当场说话
      void api.touch.notify({ label: region.label, line }).catch(() => undefined)
    },
    switchModel: (modelId) => {
      void loadModel(modelId)
    },
    /** 播放音频并启动口型同步 */
    speak: async (audio: ArrayBuffer) => {
      // AI 朗读接管声道：清掉"触摸语音占用"标记，之后触摸语音才会正确让位
      touchVoiceActiveRef.current = false
      await lipSyncRef.current.play(audio)
    },
    getPlayProgress: () => lipSyncRef.current.progress,
    /** 停止播放并清零口型 */
    stopSpeak: () => {
      lipSyncRef.current.stop()
    },
    /** 按句更新状态：写 emotion 并重应用立绘/表情 */
    setEmotion: (emotion: string) => {
      if (emotion !== currentEmotionRef.current) dismissedStateRef.current = null
      currentEmotionRef.current = emotion
      if (modeRef.current === 'sprite') {
        applySprite()
      } else {
        updateCurrentExpression()
      }
    },
    /**
     * 重建画布并重新适配角色。**尺寸由调用方给定**（来自设置），不从 DOM 反推：
     * 透明窗口拖动期间 `clientWidth/Height` 会报失真值，用它决定画布尺寸会被拉长。
     * 不传时退化为读容器，仅供无设置来源的临时场景（如首帧）。
     */
    resize: (width?: number, height?: number) => {
      const container = containerRef.current
      const app = appRef.current
      if (!app) return
      const w = Math.round(width ?? container?.clientWidth ?? 0) || 300
      const h = Math.round(height ?? container?.clientHeight ?? 0) || 300
      if (app.screen.width !== w || app.screen.height !== h) {
        try {
          app.renderer.resize(w, h)
        } catch {
          // 忽略 resize 异常
        }
      }
      fitModel()
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

    // 基础缩放按**固定基准**算，与当前画布尺寸无关 —— 否则调窗口会把角色一起放大/缩小。
    // 再乘用户设置的缩放系数（角色模型 → 缩放）。
    const view = settingsRef.current.view
    const baseScale = Math.min(FIT_REF_W / mw, FIT_REF_H / mh) * 0.9
    const base = baseScale * view.scale
    // 滚轮缩放用「基准 × 倍率」而不是在当前 scale 上连乘：
    // 连乘一旦被别处重置或漂移，就会出现"只能放大、回不去"的现象
    baseScaleRef.current = base
    const scale = base * zoomFactorRef.current
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
    // 摘掉上一模型的 beforeModelUpdate 钩子与能力表，避免旧模型数据串到新模型
    beforeUpdateRef.current?.()
    beforeUpdateRef.current = null
    profileRef.current = null
    touchExprRef.current = null
    touchRegionsRef.current = []
    touchCooldownRef.current = {}
    // 清空表情状态，防止旧模型的表情基础值残留到新模型
    expressionListRef.current = []
    currentExpressionParamsRef.current = []
    exprCurrentRef.current.clear()
    exprBaseRefMap.current.clear()
  }

  /**
   * 立绘模式：解析当前应显示的立绘图并设置 to sprite state。
   * 规则（词表方案单链）：状态查表 = 词表命中→软链→默认图；未打标集 = 内置最小词表（解析落首图）。
   * 说话图为系统演出态：仅在状态解析图等于默认图时让位。
   * 失败不再静默：打 warn 日志 + 显示 spriteNotice，短暂等待后自动重试一次（连续失败有上限）。
   * @param gen 本次解析的代数（applySprite 递增；过期代数的所有状态写入被丢弃）
   * @param spriteId 绑定的立绘集 id
   * @param emotion 当前状态词（默认"平静"）
   */
  async function resolveSprite(
    gen: number,
    spriteId: string | null,
    emotion: string = BUILTIN_DEFAULT_EMOTION,
    variant: 'idle' | 'speaking' | 'thinking' | 'observing' = 'idle',
  ) {
    // 触摸演出进行中：丢弃并记账，演出结束后补一次解析
    if (spriteShowLockRef.current) {
      spritePendingResolveRef.current = true
      return
    }
    if (!spriteId) {
      if (gen !== spriteGenRef.current) return
      setSprite(null)
      setSpriteNotice('当前形象为 2D 立绘，但没有绑定立绘集，请在设置 → 角色模型中选择')
      return
    }
    try {
      const list = await api.sprite.list()
      if (gen !== spriteGenRef.current) return
      const spr = list.find((s) => s.id === spriteId)
      if (!spr || spr.images.length === 0) {
        throw new Error(`立绘集不存在或没有图片（id=${spriteId}）`)
      }
      const has = (f: string | null | undefined) => !!f && spr.images.some((i) => i.filePath === f)
      // 词表默认状态词刷新 + 默认态跟随迁移（值变化触发，2026-10-18 回归修复）：
      // 仅当词表默认词相对"上次已迁移基准"变化且当前空闲（variant=idle）才迁移——
      // 保留"改默认状态 → 空闲立绘立即跟随"的目标（说话/思考变体期间不迁移，变体结束后
      // 下一次 idle 解析自然跟随）。
      // 【回归教训】早先的"空闲态无条件跟随新默认词"（2026-10-17 方案1）把"迁移"写成了
      // "每次 idle 解析都重置"：轮内任何回 idle 的瞬间（语音段间隙 lipSync end、块边界
      // setEmotion 恰逢 idle）都把 AI 轮内状态抹平为默认词——实锤"立绘切为委屈后，后面
      // 开心/害羞全部丢失、语音期间全程说话图"（平静让位说话图规则被重置误触发）。
      // 正确语义=默认词值变化事件触发迁移，而非 idle 状态触发重置。
      const newDefault = paletteFromSprite(spr).defaultEmotion
      if (variant === 'idle' && newDefault !== migratedDefaultRef.current) {
        migratedDefaultRef.current = newDefault
        currentEmotionRef.current = newDefault
        emotion = newDefault // 查表同步用迁移后的词（emotion 参数来自调用方的 currentEmotionRef 快照）
      }
      paletteDefaultRef.current = newDefault
      // 状态查表（词表单链）：命中词条图 → 未命中落默认状态图；未打标集（内置最小词表）= 首图
      const emotionFile = resolvePaletteImage(spr, emotion)
      // 说话图使用条件（用户定案）：正在说话且状态=「平静」——平静是唯一让位给说话图的状态；
      // 默认状态可设为其它词（如害羞），说话时显示害羞图而非说话图
      const calmFile = resolvePaletteImage(spr, BUILTIN_DEFAULT_EMOTION)
      // 变体立绘优先：思考 > 说话 > 状态查表图
      let file: string | null = null
      if (variant === 'observing') {
        // 观察态（点眼睛看屏幕的那几秒）：未配置观察图时回落思考图——
        // 两者都是"处理中"的演出，回落可避免用户点了却看不出反应
        if (has(spr.observingImage)) file = spr.observingImage
        else if (has(spr.thinkingImage)) file = spr.thinkingImage
      } else if (variant === 'thinking' && has(spr.thinkingImage)) {
        file = spr.thinkingImage
      } else if (variant === 'speaking' && has(spr.speakingImage) && (emotionFile == null || (calmFile != null && emotionFile === calmFile))) {
        file = spr.speakingImage
      }
      if (!file) {
        // 词表图必填 + 内置最小词表=首图 → emotionFile 正常恒非空；首图仅在异常配置下作为最后防御
        file = emotionFile ?? (has(spr.speakingImage) ? spr.speakingImage! : spr.images[0]!.filePath)
      }
      if (gen !== spriteGenRef.current) return
      spriteFailStreakRef.current = 0
      setSpriteNotice(null)
      setSprite({ url: api.pet.spriteUrl(spriteId, file), name: spr.name })
    } catch (err) {
      if (gen !== spriteGenRef.current) return
      const msg = err instanceof Error ? err.message : String(err)
      spriteFailStreakRef.current++
      console.warn(`[pet] 立绘解析失败(连续第${spriteFailStreakRef.current}次):`, msg)
      setSprite(null)
      setSpriteNotice(`2D 立绘加载失败：${msg}，将自动重试`)
      // 文件被占用/杀软扫描/瞬时 IPC 失败常可自愈：短暂等待后按同代数重试一次
      if (spriteFailStreakRef.current <= 3) {
        setTimeout(() => {
          if (gen !== spriteGenRef.current) return
          void resolveSprite(gen, spriteId, emotion, variant)
        }, 800)
      }
    }
  }

  /** 立绘模式统一重新解析当前立绘（依据当前状态 + 说话/思考状态） */
  function applySprite() {
    if (modeRef.current !== 'sprite') return
    spriteGenRef.current++
    void resolveSprite(
      spriteGenRef.current,
      getEffectiveSpriteId(),
      currentEmotionRef.current,
      displayStateRef.current,
    )
  }

  /**
   * 当前由「状态词表」驱动的表情（临时层）。
   * 规则（与用户确认）：默认状态词不算状态层——默认词走外观，否则外观会被默认表情永久压住。
   */
  function getActiveStateExpression(): string | null {
    if (currentEmotionRef.current === BUILTIN_DEFAULT_EMOTION) return null
    // 标签可能含「，」分隔的多段（害羞，心动）：旧消息里存的是单个词，按段匹配回查
    const entry = paletteEntriesRef.current.find((e) => labelMatches(currentEmotionRef.current, e.name))
    const expr = entry?.expression?.trim()
    if (!expr) return null
    if (!expressionListRef.current.some((e) => e.name === expr)) return null
    // 用户在外观面板点掉了这一项：直到状态词换掉之前都不再生效
    if (dismissedStateRef.current === expr) return null
    return expr
  }

  /** 外观面板点了"·状态"项：取消当前状态表情并立刻重算 */
  function dismissStateExpression(): void {
    const entry = paletteEntriesRef.current.find((e) => labelMatches(currentEmotionRef.current, e.name))
    const expr = entry?.expression?.trim()
    if (!expr) return
    dismissedStateRef.current = expr
    updateCurrentExpression()
  }

  /**
   * 获取当前生效的表情名（可多个）= 外观持久层 ∪ 状态临时层。
   *  - 互斥组内：状态优先（覆盖外观对应单选）；
   *  - 其余：并集（状态脸红不会把外观的裙子切换关掉）。
   * 外观（appearancesByModel）之后又加了一层旧字段 selectedExpression 的兼容兜底。
   */
  function getEffectiveExpressions(): string[] {
    const has = (name: string) => expressionListRef.current.some((e) => e.name === name)
    // 触摸临时表情：优先级最高，到期自动失效（不会永久压住状态词表）
    const touch = touchExprRef.current
    if (touch) {
      if (performance.now() > touch.until) touchExprRef.current = null
      else {
        const names = touch.names.filter(has)
        if (names.length > 0) return names
      }
    }
    if (!settingsRef.current.animation.expressionEnabled) return []
    // 注意区分「没配过」和「配过但全部关掉」：只有前者才回落到旧的全局 selectedExpression
    const perModelRaw = settingsRef.current.appearancesByModel?.[currentModelIdRef.current ?? '']
    const legacy = settingsRef.current.animation.selectedExpression
    const userList = perModelRaw ?? (legacy ? [legacy] : [])
    const state = getActiveStateExpression()
    if (!state) return userList.filter(has)
    const catalog = buildAppearanceCatalog(expressionListRef.current)
    return mergeAppearanceSelection(catalog, userList, state).filter(has)
  }

  /**
   * 获取当前生效的待机动作组（跟随全局设置）。
   * 返回空串表示无指定动作组（随机选择）。
   */
  function getEffectiveIdleAnimation(): string {
    return settingsRef.current.animation.idleAnimation
  }

  /**
   * 把"当前生效的空闲动作组"重定向到库的内置空闲槽（motionManager.groups.idle）。
   *
   * pixi-live2d-display 在动作队列空时会自动 startRandomMotion(groups.idle) 无限续播，
   * 默认固定指向 model3.json 的 "Idle" 组（cubism2 为 "idle"）。
   * - 选了有效组 → 重定向，库的自动续播播用户选的组，10s 定时器仅作兜底；
   * - 空串（不应用动作）或组名不存在 → 指向不可能存在的组（NO_IDLE_GROUP），
   *   库的 startRandomMotion 对未声明组直接返回 false，自动空闲被彻底禁用。
   */
  function applyIdleGroupToModel(): void {
    const model = modelRef.current as unknown as {
      internalModel?: {
        motionManager?: { groups?: { idle: string }; definitions?: Record<string, unknown>; __defaultIdle?: string }
      }
    } | null
    const mgr = model?.internalModel?.motionManager
    if (!mgr?.groups) return
    const preferred = getEffectiveIdleAnimation()
    const available = mgr.definitions ? Object.keys(mgr.definitions) : []
    mgr.groups.idle = preferred && available.includes(preferred) ? preferred : NO_IDLE_GROUP
  }

  /**
   * 根据当前设置（expressionEnabled + 生效表情名）和已加载的表情列表，
   * 更新 currentExpressionParamsRef。每帧由 ticker 读取并应用到 coreModel。
   * 参考 airi 的 expression-controller.ts：不使用 SDK 的 Expression Manager，直接管理参数。
   * P2b：表情名由 getEffectiveExpression 决定——状态词表联动优先，回落全局静态表情。
   */
  /** 状态表情变化时上报主进程（设置窗用它标记外观项） */
  function reportStateExpression(): void {
    const state = getActiveStateExpression()
    if (state === lastStateReportRef.current) return
    lastStateReportRef.current = state
    api.pet.reportStateExpression(state)
  }

  function updateCurrentExpression() {
    reportStateExpression()
    if (!settingsRef.current.animation.expressionEnabled) {
      currentExpressionParamsRef.current = []
      return
    }
    const names = getEffectiveExpressions()
    if (names.length === 0) {
      currentExpressionParamsRef.current = []
      return
    }
    // 多个外观项合并成一份参数表：同一参数按"后者覆盖"（互斥组在 UI 侧已保证只会选一个）
    const merged: ExpressionParameter[] = []
    for (const name of names) {
      const expr = expressionListRef.current.find((e) => e.name === name)
      if (!expr) continue
      for (const p of expr.parameters) {
        const idx = merged.findIndex((m) => m.Id === p.Id)
        if (idx >= 0) merged[idx] = p
        else merged.push(p)
      }
    }
    currentExpressionParamsRef.current = merged
  }

  /**
   * 刷新当前生效演出词表快照（演出词表双轨，模式分轨——与主进程 chatTurn 同口径）：
   * sprite 模式 → 立绘集词表（getEffectiveSpriteId）；live2d 模式 → Live2D 模型词表（角色卡绑定 > 全局选中）。
   * 默认状态词一并刷新（空闲/重置态跟随当前模式词表）；词表为空 = 内置最小词表（仅"平静"）。
   */
  async function refreshPalette() {
    try {
      if (modeRef.current === 'live2d') {
        const modelId = getEffectiveModelId()
        const palette = modelId ? await api.model.getPalette(modelId) : null
        if (palette && palette.entries.length > 0) {
          paletteEntriesRef.current = palette.entries
          // 兜底词：平静（在表内）> 第一个词条（与主进程 getModelPalette 口径一致）
          const names = new Set(palette.entries.map((e) => e.name))
          paletteDefaultRef.current = names.has(BUILTIN_DEFAULT_EMOTION) ? BUILTIN_DEFAULT_EMOTION : palette.entries[0]!.name
        } else {
          paletteEntriesRef.current = []
          paletteDefaultRef.current = BUILTIN_DEFAULT_EMOTION
        }
      } else {
        const spriteId = getEffectiveSpriteId()
        if (!spriteId) {
          paletteEntriesRef.current = []
          return
        }
        const list = await api.sprite.list()
        const spr = list.find((s) => s.id === spriteId)
        const palette = paletteFromSprite(spr)
        paletteEntriesRef.current = palette.entries
        paletteDefaultRef.current = palette.defaultEmotion
      }
    } catch {
      paletteEntriesRef.current = []
    }
  }

  /** 加载（或切换）指定模型；不传 modelId 时按优先级选择：角色卡绑定 > 全局选中 > 列表第一个 */
  async function loadModel(modelId?: string) {
    const app = appRef.current
    const cls = live2dClassRef.current
    if (!app || !cls || cancelledRef.current) return
    live2dAttemptRef.current = true // 通过守卫后才算"已尝试兜底加载"
    const gen = ++loadGenRef.current
    setLoading(true)

    let models: Live2DModelMeta[]
    try {
      models = await api.model.list()
    } catch (err) {
      if (gen !== loadGenRef.current || cancelledRef.current) return
      console.error('[pet] 模型列表读取失败:', err instanceof Error ? err.message : err)
      setLoading(false)
      onStatus('error', '模型列表读取失败')
      setBanner('模型列表读取失败，请重启应用后重试')
      return
    }
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
      findModel(getEffectiveModelId()) ??
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

      // ② 眼球所有权归应用：SDK 内置眨眼每帧在 core.update 之前把 ParamEyeLOpen/ROpen
      //    写回 1，应用随后写的眼睛参数会在下一帧被冲掉（实测强制写 0 仍然睁眼）。
      //    这里直接摘掉 SDK 眨眼控制器，眼睛完全交给应用自己的状态机，手动值才真正有效。
      const imAny = (model as unknown as {
        internalModel?: {
          eyeBlink?: unknown
          on?: (ev: string, fn: () => void) => void
          off?: (ev: string, fn: () => void) => void
        }
      }).internalModel
      if (imAny) {
        imAny.eyeBlink = undefined
        // ① 写入时机前移：beforeModelUpdate 就在 core.update() 前一行，
        //    在这里回写用户姿态，物理/眨眼/动作都压不过它，且当帧生效。
        if (typeof imAny.on === 'function') {
          const handler = () => applyFinalPoseOverrides()
          imAny.on('beforeModelUpdate', handler)
          beforeUpdateRef.current = () => imAny.off?.('beforeModelUpdate', handler)
        }
      }

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

      // ④ 采集能力表：参数存在性/真实量程（core）+ 眨眼/口型组（model3）+ 物理驱动（physics3）
      try {
        const imForProfile = (model as unknown as {
          internalModel?: InternalModelLike & { pixelsPerUnit?: number; originalWidth?: number; originalHeight?: number }
        }).internalModel
        if (imForProfile?.coreModel) {
          const profile = await collectModelProfile(meta.id, url, imForProfile)
          if (profile && gen === loadGenRef.current && !cancelledRef.current) {
            profileRef.current = profile
            api.pet.reportModelProfile(profile)
            console.log(
              '[pet] 能力表已采集:', meta.name,
              '参数', Object.keys(profile.params).length,
              '物理输出', profile.physicsOutputs.length,
              '可驱动', Object.keys(profile.drivers).length,
              '眨眼组', profile.eyeBlink.length,
            )
          }
        }
      } catch (err) {
        console.warn('[pet] 能力表采集失败（UI 退回兜底量程）:', err instanceof Error ? err.message : err)
      }

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
      // 模型加载完成：把生效的空闲动作组重定向到库的内置空闲槽，
      // 让库的自动续播（动作队列空时 startRandomMotion(groups.idle)）播用户选的组
      applyIdleGroupToModel()
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

  /**
   * ① 每帧 core.update() 之前的「用户姿态回写」。
   *
   * 为什么需要这一层：引擎的 update 顺序是
   *   动作 → 眨眼 → focus → 呼吸 → 物理 → pose → beforeModelUpdate → core.update → loadParameters
   * 物理与眨眼都在 core.update 之前把参数改成自己的值，应用在 update 之后写的参数下一帧就被冲掉。
   * 在 beforeModelUpdate 里回写，等于拿到「最后一句发言权」，且当帧生效。
   *
   * 但优先级仍要守住：表情、口型、鼠标跟踪、眨眼进行中占用的参数一律跳过，
   * 否则拖一次滑杆会把正在说话的口型或正在闪的表情压死。
   */
  function applyFinalPoseOverrides(): void {
    const model = modelRef.current
    if (!model) return
    const core = (model as unknown as { internalModel?: InternalModelLike }).internalModel?.coreModel
    if (!core?.setParameterValueById) return
    const settings = settingsRef.current
    const params = resolveModelParameters(settings, currentModelIdRef.current)
    const profile = profileRef.current
    const anim = settings.animation
    const speaking = lipSyncRef.current.isPlaying
    const tracking = anim.mouseTracking && mouseRef.current.active
    const blinking = blinkRef.current.phase !== 'idle'
    const exprIds = new Set(currentExpressionParamsRef.current.map((p) => p.Id))
    const done = new Set<string>()
    for (const slider of POSE_SLIDERS) {
      const id = slider.id
      if (done.has(id)) continue
      done.add(id)
      // 模型没有这个参数：写了也没有任何效果
      if (profile && !paramRange(profile, id)) continue
      // 表情 / 口型 / 鼠标跟踪 / 眨眼在进行中：这些是更高优先级的实时特征
      if (exprIds.has(id)) continue
      if (speaking && (id === 'ParamMouthOpenY' || id === 'ParamMouthForm' || id === 'ParamMouthOpen')) continue
      if (tracking && (id === 'ParamAngleX' || id === 'ParamAngleY')) continue
      // 跟踪时身体由驱动参数（如 PositionX）带起来，这里再回写输出参数会把跟随动作盖掉
      if (tracking && id.startsWith('ParamBodyAngle') && profile?.drivers?.[id]) continue
      if (blinking && (id === 'ParamEyeLOpen' || id === 'ParamEyeROpen')) continue
      const value = params[slider.key]
      const fallbackDef = slider.key === 'leftEyeOpen' || slider.key === 'rightEyeOpen' ? 1 : 0
      const def = (profile ? profile.params[id]?.def : undefined) ?? fallbackDef
      // 没动过的滑杆不写：保持「只有用户明确设置过的项才强制覆盖」
      if (Math.abs(value - def) < 1e-4) continue
      core.setParameterValueById(id, value)
    }
  }

  useEffect(() => {
    cancelledRef.current = false // 组件重挂载时复位（防 StrictMode 双挂载等场景）
    let idleTimer: ReturnType<typeof setInterval> | null = null
    let unsubModel = () => {}
    let unsubModels = () => {}
    let unsubCore = () => {}
    let unsubSettings = () => {}
    let unsubMotion = () => {}
    let unsubSnapshot = () => {}
    let unsubDismiss = () => {}
    let unsubEmotion = () => {}
    let unsubThinking = () => {}
    let unsubObserving = () => {}
    let unsubSprites = () => {}
    let unsubCursor = () => {}
    let booting = false

    /** 每帧参数引擎回调（注册到 PIXI ticker） */
    const tickerFn = (delta: number) => {
      // 触摸区域两种模式都要刷新：立绘模式没有 Live2D 模型，不能放到下面的 model 早退之后
      // （放错位置会导致 spriteTouchRegionsRef 永远是空数组，点击全部落空）
      const settingsNow = settingsRef.current
      touchRegionsRef.current =
        resolveModelTouchRegions(settingsNow, currentModelIdRef.current) ?? profileRef.current?.regions ?? []
      spriteTouchRegionsRef.current = resolveSpriteTouchRegions(settingsNow, getEffectiveSpriteId())

      // 立绘模式：检测说话态翻转，切换说话/空闲立绘（思考态优先不被覆盖）
      if (modeRef.current === 'sprite') {
        const speakingNow = lipSyncRef.current.isPlaying
        if (speakingNow !== lastSpeakingRef.current) {
          lastSpeakingRef.current = speakingNow
          if (speakingNow) {
            // 语音真正开始播放 = 角色此刻真正发声：无论当前是否思考态，都退出思考并切到说话立绘。
            // （思考立绘需保持到"首个语音/文本真正发声"，播放瞬间正是开始发声的时机。）
            console.log('[thinking] pet lipSync start, displayState=', displayStateRef.current, '-> speaking')
            displayStateRef.current = 'speaking'
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
      // 姿态参数按模型取：优先 parametersByModel[当前模型]，没有专属值才回落全局
      const params = resolveModelParameters(settings, currentModelIdRef.current)
      // 触摸表情到期检查：必须每帧查，否则只在下次事件时才重算，表现为"表情一直挂着"
      if (touchExprRef.current && performance.now() > touchExprRef.current.until) {
        touchExprRef.current = null
        updateCurrentExpression()
      }
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
      applyModelParameters(coreModel, params, mouseTrackingActive, profileRef.current)

      // 2. 表情（在用户参数之后、眨眼之前应用，参考 airi 的表情应用顺序）
      //    P2b lerp 渐变：applyExpression 内部对参数值做跨帧插值——切换表情时向新目标平滑过渡，
      //    移出表情的参数向基线平滑还原，收敛后停止写入。alpha 按帧间隔折算保证不同 FPS 下速度一致。
      applyExpression(
        coreModel,
        currentExpressionParamsRef.current,
        exprCurrentRef.current,
        exprBaseRefMap.current,
        Math.min(1, delta * 0.18),
      )

      // 3. 眨眼（读回 eyeOpen 值，乘以眨眼系数）
      if (animation.enableBlink) {
        // SDK 内置眨眼已在 loadModel 里被摘掉，'auto' 依赖的曲线不存在 → 统一走应用状态机
        updateBlink(coreModel, blinkRef.current, 'force', delta, params)
      }

      // 4. 鼠标跟踪 / 空闲眼神（覆盖 angleX/Y 和 eyeBallX/Y）
      if (mouseTrackingActive) {
        updateEyeTracking(coreModel, mouseRef.current, animation, focusRef.current, profileRef.current, params)
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
        // 嘴形联动：随开合给 ParamMouthForm 线性形变（闭嘴 0 / 张满 0.4），
        // 嘴"张开+咧开"比纯上下开合更自然；各主流模型都有该参数（cdi 已验证）
        coreModel.setParameterValueById?.('ParamMouthForm', mouthOpen * 0.4)
      }

      // 6. 控制器参数镜像（只对 VTS/VBridger 型模型生效）
      //    上面 1~5 步写的都是标准 Cubism 参数；这类模型真正驱动头/身体/物理的是
      //    AngleX/AngleY/AngleZ、PositionX/Y/Z 等「控制器参数」，不镜像就等于没动。
      //    放在最后 = 读到本帧最终值（含鼠标跟踪的 angleX/Y 与口型的 ParamMouthOpenY）。
      mirrorRigParameters(coreModel, profileRef.current)
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

        // 初始尺寸按容器量一次（此时窗口已按设置建好，读数可信）。
        // 之后画布尺寸只由 PetApp 通过 handle.resize 显式驱动：Windows 上拖动透明无边框窗口时
        // container.clientWidth 会瞬时失真，谁拿它当尺寸来源，谁就会被"拖着拖着变长"咬。
        const baseW = container.clientWidth || 300
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

        // 画布尺寸改由 PetApp 显式驱动（见 handle.resize）：窗口尺寸现在是设置项，
        // 只需要一个可信来源。此前这里的 ResizeObserver 会无条件 resize 回初始化尺寸，
        // 正是"放大窗口但 Live2D 只画在左上角 300×440 里"的原因（立绘走 CSS 居中，所以没暴露）。

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
    // 角色卡切换 → 换模型；模型列表变化 / Cubism Core 导入 → 重新初始化
    unsubModel = api.pet.onCardChanged((payload: PetCardPayload) => {
      const { cardId, modelId, renderMode, spriteId } = payload ?? {}
      // 同步宠物窗的当前角色卡（内容框名牌/头部显示当前角色名）
      if (cardId) {
        useCharacterStore.setState({ currentCardId: cardId })
      }
      // 记录形象呈现相关配置（立绘/渲染模式）；状态演出由立绘集词表驱动（resolveSprite 内查表）
      spriteIdRef.current = spriteId ?? null
      // 角色卡显式设定的形象模式（null = 跟随全局当前形象）
      cardModeRef.current = renderMode ?? null
      currentCardModelIdRef.current = modelId ?? null
      // 词表快照刷新（角色卡绑定的立绘集可能变化）+ 表情参数重算
      void refreshPalette()
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
        // 作废旧模式的触摸演出：代数 +1 让等待循环自行退出，并释放锁
        spriteShowGenRef.current++
        spriteShowLockRef.current = false
        spritePendingResolveRef.current = false
        spriteTouchRegionsRef.current = []
      }
      if (nextMode === 'sprite') {
        // 立绘：作废在途的 Live2D 加载请求并销毁已加载模型，避免初始阶段二者并存
        loadGenRef.current++
        clearModel()
        applySprite()
      } else {
        // Live2D：清空残留立绘状态，只渲染动画模型
        setSprite(null)
        setSpriteNotice(null)
        const mid = getEffectiveModelId()
        // 模式发生切换（例如从立绘切回 Live2D）、模型 id 变化，或"全局无选中 + 无卡绑定"
        // 从未尝试过加载时（守卫 null===null 死区），都重新加载模型；
        // 设置未就绪时跳过兜底（applySettings 送达后会再次走到这里）
        const neverAttempted = !modelRef.current && !live2dAttemptRef.current && settingsLoadedRef.current
        if (modeChanged || mid !== currentModelIdRef.current || neverAttempted) {
          void loadModel(mid ?? undefined)
        }
      }
    }

    /** 应用模型设置（更新 ticker、拟合，并按全局形象刷新桌面） */
    const applySettings = (settings: ModelSettings) => {
      settingsLoadedRef.current = true
      const prevIdle = settingsRef.current.animation.idleAnimation
      settingsRef.current = settings
      // 全局当前立绘集变化时记录，供立绘回退用；词表快照一并刷新（全局立绘集可能换）
      selectedSpriteIdRef.current = settings.selectedSpriteId ?? null
      void refreshPalette()
      // FPS 变化时更新 ticker
      if (appRef.current) {
        appRef.current.ticker.maxFPS = settings.animation.maxFps === 0 ? 0 : settings.animation.maxFps
      }
      // 缩放/位置变化时重新拟合
      fitModel()
      // 表情设置变化时更新当前表情参数
      updateCurrentExpression()
      // 空闲动作组变化时：立即生效，无需等待 10s 定时器
      if (prevIdle !== settings.animation.idleAnimation) {
        applyIdleGroupToModel()
        const motionMgr = (modelRef.current as unknown as {
          internalModel?: { motionManager?: { stopAllMotions?: () => void } }
        } | null)?.internalModel?.motionManager
        if (!settings.animation.idleAnimation) {
          // 切到"不应用动作"：停掉当前在播动作（含循环空闲）。库的自动空闲已被
          // applyIdleGroupToModel 禁用（groups.idle 指向不存在的哨兵组），模型回归静止
          motionMgr?.stopAllMotions?.()
          // 复位全部参数：动作硬停后参数停留在最后一帧（手部/手臂等定格），显式复位恢复标准姿势
          resetModelParameters(modelRef.current)
        } else {
          void playRandomIdle(modelRef.current, settings.animation.idleAnimation, true)
        }
      }
      // 全局当前形象变化（model/sprite 切换）时统一刷新桌面形象
      applyRenderState()
    }

    // 订阅模型设置变化（设置窗口修改后实时同步）
    unsubSettings = api.pet.onModelSettingsChanged((settings) => {
      applySettings(settings)
    })

    // 订阅「取消状态表情」：外观面板点了"·状态"项
    unsubDismiss = api.pet.onDismissStateExpression(() => dismissStateExpression())

    // 订阅「截一张当前姿势」：只上报几何信息，真正的窗口截图由主进程做
    // （自己 extract 画布会涉及裁剪原点/分辨率换算，坐标很容易整体偏移）
    unsubSnapshot = api.pet.onTouchSnapshot(() => {
      // 立绘模式：归一化基准是"立绘内容框"（alpha 包围盒），不是 Live2D 模型包围盒
      if (modeRef.current === 'sprite') {
        const el = spriteContentRef.current
        // 兜底：内容框节点还没挂上时（bbox 解析中/尺寸未就绪），用立绘层容器顶一下，
        // 至少能出图并编辑，不然设置窗会一直卡在"加载不出来"
        const fallback = spriteLayerEl
        const target = el ?? fallback
        if (!target) {
          console.warn('[touch] snapshot: 立绘层未挂载（mode=sprite，无内容框也无容器）')
          api.pet.sendTouchSnapshot(null)
          return
        }
        const r = target.getBoundingClientRect()
        if (r.width <= 0 || r.height <= 0) {
          console.warn('[touch] snapshot: 立绘几何为 0', { el: !!el, w: r.width, h: r.height })
          api.pet.sendTouchSnapshot(null)
          return
        }
        console.log('[touch] snapshot sprite', { content: !!el, fallback: !el, w: Math.round(r.width), h: Math.round(r.height) })
        api.pet.sendTouchSnapshot({
          image: '',
          width: 0,
          height: 0,
          bounds: { x: r.left, y: r.top, w: r.width, h: r.height },
          mode: 'sprite',
          spriteId: getEffectiveSpriteId(),
          // 当前正在显示的图（选择器里标「当前」用）
          spriteFile: sprite
            ? decodeURIComponent(sprite.url.replace(/^pet-res:\/\/sprites\/[^/]+\//, ''))
            : null,
        })
        return
      }
      const modelNow = modelRef.current
      const canvasEl = document.querySelector('canvas')
      if (!modelNow || !canvasEl) {
        api.pet.sendTouchSnapshot(null)
        return
      }
      try {
        const b = computeCharacterBounds(modelNow)
        if (!b || b.width <= 0 || b.height <= 0) {
          api.pet.sendTouchSnapshot(null)
          return
        }
        const p0 = modelNow.toGlobal(new PIXI.Point(b.x, b.y))
        const p1 = modelNow.toGlobal(new PIXI.Point(b.x + b.width, b.y + b.height))
        const rect = canvasEl.getBoundingClientRect()
        api.pet.sendTouchSnapshot({
          image: '',
          width: 0,
          height: 0,
          bounds: {
            x: p0.x + rect.left,
            y: p0.y + rect.top,
            w: p1.x - p0.x,
            h: p1.y - p0.y,
          },
          mode: 'live2d',
          spriteId: null,
        })
      } catch (err) {
        console.warn('[pet] 上报截图几何失败：', err instanceof Error ? err.message : err)
        api.pet.sendTouchSnapshot(null)
      }
    })

    // 订阅「一键动作」：设置面板点动作按钮 → 立刻播放一次（不改动待机动作设置）
    unsubMotion = api.pet.onPlayMotion((group) => {
      void playRandomIdle(modelRef.current, group, true)
    })

    // 订阅 AI 回复状态：立绘切图 / Live2D 切表情（状态联动核心；词表方案下为自由状态词）
    unsubEmotion = api.pet.onEmotion((emotion: string) => {
      // 新一轮回复 = 新的状态，用户上一轮点掉的"取消"到此失效（否则同样的情绪再来一次会永远不生效）
      dismissedStateRef.current = null
      currentEmotionRef.current = emotion
      if (modeRef.current === 'sprite') {
        // 回复完成：退出思考态，回到状态/空闲态
        displayStateRef.current = 'idle'
        applySprite()
      } else {
        updateCurrentExpression()
      }
    })

    // 订阅"思考中"状态：立绘模式切换到思考立绘（开始准备回答到输出文本前）
    unsubThinking = api.pet.onThinking((thinking: boolean) => {
      console.log('[thinking] pet onThinking=%s mode=%s', thinking, modeRef.current)
      if (modeRef.current !== 'sprite') return
      if (thinking) {
        // 新一轮输入：状态归到词表默认词（用户切换默认状态后重置态跟随变化）
        currentEmotionRef.current = paletteDefaultRef.current
        displayStateRef.current = 'thinking'
      } else if (displayStateRef.current === 'thinking') {
        displayStateRef.current = 'idle'
      }
      applySprite()
    })

    // 订阅"观察中"状态：点眼睛后看屏幕（截图 + 视觉模型转述）的那几秒切观察立绘。
    // 正常路径下这里**不会收到 false**——转述完成后 runChatTurn 立刻发 thinking(true)
    // 直接覆盖，视觉上是 观察图 → 思考图 无缝衔接，中间不闪状态图。
    // 收到 false 只可能是"观察了但没进入对话"的异常路径，做一次兜底归位。
    unsubObserving = api.pet.onObserving((observing: boolean) => {
      if (modeRef.current !== 'sprite') return
      if (observing) {
        if (displayStateRef.current === 'observing') return
        displayStateRef.current = 'observing'
      } else {
        // 已被 thinking 覆盖（正常路径）或本来就空闲 → 无需重解析
        if (displayStateRef.current !== 'observing') return
        displayStateRef.current = 'idle'
      }
      applySprite()
    })

    // 订阅立绘集列表变化（导入/删除/词表编辑后重解析 + 刷新词表快照）
    unsubSprites = api.sprite.onChanged(() => {
      void refreshPalette()
      if (modeRef.current === 'sprite') applyRenderState()
    })

    // 窗口从隐藏恢复显示时：立绘模式重新解析一次（自愈偶发失败；Live2D 靠 ticker 持续渲染无需处理）
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return
      if (modeRef.current === 'sprite') applySprite()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    // 启动时加载已保存的模型设置
    void api.modelSettings.get().then((settings) => {
      applySettings(settings)
    })

    return () => {
      cancelledRef.current = true
      document.removeEventListener('visibilitychange', onVisibilityChange)
      idleTimer && clearInterval(idleTimer)
      unsubModel()
      unsubModels()
      unsubCore()
      unsubSettings()
      unsubMotion()
      unsubDismiss()
      unsubSnapshot()
      unsubEmotion()
      unsubThinking()
      unsubObserving()
      unsubSprites()
      unsubCursor()
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

      {/* 2D 立绘展示层：仅立绘模式显示，覆盖在 Live2D 画布上方（避免切换后与 Live2D 并存）。
          内容框拟合：按 alpha 包围盒等比缩放（眺望等横向姿态不再因画布更宽而显小）；
          包围盒解析中不渲染（防整画布尺寸闪现后跳变）；解析失败回退整画布 contain（旧行为） */}
      {mode === 'sprite' && sprite && (
        <motion.div
          ref={setSpriteLayerEl}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.25 }}
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-4"
        >
          {(() => {
            const view = `translate(${settingsRef.current.spriteView.x}px, ${settingsRef.current.spriteView.y}px) scale(${settingsRef.current.spriteView.scale})`
            const imgProps = {
              src: sprite.url,
              alt: sprite.name,
              draggable: false,
              onError: () => {
                if (!sprite) return
                const url = sprite.url
                const last = spriteImgRetryAtRef.current[url] ?? 0
                if (Date.now() - last < 30_000) {
                  console.warn('[pet] 立绘图片加载失败（30 秒内已重试过，等待自动重试）:', url)
                  setSpriteNotice('2D 立绘图片暂时无法加载，将自动重试')
                  return
                }
                spriteImgRetryAtRef.current[url] = Date.now()
                console.warn('[pet] 立绘图片加载失败，重新解析一次:', url)
                applySprite()
              },
            }
            const bb =
              spriteBBoxState && spriteBBoxState.url === sprite.url ? spriteBBoxState : null
            if (bb && bb.status === 'ready' && bb.box && spriteLayerSize) {
              // 内容高度撑满 + 绝对定位强制居中：角色本体跨状态等大；宽姿态（眺望等）水平溢出
              // 由窗口左右对称裁掉（两臂各裁一点）。flex 居中对超宽子元素的溢出方向不可靠
              //（实锤单侧裁切），改用 left/top 50% + translate(-50%,-50%) 保证对称溢出
              const box = bb.box
              // 与 Live2D 同一基准：高度取常量而非当前容器高度，窗口变大不会放大立绘
              const s = FIT_REF_H / box.bh
              return (
                <div
                  ref={spriteContentRef}
                  className="absolute"
                  style={{ left: '50%', top: '50%', width: box.bw * s, height: box.bh * s, transform: 'translate(-50%, -50%)' }}
                >
                  <div className="relative h-full w-full" style={{ transform: view }}>
                    <img
                      {...imgProps}
                      className="select-none"
                      style={{
                        position: 'absolute',
                        left: -box.x * s,
                        top: -box.y * s,
                        width: box.w * s,
                        height: box.h * s,
                        maxWidth: 'none',
                        maxHeight: 'none',
                      }}
                    />
                  </div>
                </div>
              )
            }
            if (bb && bb.status === 'pending') {
              return null // 包围盒解析中：先不渲染，防"整画布尺寸 → 内容尺寸"跳变
            }
            // 解析失败（异常图/解码失败）→ 回退整画布 contain（旧行为）
            return (
              <img
                {...imgProps}
                className="max-h-full max-w-full select-none object-contain"
                style={{ transform: view }}
              />
            )
          })()}
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

      {/* 立绘模式失败提示：与 Live2D 横幅同款样式；立绘路径的失败原本完全静默（无日志/无横幅/无重试） */}
      {spriteNotice && mode === 'sprite' && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
          className="app-no-drag absolute inset-x-0 bottom-0 flex justify-center p-3"
        >
          <div className="flex w-[300px] items-start gap-3 rounded-[var(--radius-lg)] border border-[var(--border-strong)] bg-[var(--bg-panel)]/90 px-4 py-3 text-left shadow-[var(--shadow-card-hover)] backdrop-blur-xl">
            <IconTile icon={AlertTriangle} size="sm" gradient="accent" />
            <div className="min-w-0">
              <p className="text-xs leading-relaxed text-text">{spriteNotice}</p>
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
 * 滚轮缩放：只改「倍率」，实际缩放 = 基准 × 倍率。
 * 之前是在 model.scale 上连乘，任何一次 fitModel/外部重置都会让基准漂掉，
 * 表现为"越滚越大、滚回去没反应"。
 */
function applyZoomFactor(model: Live2DModel | null, baseScale: number, factor: number): { scale: number; factor: number } {
  const nextFactor = Math.min(4, Math.max(0.25, factor))
  if (!model) return { scale: baseScale * nextFactor, factor: nextFactor }
  const scale = baseScale * nextFactor
  model.scale.set(scale, scale)
  return { scale, factor: nextFactor }
}

// pixi-live2d-display 的动作优先级：None=0 / Idle=1 / Normal=2 / Force=3
const PRIORITY_IDLE = 1
const PRIORITY_FORCE = 3
/** "不应用动作"哨兵组名：指向一个不可能存在的组，使库的自动空闲续播（startRandomMotion）静默失效 */
const NO_IDLE_GROUP = '__idle_disabled__'

/**
 * 把模型全部参数复位为默认值（恢复标准姿势）。
 *
 * 动作硬停（stopAllMotions / FORCE 切换）后，已被动作写入的参数会停留在最后一帧的值
 * （手部/手臂/身体等定格），Cubism 没有自动归位机制，必须显式复位；
 * 眨眼/呼吸/表情/口型等每帧写入的参数系统不受一次性复位影响，物理随后自然稳定。
 * cubism4 coreModel 提供按索引的默认值 API；其他核心无此 API 时静默跳过。
 */
function resetModelParameters(model: Live2DModel | null): void {
  if (!model) return
  try {
    const core = (model as unknown as {
      internalModel?: {
        coreModel?: {
          getParameterCount?: () => number
          getParameterDefaultValue?: (index: number) => number
          setParameterValueByIndex?: (index: number, value: number) => void
        }
      }
    }).internalModel?.coreModel
    if (!core?.getParameterCount || !core.getParameterDefaultValue || !core.setParameterValueByIndex) return
    const count = core.getParameterCount()
    for (let i = 0; i < count; i++) {
      const fallback = core.getParameterDefaultValue(i)
      core.setParameterValueByIndex(i, typeof fallback === 'number' ? fallback : 0)
    }
  } catch {
    // 参数复位失败不阻塞（cubism2 等核心无此 API）
  }
}

function playTap(model: Live2DModel | null, idleAnimation?: string) {
  if (!model) return
  try {
    const groups = getMotionGroups(model)
    const tapGroup = ['TapBody', 'TapHead', 'Tap'].find((g) => groups.includes(g))
    if (tapGroup) {
      // index 传 undefined → 库内部 startRandomMotion（组内随机），不再固定第 0 个
      void model.motion(tapGroup, undefined, PRIORITY_FORCE)
      return
    }
    void playRandomIdle(model, idleAnimation)
  } catch {
    // 忽略动作播放失败
  }
}

/**
 * 播放空闲动作。
 *
 * 优先级死锁修复：空闲动作通常 Loop=true 永不结束，队列永远非空，库的
 * MotionState.currentPriority 恒为 1——此后一切 PRIORITY_IDLE(1) 请求都会被
 * MotionState.reserve 静默拒绝（拒绝日志为 verbose 级默认不可见）。因此：
 *  - interrupt=true（切换空闲动作组时）：用 PRIORITY_FORCE(3) 强制打断在播动作立即接管；
 *  - interrupt=false（10s 定时器兜底）：仅在当前无动作在播（isFinished）时才补播，不打断循环；
 *  - index 传 undefined → 库内部 startRandomMotion 组内随机，不再固定第 0 个；
 *  - motion() 返回 false（被拒/动作文件加载失败）时输出警告，补齐可观测性。
 *
 * 语义（与设置面板一致）：
 *  - preferredGroup 为空 = 不应用动作，直接不播；
 *  - 组名不存在 = 配置错误，警告后不播（不再回退随机播放）。
 *
 * @param preferredGroup 指定的空闲动作组；空串 = 不应用动作
 * @param interrupt 是否强制打断当前在播动作（切换动作组时置 true）
 */
async function playRandomIdle(model: Live2DModel | null, preferredGroup?: string, interrupt = false): Promise<void> {
  if (!model) return
  const target = preferredGroup?.trim()
  if (!target) return // 不应用动作：不播任何空闲动作
  try {
    const groups = getMotionGroups(model)
    if (!groups.includes(target)) {
      // 选中的动作组名与模型实际加载的动作组不匹配（常见于下拉框取自别的模型）时给出提示
      console.warn('[pet] 空闲动作组不存在于当前展示模型:', target, '实际可用:', groups)
      return
    }
    // 非打断模式：动作仍在播（如循环空闲动作）时跳过，避免把循环动作掐断重来
    const mgr = (model as unknown as {
      internalModel?: { motionManager?: { isFinished?: () => boolean; stopAllMotions?: () => void } }
    }).internalModel?.motionManager
    if (!interrupt && typeof mgr?.isFinished === 'function' && !mgr.isFinished()) return
    if (interrupt) mgr?.stopAllMotions?.()
    // 启动前复位全部参数：动作硬停/FORCE 切换后残留的最后帧值会被清除，
    // 新动作未驱动的参数回到标准姿势而不是定格（手部定格问题的根源）
    resetModelParameters(model)
    const started = await model.motion(target, undefined, interrupt ? PRIORITY_FORCE : PRIORITY_IDLE)
    if (!started) {
      // 常见于：该组唯一的动作正在播放（startRandomMotion 会排除 isActive 的动作），属预期
      console.log('[pet] 空闲动作未重复启动（该组动作可能正在播放中）:', target)
    }
  } catch (err) {
    console.warn('[pet] 播放空闲动作失败:', err instanceof Error ? err.message : err)
  }
}

/**
 * 顺序播放一组动作：await 每个动作的结束（pixi-live2d 的 motion() 在动作播完时 resolve），
 * 全部播完后再决定是否回到设置里的空闲动作。
 */
async function playTouchMotions(
  model: Live2DModel | null,
  groups: string[],
  restoreIdle: boolean,
  idleGroup?: string,
): Promise<void> {
  for (const g of groups) {
    await playRandomIdle(model, g, true)
    await waitMotionFinished(model)
  }
  if (!restoreIdle) return
  if (idleGroup && !groups.includes(idleGroup)) {
    await playRandomIdle(model, idleGroup, false)
    return
  }
  // 没有配置空闲动作时，动作会停在最后一帧（手/手臂等参数不回位）。
  // 这里显式停播 + 复位参数，让角色回到标准姿势。
  const mgr = (model as unknown as {
    internalModel?: { motionManager?: { stopAllMotions?: () => void } }
  })?.internalModel?.motionManager
  mgr?.stopAllMotions?.()
  resetModelParameters(model)
}

/**
 * 等当前动作播完。
 * 注意：库的 `model.motion()` 在动作**开始**时就 resolve（返回 true），不是结束时，
 * 所以不能用 await 来串动作，只能轮询 motionManager.isFinished()。
 */
function waitMotionFinished(model: Live2DModel | null, timeoutMs = 20000): Promise<void> {
  return new Promise((resolve) => {
    if (!model) {
      resolve()
      return
    }
    const mgr = (model as unknown as {
      internalModel?: { motionManager?: { isFinished?: () => boolean } }
    }).internalModel?.motionManager
    if (!mgr?.isFinished) {
      resolve()
      return
    }
    const started = performance.now()
    // 起播需要一两帧才进队列，先等一小段再开始判定，避免"还没开始就判定已结束"
    setTimeout(() => {
      const tick = () => {
        const done = mgr.isFinished?.() ?? true
        if (done) resolve()
        else if (performance.now() - started > timeoutMs) resolve()
        else requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    }, 150)
  })
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
  /** CubismModel 内部数据（用于枚举参数 id/量程，以及按部件聚合包围盒） */
  _model?: {
    parameters?: {
      ids?: readonly string[]
      minimumValues?: ArrayLike<number>
      maximumValues?: ArrayLike<number>
      defaultValues?: ArrayLike<number>
    }
    parts?: { ids?: readonly string[] }
    drawables?: { ids?: readonly string[]; parentPartIndices?: ArrayLike<number> }
  }
  getDrawableCount?: () => number
  getDrawableVertexPositions?: (i: number) => Float32Array | undefined
}

// ---------------- VTS/VBridger 型模型的「控制器参数」镜像 ----------------

/**
 * 一部分 Live2D 模型是给 VTube Studio 直播用的（目录里带 .vtube.json / .vbridger），
 * 作者把标准 Cubism 参数接到了另一组「控制器参数」上：面捕角度写入的是
 * AngleX/AngleY/AngleZ 与 PositionX/Y/Z，而不是 ParamAngleX/ParamAngleY/ParamAngleZ。
 * 证据来自模型自带的 .vtube.json → ParameterSettings：
 *   FaceAngleX → AngleX 与 PositionX、FaceAngleY → AngleY/PositionY、FaceAngleZ → AngleZ/PositionZ
 *   JawOpen → JawOpen、CheekPuff → CheeckPuff（模型里确实拼成 CheeckPuff）、MouthSmile → EyeSmile
 * 物理（physics3.json）与变形器也基本挂在这组参数上。
 *
 * 只写标准参数时这些控制器恒为 0 → 头不转、身体不摆、130+ 组物理全都没输入，
 * 模型看上去就是「僵住」。这里按存在性做一次镜像：只有模型真的声明了目标 id 才写，
 * 因此对普通 Live2D 模型（如阿库露、原版大肥鱼）完全无副作用。
 */
const RIG_PARAM_ALIASES: ReadonlyArray<{
  from: string
  to: readonly string[]
  /** 自发摆动（幅度=角度，freq=rad/s，phase=相位）——只加在角度类上，位置类跟随 */
  sway?: { amp: number; freq: number; phase: number }
}> = [
  { from: 'ParamAngleX', to: ['AngleX', 'PositionX'], sway: { amp: 0.8, freq: 0.70, phase: 0.0 } },
  { from: 'ParamAngleY', to: ['AngleY', 'PositionY'], sway: { amp: 1.1, freq: 0.90, phase: 1.7 } },
  { from: 'ParamAngleZ', to: ['AngleZ', 'PositionZ'], sway: { amp: 1.3, freq: 0.55, phase: 0.6 } },
  { from: 'ParamMouthOpenY', to: ['JawOpen'] },
  { from: 'ParamCheek', to: ['CheeckPuff'] },
  { from: 'ParamEyeSmile', to: ['EyeSmile'] },
]

/**
 * 采集当前模型的能力表：core 参数表（存在性 + 真实量程）+ model3.json（眨眼/口型组）
 * + physics3.json（哪些参数是物理输出、其驱动输入是谁）。
 *
 * 为什么要现场采集而不是写死：参数归谁管完全由模型决定——
 * 大肥鱼把 ParamAngleX 当成物理输出（输入是 AngleX），阿库露的 ParamAngleX 则是普通参数。
 * 读不到 model3/physics（自定义协议异常）时退化为「只有参数表」，UI 仍能正确隐藏不存在的滑杆。
 */
async function collectModelProfile(
  modelId: string,
  model3Url: string,
  internal: {
    coreModel?: CoreModelLike
    pixelsPerUnit?: number
    originalWidth?: number
    originalHeight?: number
  },
): Promise<ModelProfile | null> {
  const core = internal.coreModel
  if (!core) return null
  const table = core._model?.parameters
  const ids = table?.ids
  if (!ids || ids.length === 0 || !table.minimumValues || !table.maximumValues || !table.defaultValues) {
    return null
  }
  let model3: {
    Groups?: Array<{ Name?: string; Ids?: string[] }>
    FileReferences?: { Physics?: string; DisplayInfo?: string }
  } | null = null
  let physics: unknown = null
  let partNames: Record<string, string> = {}
  try {
    const res = await fetch(model3Url)
    if (res.ok) model3 = await res.json()
    const cdiFile = model3?.FileReferences?.DisplayInfo
    if (cdiFile) {
      const baseDir = model3Url.slice(0, model3Url.lastIndexOf('/') + 1)
      const cres = await fetch(baseDir + encodeURI(cdiFile))
      if (cres.ok) {
        const cdi = (await cres.json()) as { Parts?: Array<{ Id?: string; Name?: string }> }
        for (const part of cdi.Parts ?? []) {
          if (part?.Id) partNames[part.Id] = part.Name ?? part.Id
        }
      }
    }
    const physicsFile = model3?.FileReferences?.Physics
    if (physicsFile) {
      const baseDir = model3Url.slice(0, model3Url.lastIndexOf('/') + 1)
      const pres = await fetch(baseDir + encodeURI(physicsFile))
      if (pres.ok) physics = await pres.json()
    }
  } catch (err) {
    console.warn('[pet] 读取模型 json 失败（能力表退化为仅参数表）:', err instanceof Error ? err.message : err)
  }
  const profile = buildModelProfile({
    modelId,
    paramIds: ids,
    minimumValues: table.minimumValues,
    maximumValues: table.maximumValues,
    defaultValues: table.defaultValues,
    model3,
    physics: physics as Parameters<typeof buildModelProfile>[0]['physics'],
  })

  // 自动识别触摸命中区：把 drawable 顶点按 parentPart 聚合 → 归一化到角色包围盒
  try {
    const ppu = internal.pixelsPerUnit || 1
    const ow = internal.originalWidth || 0
    const oh = internal.originalHeight || 0
    const count = core.getDrawableCount?.() ?? 0
    const parent = core._model?.drawables?.parentPartIndices
    const partIds = core._model?.parts?.ids ?? []
    if (count > 0 && ow > 0 && oh > 0) {
      const perPart = new Map<number, { x0: number; y0: number; x1: number; y1: number }>()
      let gx0 = Infinity
      let gy0 = Infinity
      let gx1 = -Infinity
      let gy1 = -Infinity
      for (let i = 0; i < count; i++) {
        const v = core.getDrawableVertexPositions?.(i)
        if (!v || v.length < 2) continue
        let x0 = Infinity
        let y0 = Infinity
        let x1 = -Infinity
        let y1 = -Infinity
        for (let k = 0; k < v.length; k += 2) {
          const px = (v[k] ?? 0) * ppu + ow / 2
          const py = -(v[k + 1] ?? 0) * ppu + oh / 2
          if (px < x0) x0 = px
          if (px > x1) x1 = px
          if (py < y0) y0 = py
          if (py > y1) y1 = py
        }
        if (!Number.isFinite(x0) || !Number.isFinite(y0)) continue
        gx0 = Math.min(gx0, x0)
        gy0 = Math.min(gy0, y0)
        gx1 = Math.max(gx1, x1)
        gy1 = Math.max(gy1, y1)
        const pi = parent?.[i] ?? -1
        if (pi < 0) continue
        const cur = perPart.get(pi)
        if (cur) {
          cur.x0 = Math.min(cur.x0, x0)
          cur.y0 = Math.min(cur.y0, y0)
          cur.x1 = Math.max(cur.x1, x1)
          cur.y1 = Math.max(cur.y1, y1)
        } else {
          perPart.set(pi, { x0, y0, x1, y1 })
        }
      }
      const gw = gx1 - gx0
      const gh = gy1 - gy0
      if (gw > 0 && gh > 0) {
        const parts = []
        for (const [pi, b] of perPart) {
          const id = partIds[pi]
          if (!id) continue
          parts.push({
            id,
            name: partNames[id] ?? id,
            x: (b.x0 - gx0) / gw,
            y: (b.y0 - gy0) / gh,
            w: (b.x1 - b.x0) / gw,
            h: (b.y1 - b.y0) / gh,
          })
        }
        profile.regions = buildTouchRegionsFromParts(parts)
        profile.parts = parts
      }
    }
  } catch (err) {
    console.warn('[pet] 触摸命中区识别失败（可稍后手动画）:', err instanceof Error ? err.message : err)
  }
  return profile
}

/** 每个 core 模型解析一次的别名表缓存（null = 该模型不是控制器型，无需镜像） */
const rigAliasCache = new WeakMap<object, Map<string, string[]> | null>()

/**
 * 解析当前模型实际存在的控制器参数。
 * @returns from → 实际存在的目标 id 列表；模型不带控制器参数时返回 null
 */
function resolveRigAliases(core: CoreModelLike): Map<string, string[]> | null {
  const cached = rigAliasCache.get(core as object)
  if (cached !== undefined) return cached
  const ids = core._model?.parameters?.ids
  if (!ids || ids.length === 0) return null // 拿不到参数表：不缓存，下一帧再试
  const all = new Set(ids)
  const map = new Map<string, string[]>()
  for (const alias of RIG_PARAM_ALIASES) {
    const hit = alias.to.filter((id) => all.has(id))
    if (hit.length > 0) map.set(alias.from, hit)
  }
  const result = map.size > 0 ? map : null
  rigAliasCache.set(core as object, result)
  if (result) {
    console.log(
      '[pet] 检测到控制器参数（VTS/VBridger 型模型），已启用参数镜像:',
      [...map.keys()].join(', '),
    )
  }
  return result
}

/**
 * 把标准参数镜像到控制器参数（每帧最后调用，读回本帧最终值）。
 *
 * 顺带叠加一点极轻微的自发摆动：这类模型的待机动作往往是「静态重置姿势」
 * （例如大肥鱼的 脱捕.motion3.json 只有一个关键帧），不叠自摆就完全没有动画，
 * 而物理要靠角度输入才会飘。幅度只有 1° 上下，不会盖过用户设置的姿势。
 */
function mirrorRigParameters(core: CoreModelLike, profile?: ModelProfile | null): void {
  const map = resolveRigAliases(core)
  if (!map || !core.setParameterValueById) return
  const t = performance.now() / 1000
  for (const alias of RIG_PARAM_ALIASES) {
    const targets = map.get(alias.from)
    if (!targets) continue
    // ③ 该标准参数已经是物理输出、且能反推出驱动时，姿态会直接写驱动；
    //    镜像再拿旧的标准参数值回写，等于把用户设置盖掉，所以跳过。
    if (profile?.drivers?.[alias.from]) continue
    const base = core.getParameterValueById?.(alias.from) ?? 0
    const s = alias.sway
    const value = s ? base + s.amp * Math.sin(t * s.freq + s.phase) : base
    for (const id of targets) core.setParameterValueById(id, value)
  }
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

/**
 * 控制器型模型的自发摆动（约 1°）。
 * 这类模型的物理每帧重算标准参数，不自摆就是完全静止；只在"写驱动参数"时叠加。
 */
function rigSway(id: string, t: number): number {
  if (id === 'ParamAngleX') return 0.8 * Math.sin(t * 0.7)
  if (id === 'ParamAngleY') return 1.1 * Math.sin(t * 0.9 + 1.7)
  if (id === 'ParamAngleZ') return 1.3 * Math.sin(t * 0.55 + 0.6)
  return 0
}

/**
 * 将用户设置的模型参数写入 Cubism Core（每帧调用，覆盖 SDK 动画的同名参数）。
 * 对应 airi 的 Model.vue 第 339-359 行参数映射。
 * 当 mouseTrackingActive=true 时跳过 angleX/angleY，让 model.focus() 的 focusController 控制头部旋转。
 */
function applyModelParameters(
  core: CoreModelLike,
  p: ModelParameters,
  mouseTrackingActive: boolean,
  profile?: ModelProfile | null,
): void {
  if (!core.setParameterValueById) return
  // ③ 物理输出的参数（例如大肥鱼的 ParamAngleX 由 AngleX 经物理驱动）必须写它的驱动参数，
  //    否则下一帧物理会把标准参数重算回去，滑杆等于没动。普通模型没有 drivers，行为不变。
  // 控制器型模型：写驱动时叠加一点自发摆动（幅度 1° 上下）。
  // 这类模型的物理会把标准参数每帧重算，若不自己摆，模型看上去是"完全静止"的。
  const now = performance.now() / 1000
  const set = (id: string, value: number) => {
    const target = writeTarget(profile, id)
    // 只有"改写驱动"的项才叠自摆：普通参数直接写自身，避免把用户设置改花
    core.setParameterValueById?.(target, target === id ? value : value + rigSway(id, now))
  }
  // Head Rotation（鼠标跟踪激活时跳过 X/Y，由 focusController 控制）
  if (!mouseTrackingActive) {
    set('ParamAngleX', p.angleX)
    set('ParamAngleY', p.angleY)
  }
  set('ParamAngleZ', p.angleZ)
  // Eyes（注意：ParamEyeBallX/Y 不在此处设置，由鼠标跟踪/空闲眼神控制）
  set('ParamEyeLOpen', p.leftEyeOpen)
  set('ParamEyeROpen', p.rightEyeOpen)
  set('ParamEyeSmile', p.leftEyeSmile)
  // Eyebrows
  set('ParamBrowLX', p.leftEyebrowLR)
  set('ParamBrowRX', p.rightEyebrowLR)
  set('ParamBrowLY', p.leftEyebrowY)
  set('ParamBrowRY', p.rightEyebrowY)
  set('ParamBrowLAngle', p.leftEyebrowAngle)
  set('ParamBrowRAngle', p.rightEyebrowAngle)
  set('ParamBrowLForm', p.leftEyebrowForm)
  set('ParamBrowRForm', p.rightEyebrowForm)
  // Mouth
  set('ParamMouthOpenY', p.mouthOpen)
  set('ParamMouthForm', p.mouthForm)
  // Face
  set('ParamCheek', p.cheek)
  // Body
  set('ParamBodyAngleX', p.bodyAngleX)
  set('ParamBodyAngleY', p.bodyAngleY)
  set('ParamBodyAngleZ', p.bodyAngleZ)
  // Breath
  set('ParamBreath', p.breath)
}

// ---------------- 表情参数应用 ----------------

/**
 * 将 exp3.json 的表情参数应用到 Cubism Core（每帧调用，P2b lerp 渐变版）。
 * 参考 airi 的 expression-tools.ts：自行实现三种混合模式，不依赖 SDK 的 ExpressionManager。
 *
 * 渐变机制（替代 airi 忽略 FadeInTime 的做法）：
 * - currentMap 记录每个表情参数的当前显示值，跨帧向目标值插值（alpha 按帧间隔折算，FPS 无关）
 * - baseMap 记录参数基线（首次遇到该参数时的 coreModel 值）：渐入起点 / 渐出终点 / Add·Multiply 叠加基准
 * - 切换表情：新参数从基线渐入；被移出的参数向基线渐出，收敛后从 map 清理（防残留）
 * - 目标输出统一折算为「绝对参数值」再插值：Overwrite = p.Value；Add = 基线 + p.Value；Multiply = 基线 × p.Value，
 *   写回一律 setParameterValueById——混合模式语义在目标计算中体现，插值对所有模式统一
 * - |目标 - 当前| < 0.1 视为收敛，直接取目标值并停止漂移
 */
function applyExpression(
  core: CoreModelLike,
  params: ExpressionParameter[],
  currentMap: Map<string, number>,
  baseMap: Map<string, number>,
  alpha: number,
): void {
  const seen = new Set<string>()
  // 1. 目标表情内的参数：渐入或保持
  for (const p of params) {
    seen.add(p.Id)
    let base = baseMap.get(p.Id)
    if (base === undefined) {
      base = core.getParameterValueById?.(p.Id) ?? 0
      baseMap.set(p.Id, base)
    }
    let target: number
    switch (p.Blend) {
      case 'Add':
        target = base + p.Value
        break
      case 'Multiply':
        target = base * p.Value
        break
      default:
        target = p.Value // Overwrite（及缺省）
    }
    const cur = currentMap.get(p.Id) ?? base
    const next = Math.abs(target - cur) < 0.1 ? target : cur + (target - cur) * alpha
    currentMap.set(p.Id, next)
    core.setParameterValueById?.(p.Id, next)
  }
  // 2. 已不在目标表情中的参数：向基线渐出，收敛后清理（防残留）
  for (const [id, cur] of [...currentMap]) {
    if (seen.has(id)) continue
    const base = baseMap.get(id) ?? 0
    const next = Math.abs(base - cur) < 0.1 ? base : cur + (base - cur) * alpha
    if (next === base) {
      currentMap.delete(id)
      baseMap.delete(id)
    } else {
      currentMap.set(id, next)
    }
    core.setParameterValueById?.(id, next)
  }
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
  profile?: ModelProfile | null,
  params?: ModelParameters,
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

  const t = performance.now() / 1000
  // 头部旋转跟随（ParamAngleX/Y 范围 -30~30）；物理输出型模型要写到驱动参数上才有效
  core.setParameterValueById?.(writeTarget(profile, 'ParamAngleX'), focus.x * 30 + rigSway('ParamAngleX', t))
  core.setParameterValueById?.(writeTarget(profile, 'ParamAngleY'), -focus.y * 30 + rigSway('ParamAngleY', t))

  // 身体跟随：VTS 型模型的身体角度由独立控制器（如 PositionX）驱动，
  // 只写头部不会带动身体。不补这一下，鼠标跟踪时就只有一颗头在转，身体像钉住一样僵
  // ——这正是「开启鼠标跟踪后身体变僵硬」的直接原因。
  const bodyX = writeTarget(profile, 'ParamBodyAngleX')
  const headTargets = new Set([
    'ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamBodyAngleX',
    writeTarget(profile, 'ParamAngleX'),
    writeTarget(profile, 'ParamAngleY'),
  ])
  if (!headTargets.has(bodyX)) {
    core.setParameterValueById?.(bodyX, (params?.bodyAngleX ?? 0) + focus.x * 30 + rigSway('ParamAngleX', t))
  }
}
