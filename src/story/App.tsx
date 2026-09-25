/**
 * 剧情演出窗（galgame 式）：背景（剧本素材 / 背景库 user: 引用）+ 2D 立绘（可调整大小/位置）+ 底部合并对话框（LingChat 式）。
 *
 * 数据流（与聊天系统完全分离）：
 *  - 演出驱动：run 消息增量同步（story:message 广播 → 剧情窗按已演游标从 run.messages 补演），
 *    窗口打开晚于事件广播也不会丢段；story:event 仅驱动背景/BGM；
 *  - 节奏：所有段落（含同一回答的各分段）默认点击推进，自动模式按文本长度定时衔接；
 *    语音播放中点击 = 跳过当前段语音；引擎连续入史的新段只入队，绝不抢占正在播放的段；
 *  - 语音：剧情窗独立本地 Genie TTS（run.voice 配置），合成在主进程、播放在本窗；
 *  - 立绘：thinkingImage（AI 等待期）> emotionMap[emotion] > speakingImage；大小/位置可调（随 run 存档）；
 *  - backlog：run.messages 全量回看（剧情记录唯一查看入口）。
 * 引擎在主进程：关闭本窗不中断演出；点「退出」= 存档并直接关闭本窗。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { History, Settings2, X } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '../api'
import { WindowTitlebar } from '../components/WindowTitlebar'
import { initSettingsSync, useSettingsStore, typingSpeedToMs } from '../store/settingsStore'
import type {
  CharacterSprite,
  ChatMessage,
  StandardEmotion,
  StorySnapshot,
  StorySpriteView,
  StoryTtsResult,
} from '../types'
import { cn } from '../lib/utils'

/** 情绪中文名（对话框情绪标签） */
const EMOTION_LABEL: Record<StandardEmotion, string> = {
  neutral: '平静',
  happy: '开心',
  sad: '难过',
  angry: '生气',
  surprised: '惊讶',
  shy: '害羞',
}

/** 纯括号文本（整体只由 （…） 动作/心理描写构成）：按演出规范属于"不发声"内容，
 *  渲染为旁白样式、不挂角色名牌、不配音——剧本/AI 偶尔把独白写进 dialogue 时不再误挂角色名 */
function isUnspoken(text: string): boolean {
  return /^(?:\s*[（(][^（）]*[）)])+\s*[。.…！!？?]*\s*$/.test(text)
}

/** 演出队列项 */
interface QueueItem {
  kind: 'narration' | 'line'
  text: string
  emotion?: StandardEmotion
  /** line：说话人（player = 玩家台词不配音；ai = 角色台词） */
  speaker?: 'player' | 'ai'
  /** 是否用 TTS 播报（启用语音且为角色台词时 true） */
  voice?: boolean
}

type Phase = 'idle' | 'typing' | 'voice' | 'wait'

const DEFAULT_SPRITE_VIEW: StorySpriteView = { scale: 1, x: 0, y: 0 }
/** 文字速度档缺省值（与 settingsStore DEFAULT_SETTINGS.textSpeed 一致） */
const DEFAULT_TEXT_SPEED = 80

