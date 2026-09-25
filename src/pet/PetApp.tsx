/**
 * 桌宠窗口根组件。
 *
 * 拖动改用系统原生方式（-webkit-app-region: drag）：
 *   - Windows 上透明无边框窗口若用 setPosition 程序化移动，DWM 每次移动都会让窗口
 *     合成缓冲略微扩大 → 按住/拖动时持续抖动且窗口越拖越大（已知平台缺陷）。
 *   - 原生拖动由操作系统自己移动窗口，完全不调用 setPosition，从根本上避免该问题。
 *
 * 代价：拖动区域内鼠标点击事件被系统接管，无法再通过双击唤起聊天/单击播放动作，
 * 因此右上角提供 no-drag 小按钮（聊天 / 设置）。滚轮缩放仍由 wheel 事件处理。
 * 右键唤起自绘上下文菜单（打开聊天 / 打开设置 / 退出）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { LogOut, MessageSquare, Settings } from 'lucide-react'
import { api } from '../api'
import { PositionedMenu, type MenuItem } from '../components/DropdownMenu'
import { PendingMemoryBadge } from '../components/PendingMemoryBadge'
import { PetStage, type PetStageHandle } from './PetStage'
import { PetMiniChat } from './PetMiniChat'
import { PetInput } from './PetInput'
import { PetContextToolbar } from './PetContextToolbar'
import { bindPersistentSessionSync, useSessionStore } from '../store/sessionStore'
import { useCharacterStore } from '../store/characterStore'
import { initSettingsSync } from '../store/settingsStore'
import { usePetReadingStore } from './petReadingStore'
import { DEFAULT_EMOTION, type ContextStats, type StandardEmotion } from '../types'
import { stripBrackets } from '../lib/utils'

/** 桌宠窗口宽度固定（与主进程 PET_WIDTH 保持一致）。
 *  用固定像素而非 h-full/w-full：Windows 透明窗口拖动时 CSS 布局尺寸会被报告失真，
 *  百分比尺寸会跟着变大。钉死像素则完全不受影响。
 *  高度不固定：由"内容框高度 + 模型区 440 + 输入框高度"联动（主进程 setSize），模型区恒定。 */
const PET_W = 300
/** 模型区恒定高度：内容框收放/拖高不改变模型与立绘显示大小 */
const MODEL_H = 440
/** 底部迷你输入框占用的固定高度 */
const INPUT_H = 40
/** 内容框展开时的默认高度（左上角角标可拖高） */
const CONTENT_H = 130

/** 内容框状态持久化 key（重启恢复展开/收起与高度） */
const STORAGE_KEY = 'lainecho.petChatPanel'

interface MenuPos {
  x: number
  y: number
}

export default function PetApp() {
  const stageRef = useRef<PetStageHandle>(null)
  const [menu, setMenu] = useState<MenuPos | null>(null)
  const [scalePct, setScalePct] = useState<number | null>(null)
  /** 迷你会话内容框：初始收起；展开高度可拖调（左上角角标）。高度持久化，重启恢复；展开态每次启动默认收起 */
  const [contentOpen, setContentOpen] = useState<boolean>(false)
  const [contentH, setContentH] = useState<number>(() => {
    try {
      const h = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}').height
      return typeof h === 'number' && h >= 90 && h <= 320 ? h : CONTENT_H
    } catch {
      return CONTENT_H
    }
  })
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 当前会话上下文 token 用量（主进程 ai:context-stats 广播；切换会话时清空） */
  const [ctxStats, setCtxStats] = useState<ContextStats | null>(null)
  /** 模型上下文窗口 token 数（实时，跟随设置窗「模型上下文窗口」变更同步；0 = 不限制） */
  const [windowTokens, setWindowTokens] = useState(0)
  /** 手动压缩进行中 */
  const [compacting, setCompacting] = useState(false)
  /** 手动压缩结果提示（短暂显示后恢复 token 用量） */
  const [compactNote, setCompactNote] = useState<string | null>(null)
  const compactNoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 宠物窗侧会话同步：只持久订阅 AI 流式/完成事件；初始为空，跟随聊天窗广播的当前会话，
  // 不主动加载"最近会话"（聊天窗为空时宠物窗也为空）
  useEffect(() => {
    // 宠物窗自己的 renderer 有独立的 characterStore：先加载角色卡列表，
    // 保证内容框名牌/头部能显示当前角色名（否则恒为 AI 兜底）
    void useCharacterStore.getState().load()
    // 角色卡列表跨窗口同步：设置窗增删改卡后刷新本地列表。
    // 不订阅的话 cards 只在挂载时加载一次——改名后显示旧名、新建卡查不到显示 'AI' 兜底
    const unsubCards = api.characterCard.onChanged(() => {
      void useCharacterStore.getState().load()
    })
    // 通知主进程 renderer 就绪：补发最近一次语音模式，避免广播早于订阅而丢失
    api.pet.reportRendererReady()
    const unbind = bindPersistentSessionSync()
    return () => {
      unsubCards()
      unbind()
    }
  }, [])

  // 全局设置实时同步：加载持久化设置并订阅主进程广播（文字速度等设置窗改动后立即对宠物窗生效）
  useEffect(() => initSettingsSync(), [])

  // 跟随聊天窗切换/新建会话：收到当前会话 id 时加载对应消息到宠物窗内容框；null 表示清空
  useEffect(() => api.pet.onCurrentSessionChanged((id) => {
    const before = useSessionStore.getState()
    console.log('[sync] pet收到currentSession id=%s 本地cur=%s 本地msgs=%d', id, before.currentSessionId, before.messages.length)
    // 会话变化：清空上一会话的上下文用量，避免串显示
    setCtxStats((prev) => (prev && prev.sessionId !== id ? null : prev))
    if (!id) {
      useSessionStore.setState({ currentSessionId: null, messages: [], streamingContent: '', streaming: false })
      return
    }
    // 若宠物窗本地已经是该会话（含刚发送、正在流式、或已渲染消息），跳过拉取，
    // 避免一次自广播把刚显示的用户气泡/流式覆盖成空
    const cur = useSessionStore.getState()
    if (cur.currentSessionId === id) return
    void (async () => {
      try {
        const detail = await api.session.get(id)
        // 竞态保护：拉取期间若该会话已被实时流式上屏（新会话首条用户消息已由
        // stream-user 即席上屏），避免用磁盘空快照覆盖掉已渲染的消息
        const cur = useSessionStore.getState()
        if (cur.currentSessionId === id && cur.messages.length > 0) return
        useSessionStore.setState({ currentSessionId: id, messages: detail.messages, streaming: false, streamingContent: '' })
        // 会话绑定的角色卡 → 设为当前卡，名牌显示其名字
        if (detail.characterCardId) {
          useCharacterStore.setState({ currentCardId: detail.characterCardId })
        }
        // 切换到已有内容的会话：只读查询上下文用量，激活 token 展示与手动压缩按钮
        // （发送/压缩时的广播仍会实时覆盖此查询结果）
        if (detail.messages.length > 0) {
          void api.ai.getContextStats(id).then((res) => {
            if (res.ok && res.stats && useSessionStore.getState().currentSessionId === id) {
              setCtxStats(res.stats)
            }
          }).catch(() => {})
        }
      } catch {
        // 加载失败不阻塞
      }
    })()
  }), [])

  // 仅"本窗口"发送消息时展开内容框（聊天窗发来的消息不展开，避免被动拉起内容框）
  const handlePetUserSend = useCallback(() => setContentOpen(true), [])

  // 订阅主进程广播的上下文 token 用量（每次 AI 组装 / 手动压缩后更新）。
  // 仅当属于宠物窗当前会话时显示，避免串到其它会话；宠物窗尚无会话时也接受（新会话首条）
  useEffect(() => api.pet.onContextStats((stats) => {
    const cur = useSessionStore.getState().currentSessionId
    if (cur && cur !== stats.sessionId) return
    setCtxStats(stats)
  }), [])

  // 模型上下文窗口值：启动时读取 + 订阅设置变更即时同步（token 用量显示里的「窗口」分母）
  useEffect(() => {
    void api.settings.get().then((s) => setWindowTokens(s.contextWindowTokens)).catch(() => {})
    return api.pet.onSettingsChanged((s) => setWindowTokens(s.contextWindowTokens))
  }, [])

  /** 手动压缩当前会话历史：调用主进程 ai:compact-now，成功后用量由广播自动刷新 */
  const handleCompact = async () => {
    const sid = useSessionStore.getState().currentSessionId
    if (!sid || compacting) return
    setCompacting(true)
    setCompactNote(null)
    try {
      const res = await api.ai.compactNow(sid)
      if (res.ok) {
        if (res.stats) setCtxStats(res.stats)
        setCompactNote(res.compacted ? '已压缩' : '无需压缩')
      } else {
        console.error('[pet] 手动压缩失败', res.error)
        setCompactNote(res.error ? `失败：${res.error}` : '压缩失败')
      }
    } catch (err) {
      console.error('[pet] 手动压缩异常', err)
      setCompactNote('压缩失败')
    } finally {
      setCompacting(false)
      // 短暂显示结果后恢复 token 用量
      if (compactNoteTimer.current) clearTimeout(compactNoteTimer.current)
      compactNoteTimer.current = setTimeout(() => setCompactNote(null), 1800)
    }
  }

  // 新一轮流式开始：重置朗续状态（避免上一轮的逐字/跟读进度串到本轮）
  useEffect(() => {
    let prevStreaming = useSessionStore.getState().streaming
    const unsub = useSessionStore.subscribe((state) => {
      if (prevStreaming !== state.streaming) {
        prevStreaming = state.streaming
        if (state.streaming) {
          usePetReadingStore.getState().reset()
          // 新一轮开始：清掉上一轮残留的 TTS 队列，避免旧声音串场（易被误听为杂音）
          resetSpeech()
        }
      }
    })
    return unsub
  }, [])

  // 内容框收放/拖高 → 仅持久化状态（内容框是叠加浮层，不改变窗口或模型尺寸）
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ open: contentOpen, height: contentH }))
    } catch {
      // 存储失败不阻塞
    }
  }, [contentOpen, contentH])

  // ============ TTS 双队列架构 ============
  // 合成和播放完全解耦：合成循环持续从文本队列取句合成，
  // 播放循环持续从音频队列取音频播放。两条流水线并行运行。
  // 效果：播放第 1 句时，合成循环已在合成第 2 句 → 句间几乎无间隔。
  // 旧串行架构间隔 = 合成时间 + 播放时间；新架构间隔 ≈ max(合成时间, 播放时间)。

  /** 待合成的文本队列（入队顺序 = 播放顺序；index 为合成分段索引，null 表示单段整条） */
  const textQueueRef = useRef<Array<{ text: string; voiceId: string | null; languageOverride: import('../types').TTSLanguage | null; index: number | null; emotion: StandardEmotion; engine?: 'genie' | 'mimo'; genieOverride?: import('../types').CharacterGenieOverride | null }>>([])
  /** 已合成待播放的音频队列（附带块文本与情绪：跟读时用块文本逐字显示、切立绘用情绪） */
  const audioQueueRef = useRef<Array<{ buffer: ArrayBuffer; index: number | null; emotion: StandardEmotion; text: string }>>([])
  /** 合成锁：同时只合成一段，避免 MiMo API 并发请求 */
  const isSynthesizingRef = useRef(false)
  /** 播放锁：同时只播放一段音频，避免叠加 */
  const isPlayingRef = useRef(false)
  /** 语音"回合号"：新一轮 AI 回复 / 终止都会递增。正在合成的旧片段合完时，若回合号已变则丢弃，
   *  避免上一轮残留音频串到新一轮上屏中出现（听感为"杂音/串场"） */
  const speechRoundRef = useRef(0)

  /**
   * 重置本轮语音：丢弃未合成/未播放的旧队列，并标记回合号自增，
   * 使"旧片段合成的中途产物"不再入队播放。不动正在渲染的口型（避免打断播放Promise引发挂起）。
   */
  function resetSpeech() {
    speechRoundRef.current += 1
    textQueueRef.current = []
    audioQueueRef.current = []
    usePetReadingStore.getState().setPlaying(false)
  }

  /**
   * 合成循环：从文本队列取一个合成分段合成音频（携带分段索引与情绪）放入音频队列，串行不并发。
   */
  const synthesizeLoop = async () => {
    if (isSynthesizingRef.current) return
    const next = textQueueRef.current.shift()
    if (!next) return

    isSynthesizingRef.current = true
    // 记录本段所属回合号：合成是异步的，过程中可能已被 resetSpeech 清场
    const round = speechRoundRef.current
    try {
      // 合成前剥离心理/动作旁白（括号内容），只朗读台词
      const speakText = stripBrackets(next.text)
      // 旁白（纯括号）不发音：把该段文本直接追加进朗读显示，使旁白随所在语音段同步出现
      if (!speakText) {
        usePetReadingStore.getState().appendText(next.text)
        if (next.index !== null) stageRef.current?.setEmotion(next.emotion)
        return
      }
      const audio = await api.tts.synthesize({ text: speakText, voiceId: next.voiceId, languageOverride: next.languageOverride, emotion: next.emotion, engine: next.engine, genieOverride: next.genieOverride })
      // 合完时若已被新一轮/终止清场，丢弃这段，避免旧音频串到新一轮（杂音/串场）
      if (audio && speechRoundRef.current === round) {
        audioQueueRef.current.push({ buffer: audio, index: next.index, emotion: next.emotion, text: next.text })
        // 有新音频了，尝试触发播放
        void playLoop()
      }
    } catch (err) {
      console.error('[pet] TTS 合成失败', err)
      // 即使该段合成失败，也把文本顶上跟读气泡，避免"该回复静默消失/气泡不同步"：
      // 否则 active 卡住会把最后一条 AI 消息持续隐藏，pet 内容框就看不到这条回复。
      if (next.text) {
        usePetReadingStore.getState().appendText(next.text)
      }
      if (next.index !== null) stageRef.current?.setEmotion(next.emotion)
    } finally {
      isSynthesizingRef.current = false
      // 继续合成下一段（预合成），不等播放
      if (textQueueRef.current.length > 0) {
        void synthesizeLoop()
      } else if (audioQueueRef.current.length === 0 && !isPlayingRef.current) {
        // 无待合成、无待播音频（可能前序全部合成失败）：立即收尾朗读状态，让定型消息正常上屏。
        // 清空 displayedText 同 playLoop 收尾，避开 zustand subscribe 回调内重入
        usePetReadingStore.getState().setPlaying(false)
        usePetReadingStore.getState().setActive(false)
        usePetReadingStore.getState().clearText()
      }
    }
  }

  /**
   * 播放循环：取出音频播放；跟读模式下按"已朗读文本 + 当前块进度"驱动内容框逐字显示，
   * 并在块边界按该块情绪切换立绘（立绘随情绪切换保留、不降级）。
   */
  const playLoop = async () => {
    if (isPlayingRef.current) return
    const next = audioQueueRef.current.shift()
    if (!next) return

    isPlayingRef.current = true
    usePetReadingStore.getState().setPlaying(true)
    try {
      // 块边界：切立绘到该块情绪（每个情绪变化处都切换，一个不丢）
      if (next.index !== null) {
        stageRef.current?.setEmotion(next.emotion)
      }
      // 段随语音：该段语音开始播放时，把该段完整文本追加进朗读显示，打字机随后流式打出
      if (usePetReadingStore.getState().mode === 'follow' && next.text) {
        usePetReadingStore.getState().appendText(next.text)
      }
      await stageRef.current?.speak(next.buffer)
    } catch (err) {
      console.error('[pet] TTS 播放失败', err)
    } finally {
      isPlayingRef.current = false
      // 继续播放下一段（如果队列中还有）
      if (audioQueueRef.current.length > 0) {
        void playLoop()
      } else if (!isSynthesizingRef.current && textQueueRef.current.length === 0) {
        // 全部段落播完：结束朗读流程与播放状态（气泡让位给定型消息）。
        // 注意：清空 displayedText 必须在订阅回调之外执行（zustand setState 在 subscribe 回调内
        // 重入会无限循环），故在 setActive(false) 之后、同一调用栈内完成收尾
        usePetReadingStore.getState().setPlaying(false)
        usePetReadingStore.getState().setActive(false)
        usePetReadingStore.getState().clearText()
      }
    }
  }

  // 订阅"说话"事件：聊天窗口流式完成后触发，按主进程拆好的合成分段（dialogue 逐项）段级合成播放
  useEffect(() => {
    const unsub = api.pet.onSpeak((payload) => {
      const { text, voiceId, languageOverride, chunks, follow, engine, genieOverride } = payload ?? {}
      if (!text?.trim()) return
      console.log('[sync] pet onSpeak text=%s chunks=%d engine=%s', text.slice(0, 16), chunks?.length ?? 0, engine ?? '?')
      const isFollow = follow === true
      // 仅"跟读文本"开启时用段落跟读气泡（段随语音，active 置真）；
      // 关闭跟读时语音在整段文本生成后播放，不改文本展示（保持流式打字机，active 不置真）
      if (isFollow) {
        usePetReadingStore.getState().setMode('follow')
        // 新一轮清理已由 onVoiceMode（流式开始）负责：此处不再 clearText——
        // 开头旁白前置流（ai:stream-narration）先于首个 speak 到达，此处清空会丢已上屏的旁白
        usePetReadingStore.getState().setActive(true)
      }
      const list = chunks && chunks.length > 0 ? chunks : [{ text: text.trim(), emotion: DEFAULT_EMOTION }]
      const items = list
        .map((c) => ({ text: (c.text ?? '').trim(), emotion: c.emotion ?? DEFAULT_EMOTION }))
        .filter((c) => c.text.length > 0)
        .map((c, i) => ({
          text: c.text,
          voiceId,
          languageOverride: languageOverride ?? null,
          index: chunks && chunks.length > 0 ? i : null,
          emotion: c.emotion,
          engine,
          genieOverride: genieOverride ?? null,
        }))
      if (items.length === 0) return
      textQueueRef.current.push(...items)
      void synthesizeLoop()
      void playLoop()
    })
    return unsub
  }, [])

  // 订阅"开头括号旁白前置"流：回答最前面的连续括号旁白在 LLM 流式阶段即时上屏（不依赖语音），
  // 台词部分仍由 playLoop 段随语音追加（主进程已从语音块剥除已前置旁白，不会重复）。
  // reset：空回复重试轮从头流式，清空已前置旁白重新接收。
  useEffect(() => api.ai.onStreamNarration((payload) => {
    const st = usePetReadingStore.getState()
    if (payload?.reset) {
      st.clearText()
      return
    }
    if (payload?.delta && st.mode === 'follow') {
      st.appendText(payload.delta)
    }
  }), [])

  // 流式开始时订阅本轮语音模式：有语音时用段落跟读打字，无语音时走流式打字机整段流式输出。
  // 注意：这里只切 mode 并清空文本，不让 active 直接为真——active 反映"语音真正开始朗读"，
  // 由 onSpeak（语音块实际调度）接管置真，避免 LLM 生成快于语音时先露出整段再消失。
  useEffect(() => api.pet.onVoiceMode(({ voiceEnabled }) => {
    const st = usePetReadingStore.getState()
    st.setMode(voiceEnabled ? 'follow' : 'typewriter')
    // 新一轮开始：立即清空已显示文本（不等流式开始），避免上一轮残留文本被透给聊天窗
    st.clearText()
  }), [])

  // 本轮 AI 请求出错 / 主动终止：重置朗读流程态（结束"待输出"光标），并清掉未播的语音队列，
  // 避免被终止的旧声音继续播放（易被误听为杂音/残留）
  useEffect(() => api.ai.onStreamError(() => {
    usePetReadingStore.getState().reset()
    resetSpeech()
  }), [])

  // 订阅朗读 store：朗读文本追加/重置、朗读进行状态变化时，同步到聊天窗（文本 + 朗读进行中）
  useEffect(() => {
    let prevActive = usePetReadingStore.getState().active
    return usePetReadingStore.subscribe((s) => {
      api.pet.reportReadingText(s.displayedText)
      api.pet.reportReadingActive(s.active)
      // 朗读结束（active 下降沿）且流式已结束：清空 streamingContent，让定型消息上屏。
      // 注意：此处不可调用 pet store 的 setter（如 clearText）——zustand 在 subscribe 回调内
      // setState 会因每次新建对象引用而无限重入循环（刷屏 + 阻塞渲染）。
      // displayedText 的清空已在 playLoop/synthesizeLoop 收尾处（setActive(false) 之后）完成。
      if (prevActive && !s.active) {
        const st = useSessionStore.getState()
        if (!st.streaming) useSessionStore.setState({ streamingContent: '' })
      }
      prevActive = s.active
    })
  }, [])

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    const factor = e.deltaY < 0 ? 1.1 : 0.9
    stageRef.current?.zoom(factor)
    setScalePct(Math.round((stageRef.current?.getScale() ?? 1) * 100))
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    hideTimerRef.current = setTimeout(() => setScalePct(null), 900)
  }

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY })
  }

  const menuItems: MenuItem[] = [
    { key: 'chat', label: '打开聊天', icon: MessageSquare, onSelect: () => api.app.openChat() },
    { key: 'settings', label: '打开设置', icon: Settings, onSelect: () => api.app.openSettings() },
    { key: 'quit', label: '退出', icon: LogOut, danger: true, onSelect: () => api.app.quit() },
  ]

  return (
    <div
      style={{ width: PET_W, height: MODEL_H + INPUT_H }}
      className="app-drag relative overflow-hidden"
      onWheel={onWheel}
      onContextMenu={onContextMenu}
    >
      {/* 模型区：始终满高（模型/立绘大小恒定）。根容器已是 app-drag（拖动窗口），这里不再标 drag，
          避免子级 drag 命中区覆盖交互按钮 */}
      <div
        style={{ position: 'absolute', left: 0, right: 0, top: 0, height: MODEL_H, zIndex: 0 }}
      >
        <PetStage stageRef={stageRef} onStatus={() => {}} />
      </div>

      {/* 底部浮层：迷你会话内容框（半透明叠加在模型上，位于输入框上方） */}
      {contentOpen && (
        <div className="app-no-drag absolute bottom-12 left-1 z-30" style={{ height: contentH, width: 'calc(100% - 8px)' }}>
          <PetMiniChat
            contentH={contentH}
            onToggle={() => setContentOpen((v) => !v)}
            onResize={setContentH}
            ctxStats={ctxStats}
            windowTokens={windowTokens}
            compacting={compacting}
            compactNote={compactNote}
            onCompact={() => void handleCompact()}
          />
        </div>
      )}

      {/* 模型取右上角 no-drag 小按钮（聊天/设置） */}
      <div className="app-no-drag absolute right-2 top-1 flex items-center gap-2" style={{ zIndex: 40 }}>
        <PetQuickButton title="打开聊天" onClick={() => {
          const sid = useSessionStore.getState().currentSessionId
          if (sid) api.app.openChatWithSession(sid)
          else api.app.openChat()
        }}>
          <MessageSquare size={14} strokeWidth={1.75} />
        </PetQuickButton>
        <PetQuickButton title="打开设置" onClick={() => api.app.openSettings()}>
          <Settings size={14} strokeWidth={1.75} />
          <PendingMemoryBadge />
        </PetQuickButton>
      </div>

      {/* 收起态：右下角胶囊唤起会话（左侧为上下文工具栏：token 用量 + 手动压缩） */}
      {!contentOpen && (
        <div className="app-no-drag absolute bottom-10 right-2 z-50 flex items-center gap-1.5">
          <PetContextToolbar
            stats={ctxStats}
            windowTokens={windowTokens}
            compacting={compacting}
            note={compactNote}
            onCompact={() => void handleCompact()}
          />
          <button
            type="button"
            onClick={() => setContentOpen(true)}
            className="flex items-center gap-1 rounded-full border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 py-1 text-[11px] font-medium text-text transition-colors hover:text-[var(--primary-400)]"
            title="展开聊天会话"
          >
            <MessageSquare size={12} strokeWidth={1.75} />
            会话
          </button>
        </div>
      )}

      {/* 底部：迷你聊天输入框（可发送，与聊天窗同会话同步） */}
      <div className="app-no-drag absolute bottom-0 left-0 right-0 z-30" style={{ height: INPUT_H }}>
        <PetInput onUserSend={handlePetUserSend} />
      </div>

      {/* 缩放百分比徽标（滚轮缩放后短暂浮现） */}
      <AnimatePresence>
        {scalePct !== null && (
          <motion.div
            className="app-no-drag pointer-events-none absolute bottom-2 right-2 rounded-full border border-[var(--border-strong)] bg-[var(--bg-panel)]/90 px-3 py-1 text-xs font-medium text-text shadow-[var(--shadow-card)] backdrop-blur-[20px]"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.18 }}
          >
            {scalePct}%
          </motion.div>
        )}
      </AnimatePresence>

      {/* 右键菜单 */}
      <PositionedMenu x={menu?.x ?? 0} y={menu?.y ?? 0} open={!!menu} items={menuItems} onClose={() => setMenu(null)} />
    </div>
  )
}

function PetQuickButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="glass-strong relative flex h-8 w-8 items-center justify-center rounded-full text-text-2 transition-colors hover:text-text hover:shadow-[0_0_10px_var(--primary-glow)]"
    >
      {children}
    </button>
  )
}