export function StoryApp() {
  // 文字显示速度：与聊天窗/桌宠共用同一全局设置（可在设置页「剧情系统」调整）
  const textSpeed = useSettingsStore((s) => s.settings.textSpeed ?? DEFAULT_TEXT_SPEED)
  const typeDelayRef = useRef(typingSpeedToMs(textSpeed))
  useEffect(() => {
    typeDelayRef.current = typingSpeedToMs(textSpeed)
  }, [textSpeed])
  useEffect(() => initSettingsSync(), [])

  const [snapshot, setSnapshot] = useState<StorySnapshot | null>(null)
  const snapshotRef = useRef<StorySnapshot | null>(null)
  const [cardName, setCardName] = useState('AI')
  const [sprite, setSprite] = useState<CharacterSprite | null>(null)

  // ---- 演出队列与播放状态 ----
  const queueRef = useRef<QueueItem[]>([])
  /** 已入队显示的 run.messages 数量（增量补演游标） */
  const processedRef = useRef(0)
  /** 初次接入是否完成（onState 快照重建确定播放起点之前，消息广播的增量同步一律忽略） */
  const attachReadyRef = useRef(false)
  const [current, setCurrent] = useState<QueueItem | null>(null)
  const [typedText, setTypedText] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const phaseRef = useRef<Phase>('idle')
  const setPhaseBoth = (p: Phase) => {
    phaseRef.current = p
    setPhase(p)
  }
  const [autoMode, setAutoMode] = useState(false)
  const autoModeRef = useRef(false)
  useEffect(() => {
    autoModeRef.current = autoMode
  }, [autoMode])
  const [spriteEmotion, setSpriteEmotion] = useState<StandardEmotion>('neutral')

  // ---- 段级语音预取（7.7 性能第一批）：消息到达即按序发起合成，播放到段时音频多半已就绪，
  //      段间合成等待清零（Genie 主进程串行链天然排队）。key = ttsModelId|language|text ----
  // 注：流式预览（生成期间全文上屏）已移除——整块文本先冒出再收起重演的观感差于等待，
  //     生成期间以「思考中…」名牌 + 思考立绘表达；主进程广播保留，供后续逐段流式方案复用。
  const prefetchRef = useRef<Map<string, Promise<{ ok: boolean; audioBase64?: string }>>>(new Map())

  // ---- 背景与 BGM ----
  const [background, setBackground] = useState<string | null>(null)
  const [music, setMusic] = useState<string | null>(null)

  // ---- 立绘视图调整（本地即时生效，防抖持久化到 run） ----
  const [spriteView, setSpriteView] = useState<StorySpriteView>(DEFAULT_SPRITE_VIEW)
  const spriteViewSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [adjustOpen, setAdjustOpen] = useState(false)

  // ---- backlog / 输入 ----
  const [backlogOpen, setBacklogOpen] = useState(false)
  const [backlogMessages, setBacklogMessages] = useState<ChatMessage[]>([])
  const [inputText, setInputText] = useState('')

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const bgmRef = useRef<HTMLAudioElement | null>(null)
  /** 当前语音段停止器（点击跳过语音用） */
  const voiceStopRef = useRef<(() => void) | null>(null)
  const playTokenRef = useRef(0)
  const skipTypingRef = useRef(false)

  const resetPlayback = useCallback(() => {
    queueRef.current = []
    processedRef.current = 0
    playTokenRef.current++
    skipTypingRef.current = false
    playingRef.current = false
    setCurrent(null)
    setTypedText('')
    setPhaseBoth('idle')
    voiceStopRef.current?.()
    voiceStopRef.current = null
    prefetchRef.current.clear()
  }, [])

  /** 把一条 run 消息转换为演出队列项。
   *  - 导演指令（引擎内部引导）与玩家输入/选项文本（choice/free）不占对话框，只入 backlog；
   *  - 空文本段跳过（防止模型输出空 dialogue 项导致"AI 没说话"的假象）；
   *  - AI 回复分段优先级：chunks（模型 dialogue 逐项）> content 换行段落 > 整段单条——
   *    结构化解析失败或失败轮次的部分回复会整段落盘（chunks 缺失/折叠成单条），
   *    此时按自然段落再分段，避免"一次全部输出到对话框"；
   *  - 纯括号段（独白/动作描写）渲染为旁白样式，不挂角色名牌、不配音。 */
  const messageToItems = useCallback((m: ChatMessage): QueueItem[] => {
    if (m.role === 'user') {
      if (m.content.startsWith('（剧情演出：')) return []
      if (m.meta?.storyKind === 'choice' || m.meta?.storyKind === 'free') return []
      if (m.meta?.storyKind === 'narration') {
        return m.content.trim() ? [{ kind: 'narration', text: m.content }] : []
      }
      // player：剧本编排的玩家独白，对话框呈现
      return m.content.trim() ? [{ kind: 'line', text: m.content, speaker: 'player' }] : []
    }
    const spoken = (text: string, emotion?: StandardEmotion): QueueItem => ({
      kind: 'line', text, emotion, speaker: 'ai', voice: true,
    })
    const chunks = (m.chunks ?? []).filter((c) => typeof c.text === 'string' && c.text.trim())
    if (chunks.length > 1) {
      return chunks.map((c) => (isUnspoken(c.text) ? { kind: 'narration', text: c.text } : spoken(c.text, c.emotion)))
    }
    const paragraphs = m.content.split(/\n+/).map((t) => t.trim()).filter(Boolean)
    if (paragraphs.length > 1) {
      const emotion = m.emotion ?? 'neutral'
      return paragraphs.map((text) => (isUnspoken(text) ? { kind: 'narration', text } : spoken(text, emotion)))
    }
    if (chunks.length === 1) {
      const c = chunks[0]!
      return [isUnspoken(c.text) ? { kind: 'narration', text: c.text } : spoken(c.text, c.emotion)]
    }
    return paragraphs.length === 1
      ? [isUnspoken(paragraphs[0]!) ? { kind: 'narration', text: paragraphs[0]! } : spoken(paragraphs[0]!, m.emotion ?? 'neutral')]
      : []
  }, [])

  /**
   * 消息增量同步：把 run.messages 中未演的消息入队（打开晚/重开都不丢段）。
   * 两条纪律（修复"上一段没演完下一段就抢屏"）：
   *  1. 演出进行中（打字/语音/等待点击）绝不抢占——新消息只入队，由点击/自动模式接管推进；
   *  2. 初次接入完成（attachReadyRef）前不入队——run 切换的 onState 处理器负责确定起点，
   *     避免消息广播与快照重建竞态导致全文重播/重复入队。
   */
  const syncFromRun = useCallback(async (runId: string) => {
    if (!attachReadyRef.current || snapshotRef.current?.runId !== runId) return
    try {
      const run = await api.story.getRun(runId)
      if (!run) return
      setBacklogMessages(run.messages)
      const fresh = run.messages.slice(processedRef.current)
      processedRef.current = run.messages.length
      const voice = snapshotRef.current?.voice ?? null
      for (const m of fresh) {
        const items = messageToItems(m)
        queueRef.current.push(...items)
        // 段级预合成（7.7 性能第一批）：消息到达即按序发起合成（不 await，Genie 串行链排队），
        // 播放到该段时音频多半已就绪，段间合成等待清零；播放端取不到缓存时仍现场合成兜底
        if (voice) {
          for (const it of items) {
            if (it.kind === 'line' && it.voice && it.speaker === 'ai' && it.text.trim()) {
              const key = `${voice.ttsModelId}|${voice.language}|${it.text}`
              if (!prefetchRef.current.has(key)) {
                prefetchRef.current.set(
                  key,
                  api.story.synthesize({ ttsModelId: voice.ttsModelId, language: voice.language, text: it.text }).catch(() => ({ ok: false }) as StoryTtsResult),
                )
              }
            }
          }
        }
      }
      // 仅在空闲时启动播放：正在播放的段落不被新入队内容打断
      if (fresh.length > 0 && queueRef.current.length > 0 && phaseRef.current === 'idle') processQueueRef.current?.('sync')
    } catch {
      // 忽略
    }
  }, [messageToItems])

  // ---- 播放器 ----

  /** 打字机：逐字上屏（点击可瞬间完成）；速度跟随全局「文字显示速度」设置 */
  const typeOut = useCallback((text: string, token: number): Promise<void> => {
    return new Promise((resolve) => {
      let i = 0
      skipTypingRef.current = false
      const timer = setInterval(() => {
        if (token !== playTokenRef.current) {
          clearInterval(timer)
          resolve()
          return
        }
        i = skipTypingRef.current ? text.length : Math.min(text.length, i + 1)
        setTypedText(text.slice(0, i))
        if (i >= text.length) {
          clearInterval(timer)
          resolve()
        }
      }, typeDelayRef.current)
    })
  }, [])

  /** 启动 WAV 播放。ended 在播放结束/令牌失效时 resolve(true)，被点击暂停时 resolve(false) */
  const startWav = useCallback((base64: string, token: number): { ended: Promise<boolean>; stop: () => void } => {
    const audio = audioRef.current
    if (!audio) {
      return { ended: Promise.resolve(true), stop: () => undefined }
    }
    audio.src = `data:audio/wav;base64,${base64}`
    let done = false
    let finish!: (played: boolean) => void
    const ended = new Promise<boolean>((resolve) => {
      finish = resolve
    })
    const cleanup = () => {
      clearInterval(poll)
      audio.removeEventListener('ended', onEnded)
      audio.removeEventListener('playing', onPlaying)
    }
    const onEnded = () => {
      if (!done) {
        done = true
        cleanup()
        finish(true)
      }
    }
    // 播放真正开始后才轮询 paused（避免 play() 尚未起播就被误判为"点击跳过"）
    const onPlaying = () => {
      poll = setInterval(() => {
        if (token !== playTokenRef.current) {
          if (!done) {
            done = true
            cleanup()
            finish(true)
          }
          return
        }
        if (audio.paused) {
          if (!done) {
            done = true
            cleanup()
            finish(false)
          }
        }
      }, 80)
    }
    let poll: ReturnType<typeof setInterval>
    audio.addEventListener('playing', onPlaying)
    audio.addEventListener('ended', onEnded)
    void audio.play().catch(() => {
      if (!done) {
        done = true
        cleanup()
        finish(true)
      }
    })
    return {
      ended,
      stop: () => {
        try {
          audio.pause()
        } catch {
          /* ignore */
        }
      },
    }
  }, [])

  const processQueueRef = useRef<((source?: string) => void) | null>(null)
  /** 段播放互斥（修复闪现）：一段从起播到结束期间拒绝任何重入推进，
   *  杜绝「消息到达 / 点击 / 自动定时 / 跳过」多入口同时起播两条播放链导致 setCurrent 互相覆盖。
   *  跳过路径先显式释放互斥（旧链已被令牌判死）再推进。 */
  const playingRef = useRef(false)

  const scheduleAuto = useCallback((it: QueueItem, token: number) => {
    if (!autoModeRef.current) return
    const ms = 900 + it.text.length * 55
    setTimeout(() => {
      if (token === playTokenRef.current && phaseRef.current === 'wait') processQueueRef.current?.('auto')
    }, ms)
  }, [])

  const processQueue = useCallback((source = 'unknown') => {
    if (playingRef.current) {
      // 诊断日志：两个推进入口撞车时在这里暴露（闪现问题的定位器）
      console.warn('[story] 队列推进被拒绝（段落播放中）: src=%s', source)
      return
    }
    const token = playTokenRef.current
    const item = queueRef.current.shift()
    if (!item) {
      setCurrent(null)
      setTypedText('')
      setPhaseBoth('idle')
      return
    }
    playingRef.current = true
    console.log('[story] 播放段落 src=%s token=%d kind=%s emotion=%s text=%s…', source, token, item.kind, item.emotion ?? '-', item.text.slice(0, 12))
    setCurrent(item)
    setTypedText('')
    if (item.kind === 'line' && item.emotion) setSpriteEmotion(item.emotion)

    const run = async () => {
      try {
        const snap = snapshotRef.current
        const voiced = item.kind === 'line' && item.voice && item.speaker === 'ai' && !!snap?.voice
        if (voiced) {
          // 有语音：先合成，语音出声瞬间文字才同步逐字显示（文本不先于语音出现）。
          // 优先取预取缓存（7.7）：消息到达时已按序发起合成，此处多为已就绪的 promise；
          // 合成失败/纯括号段静默降级为纯文本（不弹 toast，主进程终端有日志）
          setPhaseBoth('voice')
          try {
            const key = `${snap!.voice!.ttsModelId}|${snap!.voice!.language}|${item.text}`
            let p = prefetchRef.current.get(key)
            if (!p) {
              p = api.story.synthesize({ ttsModelId: snap!.voice!.ttsModelId, language: snap!.voice!.language, text: item.text }).catch(() => ({ ok: false }) as StoryTtsResult)
              prefetchRef.current.set(key, p)
            }
            const res = await p
            prefetchRef.current.delete(key)
            if (token !== playTokenRef.current) return
            if (res.ok && res.audioBase64) {
              const { ended, stop } = startWav(res.audioBase64, token)
              voiceStopRef.current = stop
              await typeOut(item.text, token) // 与语音同步打字
              if (token !== playTokenRef.current) return // 播放期间被跳过：点击处已推进
              const played = await ended
              voiceStopRef.current = null
              if (token !== playTokenRef.current) return
              if (!played) return // 被点击跳过：点击处已触发下一段
              // 语音播完 ≠ 自动跳段：同一回答的各分段也必须点击推进（自动模式按文本长度定时衔接）
              playingRef.current = false
              setPhaseBoth('wait')
              scheduleAuto(item, token)
              return
            }
          } catch {
            if (token !== playTokenRef.current) return
          }
        }
        // 无语音（或合成失败兜底）：打字完成后等待点击/自动定时（绝不自动跳段）
        setPhaseBoth('typing')
        await typeOut(item.text, token)
        if (token !== playTokenRef.current) return
        playingRef.current = false
        setPhaseBoth('wait')
        scheduleAuto(item, token)
      } finally {
        // 兜底释放：仅当本链令牌仍是当前令牌（被跳过的旧链不得误释放新链的互斥）
        if (token === playTokenRef.current) playingRef.current = false
      }
    }
    void run()
  }, [typeOut, startWav, scheduleAuto])

  processQueueRef.current = processQueue

  /** 舞台点击推进（对话框文本区） */
  const onTextClick = useCallback(() => {
    if (phaseRef.current === 'typing') {
      skipTypingRef.current = true
      return
    }
    if (phaseRef.current === 'voice') {
      // 跳过当前段（合成中或播放中）：令牌失效丢弃旧链，显式释放互斥后立即推进下一段
      playTokenRef.current++
      playingRef.current = false
      voiceStopRef.current?.()
      voiceStopRef.current = null
      processQueueRef.current?.('skip')
      return
    }
    if (phaseRef.current === 'wait') {
      processQueueRef.current?.('click')
    }
  }, [])

  // ---- 订阅（挂载一次；回调经 ref 读最新状态） ----
  const remoteViewRef = useRef<StorySpriteView>(DEFAULT_SPRITE_VIEW)
  useEffect(() => {
    api.story.reportRendererReady()
    const unsubs = [
      api.story.onState((s) => {
        const prev = snapshotRef.current
        snapshotRef.current = s
        setSnapshot(s)
        if (prev && prev.runId === s.runId) {
          // 同一 run：同步远端立绘视图（滑杆调整后的广播回环）
          if (s.spriteView && (s.spriteView.scale !== remoteViewRef.current.scale || s.spriteView.x !== remoteViewRef.current.x || s.spriteView.y !== remoteViewRef.current.y)) {
            remoteViewRef.current = s.spriteView
            setSpriteView(s.spriteView)
          }
          return
        }
        // run 切换/首次接入：重置播放，按快照与 run 存档重建（重建完成前忽略消息广播的增量同步）
        resetPlayback()
        attachReadyRef.current = false
        remoteViewRef.current = s.spriteView ?? DEFAULT_SPRITE_VIEW
        setSpriteView(s.spriteView ?? DEFAULT_SPRITE_VIEW)
        setBackground(s.background)
        setMusic(s.music)
        setSpriteEmotion('neutral')
        setAdjustOpen(false)
        void (async () => {
          const cards = await api.characterCard.list()
          setCardName(cards.find((c) => c.id === s.cardId)?.name ?? 'AI')
          const sprites = await api.sprite.list()
          setSprite(sprites.find((sp) => sp.id === s.spriteId) ?? null)
          try {
            const run = await api.story.getRun(s.runId)
            if (!run) return
            setBacklogMessages(run.messages)
            if (s.mode === 'start') {
              // 刚开始的新 run：从第一条消息完整播放。
              // 复用 syncFromRun 同一入队口径（processedRef 已被消息广播推进时不重复入队，避免竞态重复）
              attachReadyRef.current = true
              await syncFromRun(s.runId)
            } else {
              // 中途接入/重开：只把最后一条消息作为当前句展示（不重播全文）；
              // max 防护：若消息广播抢先推进了游标，不回退（否则最后一条会被重复演出）
              processedRef.current = Math.max(processedRef.current, run.messages.length - 1)
              attachReadyRef.current = true
              if (run.messages.length > 0) {
                const items = messageToItems(run.messages[run.messages.length - 1]!)
                if (items.length > 0) {
                  const last = { ...items[items.length - 1]!, voice: false }
                  setCurrent(last)
                  setTypedText(last.text)
                  if (last.emotion) setSpriteEmotion(last.emotion)
                  setPhaseBoth('wait')
                }
              }
            }
          } catch { /* ignore */ }
        })()
      }),
      api.story.onEvent(({ runId, event }) => {
        if (snapshotRef.current?.runId !== runId) return
        // 背景/BGM 为事件驱动；叙事类（narration/player/dialogue）由 run 消息增量同步驱动，此处不处理
        if (event.type === 'background') setBackground(event.image)
        else if (event.type === 'music') setMusic(event.stop ? null : (event.file ?? null))
      }),
      api.story.onMessageSync(({ runId }) => {
        void syncFromRun(runId)
      }),
      api.ai.onStreamDone((payload) => {
        // 兜底：message 广播若早于订阅建立，stream-done 也可触发增量同步
        void syncFromRun(payload.sessionId)
      }),
    ]
    return () => unsubs.forEach((u) => u())
  }, [resetPlayback, syncFromRun, messageToItems])

  // ---- 背景解析（剧本素材相对路径 / user: 背景库引用；素材缺失时保持当前背景） ----
  const backgroundUrl = background && snapshot ? api.story.assetUrl(snapshot.scriptId, background) : null

  useEffect(() => {
    const audio = bgmRef.current
    if (!audio) return
    const url = music && snapshot?.scriptId ? api.story.assetUrl(snapshot.scriptId, music) : null
    if (url) {
      if (audio.src !== url) audio.src = url
      audio.loop = true
      void audio.play().catch(() => { /* 自动播放被拦截时由交互后恢复 */ })
    } else {
      audio.pause()
      audio.src = ''
    }
  }, [music, snapshot?.scriptId])

  // ---- 立绘视图滑杆（本地即时 + 防抖持久化） ----
  const applySpriteView = useCallback((patch: Partial<StorySpriteView>) => {
    const next = { ...spriteView, ...patch }
    remoteViewRef.current = next
    setSpriteView(next)
    const runId = snapshotRef.current?.runId
    if (!runId) return
    if (spriteViewSaveTimer.current) clearTimeout(spriteViewSaveTimer.current)
    spriteViewSaveTimer.current = setTimeout(() => {
      void api.story.setSpriteView(runId, next)
    }, 350)
  }, [spriteView])

  const respond = useCallback(
    async (response: Parameters<typeof api.story.respond>[0]['response']) => {
      const snap = snapshotRef.current
      if (!snap) return
      const res = await api.story.respond({ runId: snap.runId, response })
      if (!res.ok && res.error) toast.error(res.error)
    },
    [],
  )

  /** 退出剧情：存档并直接关闭本窗 */
  const handleStop = useCallback(async () => {
    const snap = snapshotRef.current
    playTokenRef.current++
    if (snap) await api.story.stop(snap.runId)
    api.win.close()
  }, [])

  // ---- 立绘解析：thinkingImage（仅队列空闲且无当前段时，避免语音已起播仍锁思考图）
  //      > 说话图（正在播放语音且情绪为平静时，与桌宠端规则一致）
  //      > emotionMap[emotion] > speakingImage > 首图 ----
  const speakingNow = phase === 'voice' && current?.kind === 'line' && current.speaker === 'ai'
  const spriteSrc = (() => {
    if (!sprite) return null
    if (snapshot?.thinking && phase === 'idle' && !current && sprite.thinkingImage) return api.story.spriteUrl(sprite.id, sprite.thinkingImage)
    if (speakingNow && spriteEmotion === 'neutral' && sprite.speakingImage) return api.story.spriteUrl(sprite.id, sprite.speakingImage)
    const byEmotion = sprite.emotionMap?.[spriteEmotion]
    if (byEmotion) return api.story.spriteUrl(sprite.id, byEmotion)
    if (sprite.speakingImage) return api.story.spriteUrl(sprite.id, sprite.speakingImage)
    const first = sprite.images[0]?.filePath
    return first ? api.story.spriteUrl(sprite.id, first) : null
  })()

  const pending = snapshot?.status === 'running' ? snapshot.pending : null
  /** 交互 UI 显示条件：队列排空 + 不在播放 + 有挂起交互 */
  const showInteraction = phase === 'idle' && !current && !!pending && !snapshot?.thinking
  const inputActive = !!pending && (pending.kind === 'input' || pending.kind === 'free' || (pending.kind === 'choices' && pending.allowFree))
  /** 空闲继续/重试：队列排空、无挂起、非思考（AI 轮次失败后的重试入口） */
  const showContinue = snapshot?.status === 'running' && phase === 'idle' && !current && !pending && !snapshot.thinking

  // 无进行中的演出：极简占位。完结时等待播放队列排空再切完结屏（避免"AI 还没播完就结束"的观感）
  const storyEnded = snapshot?.status === 'ended'
  if (!snapshot || (storyEnded && phase === 'idle' && !current)) {
    return (
      <div className="flex h-screen flex-col overflow-hidden" style={{ background: 'var(--bg-base)' }}>
        <WindowTitlebar title="剧情演出" />
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          <p className="text-sm text-text-2">{storyEnded ? '本段剧情已完结（存档已保留，可在设置页重开）' : '没有进行中的剧情演出'}</p>
          {!storyEnded && <p className="text-xs text-text-muted">在设置页「剧情系统」开始或继续演出</p>}
          <button
            onClick={() => api.win.close()}
            className="rounded-[var(--radius-md)] border border-border px-4 py-1.5 text-xs text-text-2 hover:bg-card-hover hover:text-text"
          >
            关闭窗口
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden" style={{ background: 'var(--bg-base)' }}>
      <WindowTitlebar title={snapshot ? `${snapshot.title} · 第 ${snapshot.chapterIndex + 1} 章 ${snapshot.chapterName}` : '剧情演出'} />
      <div className="relative flex min-h-0 flex-1 select-none flex-col">
        {/* 背景层（剧本图片 / 背景库 user: 引用，交叉淡入） */}
        <AnimatePresence>
          {backgroundUrl && (
            <motion.div
              key={backgroundUrl}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 1.1, ease: 'easeInOut' }}
              className="absolute inset-0 z-0"
            >
              <img src={backgroundUrl} alt="" className="h-full w-full object-cover" draggable={false} />
              <div className="absolute inset-0" style={{ background: 'color-mix(in srgb, var(--bg-base) 42%, transparent)' }} />
            </motion.div>
          )}
        </AnimatePresence>

        {/* 立绘层：可调大小/位置（随 run 存档） */}
        {spriteSrc && (
          <motion.img
            key={spriteSrc}
            src={spriteSrc}
            alt=""
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
            className="pointer-events-none absolute z-[5] max-h-[62%] object-contain"
            style={{
              left: `${50 + spriteView.x}%`,
              bottom: `calc(196px + ${spriteView.y}%)`,
              transform: `translateX(-50%) scale(${spriteView.scale})`,
              transformOrigin: 'bottom center',
            }}
            draggable={false}
          />
        )}

        {/* 底部合并对话框（LingChat 式：名牌 + 文本 + 选项/输入 同框）；mt-auto 钉在底部。
            对话框上方一行放演出控制按钮（自动/历史/立绘/退出，与对话框右缘对齐）；
            立绘调整浮层从按钮行上方弹出，不遮挡按钮 */}
        <div
          className="app-no-drag relative z-20 mt-auto shrink-0 px-4 pb-4 pt-2"
          style={{ background: 'linear-gradient(to top, color-mix(in srgb, var(--bg-base) 92%, transparent), transparent)' }}
        >
          {/* 演出控制按钮行（与对话框同宽右对齐）；立绘调整浮层向上弹出，不遮挡按钮 */}
          <div className="relative mx-auto mb-1 flex w-full max-w-[880px] items-center justify-end gap-1">
            <button
              onClick={() => {
                setAutoMode((v) => !v)
              }}
              className={cn(
                'rounded-[var(--radius-md)] px-2.5 py-1 text-xs backdrop-blur-sm transition-colors',
                autoMode ? 'bg-primary-500/15 text-primary-400' : 'text-text-2 hover:bg-card-hover hover:text-text',
              )}
            >
              自动
            </button>
            <button
              onClick={() => {
                setBacklogOpen(true)
                void api.story.getRun(snapshot.runId).then((r) => setBacklogMessages(r?.messages ?? []))
              }}
              className="flex items-center gap-1 rounded-[var(--radius-md)] px-2.5 py-1 text-xs text-text-2 backdrop-blur-sm transition-colors hover:bg-card-hover hover:text-text"
            >
              <History size={12} strokeWidth={1.75} />
              历史
            </button>
            <button
              onClick={() => setAdjustOpen((v) => !v)}
              title="调整立绘大小/位置"
              className={cn(
                'flex items-center gap-1 rounded-[var(--radius-md)] px-2.5 py-1 text-xs backdrop-blur-sm transition-colors',
                adjustOpen ? 'bg-primary-500/15 text-primary-400' : 'text-text-2 hover:bg-card-hover hover:text-text',
              )}
            >
              <Settings2 size={12} strokeWidth={1.75} />
              立绘
            </button>
            <button
              onClick={() => void handleStop()}
              title="退出剧情（存档并关闭）"
              className="ml-1 flex items-center gap-1 rounded-[var(--radius-md)] px-2.5 py-1 text-xs text-text-2 backdrop-blur-sm transition-colors hover:bg-danger/10 hover:text-danger"
            >
              <X size={12} strokeWidth={2} />
              退出
            </button>
            {/* 立绘调整浮层：从按钮行上方弹出，不遮挡按钮 */}
            <AnimatePresence>
              {adjustOpen && (
                <motion.div
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 6 }}
                  className="glass-strong app-no-drag absolute bottom-full right-0 z-30 mb-2 w-64 rounded-[var(--radius-lg)] border border-border p-3"
                >
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-semibold text-text">立绘调整</span>
                    <button
                      onClick={() => applySpriteView(DEFAULT_SPRITE_VIEW)}
                      className="text-[11px] text-text-2 hover:text-text"
                    >
                      重置
                    </button>
                  </div>
                  <SliderRow label="大小" value={spriteView.scale} min={0.4} max={2.5} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => applySpriteView({ scale: v })} />
                  <SliderRow label="左右" value={spriteView.x} min={-45} max={45} step={1} format={(v) => `${Math.round(v)}%`} onChange={(v) => applySpriteView({ x: v })} />
                  <SliderRow label="上下" value={spriteView.y} min={-90} max={55} step={1} format={(v) => `${Math.round(v)}%`} onChange={(v) => applySpriteView({ y: v })} />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <div className="glass mx-auto w-full max-w-[880px] rounded-[var(--radius-lg)] border border-border px-5 py-3.5">
            {/* 名牌行 */}
            <div className="mb-1.5 flex min-h-[22px] items-center gap-2">
              {current && current.kind === 'line' ? (
                <>
                  <span className="text-sm font-semibold text-text">{current.speaker === 'player' ? '你' : cardName}</span>
                  {current.emotion && current.speaker !== 'player' && (
                    <span className="rounded-full bg-primary-500/15 px-2 py-0.5 text-[10px] text-primary-400">
                      {EMOTION_LABEL[current.emotion]}
                    </span>
                  )}
                </>
              ) : (
                <span className="text-xs text-text-2">
                  {snapshot.thinking ? '思考中…' : pending ? '请选择 / 输入' : '剧情进行中'}
                </span>
              )}
              {showInteraction && pending?.kind === 'free' ? (
                <span className="ml-auto flex items-center gap-2 text-[11px] text-text-2">
                  <span>剩余 {pending.roundsLeft ?? '?'} 轮</span>
                  <button
                    onClick={() => void respond({ kind: 'free', end: true })}
                    className="underline-offset-2 transition-colors hover:text-text hover:underline"
                  >
                    结束对话
                  </button>
                </span>
              ) : (
                <span className="ml-auto text-[11px] text-text-2">
                  {phase === 'voice' ? '播放中 · 点击跳过' : phase === 'wait' ? (autoMode ? '自动播放中' : '点击继续') : ''}
                </span>
              )}
            </div>

            {/* 文本区：挂起输入时直接在对话框中输入（LingChat 式，Enter 发送）；否则点击推进/跳过语音 */}
            {showInteraction && inputActive ? (
              <textarea
                autoFocus
                value={inputText}
                rows={2}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => {
                  // Enter 发送；Shift+Enter 换行；输入法组合中的 Enter 不触发
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    const t = inputText.trim()
                    if (!t) return
                    if (pending?.kind === 'free') void respond({ kind: 'free', text: t })
                    else void respond({ kind: 'input', text: t })
                    setInputText('')
                  }
                }}
                placeholder={
                  pending?.kind === 'free'
                    ? `自由对话（剩余 ${pending.roundsLeft ?? '?'} 轮），输入台词后按 Enter 发送…`
                    : '输入你的行动或台词，按 Enter 发送…'
                }
                className="selectable w-full resize-none bg-transparent text-sm leading-relaxed text-text outline-none placeholder:text-text-2"
              />
            ) : (
              <div className="min-h-[56px] cursor-pointer" onClick={onTextClick}>
                {current && current.kind === 'narration' ? (
                  <p className="selectable px-2 py-1 text-center text-sm italic leading-relaxed text-text-2">{typedText}</p>
                ) : (
                  <p className="selectable min-h-[32px] whitespace-pre-wrap break-words text-sm leading-relaxed text-text">
                    {current ? typedText : ''}
                    {phase !== 'idle' && <span className="streaming-cursor" />}
                  </p>
                )}
              </div>
            )}

            {/* 选项（choices 挂起时在框内列出） */}
            {showInteraction && pending?.kind === 'choices' && (
              <div className="mt-2 space-y-1.5">
                {pending.choices?.map((o, i) => (
                  <button
                    key={i}
                    onClick={() => void respond({ kind: 'choice', index: i })}
                    className="block w-full rounded-[var(--radius-md)] border border-border px-3.5 py-2 text-left text-sm text-text transition-all hover:border-[var(--primary-400)] hover:bg-card-hover"
                  >
                    {o.text}
                  </button>
                ))}
              </div>
            )}

            {/* 空闲继续/重试（AI 轮次失败后） */}
            {showContinue && !inputActive && (
              <button
                onClick={() => void respond({ kind: 'retry' })}
                className="mt-2 w-full rounded-[var(--radius-md)] border border-border px-3 py-1.5 text-xs text-text-2 transition-colors hover:bg-card-hover hover:text-text"
              >
                上一段未完成 · 点击重试/继续
              </button>
            )}
          </div>
        </div>

        {/* backlog 浮层 */}
        <AnimatePresence>
          {backlogOpen && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 z-40 flex items-center justify-center bg-black/60 p-8 app-no-drag"
            >
              <div className="glass-strong flex max-h-full w-full max-w-[720px] flex-col overflow-hidden rounded-[var(--radius-xl)] border border-border">
                <div className="flex items-center justify-between border-b border-border p-3">
                  <span className="text-sm font-semibold text-text">对话历史</span>
                  <button onClick={() => setBacklogOpen(false)} className="rounded-[var(--radius-md)] p-1.5 text-text-2 hover:bg-card-hover hover:text-text">
                    <X size={15} />
                  </button>
                </div>
                <div className="flex-1 space-y-3 overflow-y-auto p-4">
                  {backlogMessages.filter((m) => !m.content.startsWith('（剧情演出：')).map((m, i) => {
                    // 旁白样式：剧本旁白/玩家独白/选项记录，以及纯括号的"不发声"内容（独白/动作）
                    const narrated = (m.role === 'user' && m.meta?.storyKind !== 'free') || isUnspoken(m.content)
                    return (
                      <div key={i} className={cn('flex', narrated ? 'justify-center' : m.role === 'user' ? 'justify-end' : 'justify-start')}>
                        {narrated ? (
                          <p className="max-w-[85%] text-center text-xs italic leading-relaxed text-text-2">{m.content}</p>
                        ) : (
                          <div className="max-w-[80%]">
                            <p className="mb-0.5 px-1 text-[10px] text-text-2">{m.role === 'user' ? '你' : cardName}</p>
                            <div
                              className={cn(
                                'selectable whitespace-pre-wrap break-words rounded-[var(--radius-lg)] px-3.5 py-2 text-sm leading-relaxed',
                                m.role === 'user'
                                  ? 'rounded-br-[var(--radius-md)] bg-primary-gradient text-[var(--on-brand)]'
                                  : 'glass rounded-bl-[var(--radius-md)] border border-border text-text',
                              )}
                            >
                              {m.content}
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                  {backlogMessages.length === 0 && <p className="py-8 text-center text-sm text-text-2">还没有演出记录</p>}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 音频元素（语音 + BGM） */}
        <audio ref={audioRef} className="hidden" />
        <audio ref={bgmRef} className="hidden" />
      </div>
    </div>
  )
}

/** 立绘调整滑杆行 */
function SliderRow({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  format: (v: number) => string
  onChange: (v: number) => void
}) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <span className="w-8 shrink-0 text-[11px] text-text-2">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="min-w-0 flex-1 accent-[var(--primary-400)]"
      />
      <span className="w-10 shrink-0 text-right text-[11px] text-text-2">{format(value)}</span>
    </div>
  )
}
