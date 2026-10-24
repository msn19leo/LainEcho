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
import { useTurnDocStore } from '../store/turnDocStore'
import { useCharacterStore } from '../store/characterStore'
import { initSettingsSync, useSettingsStore, typingSpeedToMs } from '../store/settingsStore'
import { usePetReadingStore } from './petReadingStore'
import { BUILTIN_DEFAULT_EMOTION, type ContextStats } from '../types'
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

export default function PetApp() {
  const stageRef = useRef<PetStageHandle>(null)
  /** 方案A：当前回合文档 turnId（快照订阅更新；语音进度上行用） */
  const turnCoordinatorIdRef = useRef<string | null>(null)
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
    // 方案A：订阅回合文档快照（幂等整体替换）+ 就绪时主动拉取一次（认领=拉快照）
    const unsubTurn = api.ai.onTurnState((doc) => {
      turnCoordinatorIdRef.current = doc.turnId
      useTurnDocStore.getState().adopt(doc)
    })
    const unsubTurnDone = api.ai.onTurnDone((doc) => {
      turnCoordinatorIdRef.current = doc.turnId
      useTurnDocStore.getState().adopt(doc)
    })
    void api.ai.getTurnSnapshot().then((doc) => {
      if (doc) {
        turnCoordinatorIdRef.current = doc.turnId
        useTurnDocStore.getState().adopt(doc)
      }
    }).catch(() => {})
    const unbind = bindPersistentSessionSync()
    return () => {
      unsubCards()
      unsubTurn()
      unsubTurnDone()
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
        // stream-user 即席上屏），避免用磁盘空快照覆盖掉已渲染的消息。
        // streaming 一并守护：流式进行中（本轮 user 消息尚未落盘）时任何 stale 磁盘
        // 快照都不得覆盖本地——否则用户气泡会消失到 stream-done 才回来（2026-10-14 实锤）
        const cur = useSessionStore.getState()
        if (cur.currentSessionId === id && (cur.messages.length > 0 || cur.streaming)) return
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

  /** 待合成的文本队列（入队顺序 = 播放顺序；index 为合成分段索引，null 表示单段整条；
   *  cumChars = 入队时分配的"含本槽位"累计字符数，消费时按它上行进度） */
  const textQueueRef = useRef<Array<{ text: string; voiceId: string | null; languageOverride: import('../types').TTSLanguage | null; index: number | null; emotion: string; kind?: 'speak' | 'narr'; engine?: 'genie' | 'mimo'; genieOverride?: import('../types').CharacterGenieOverride | null; segIndex?: number | null; cumChars?: number; speed?: number | null }>>([])
  /** 已合成待播放的音频队列（附带块文本与状态：跟读时用块文本逐字显示、切立绘用状态；
   *  cumChars 透传自文本队列）。buffer=null 为 displayOnly 纯旁白的零时长槽位 */
  const audioQueueRef = useRef<Array<{ buffer: ArrayBuffer | null; index: number | null; emotion: string; text: string; kind: 'speak' | 'narr'; cumChars?: number }>>([])
  /**
   * 方案A字符进度：入队时按投送顺序累加文本长度，每个槽位携带"含本槽位"的累计值 cumChars；
   * 消费时上行 speaking=该值（播完再上行 spoken=该值），主进程单调取 max。
   * 口径 = 渲染端 sliceSegmentsByCount 的**无分隔符拼接空间**（segments 文本直接相加）——
   * 早先按"槽位间 +1 换行"累计会让 cap 比实际可显文本多出"已消费槽位数"个字符，
   * 表现为下一段台词提前漏出几个字（2026-10-14 16:29 轮"今天"两字实锤）。
   * 与提取器变体/合音/兜底/分段粒度完全解耦：语音消费到哪、两窗文本就放行到哪。
   */
  const enqueuedCharsRef = useRef(0)
  /** 新一轮语音开始时归零 */
  const resetProgressCursor = () => {
    enqueuedCharsRef.current = 0
    lastProgressCharsRef.current = 0
    revealDueAtRef.current = 0
  }
  /** 入队时分配累计字符数（无分隔符口径） */
  const takeProgressChars = (slotTextLen: number): number => {
    enqueuedCharsRef.current += slotTextLen
    return enqueuedCharsRef.current
  }
  /** 已上报的最新字符进度（播放插值的起点；新一轮经 resetProgressCursor 归零） */
  const lastProgressCharsRef = useRef(0)
  /**
   * 揭示追平时钟（ms 时间戳）：打字机按 textSpeed 打完"当前已解锁全部文本"的估计时刻。
   * 每次揭示上限前进 delta 字，时钟延长 delta×每字毫秒（打字机恒速模型，追平即从现在起算）。
   * 语音槽位开播前等待该时钟到期——旁白（及其前序未打完文本）在前一段语音播完后按 textSpeed
   * 全速打完，下一段语音才开播（用户规则：语音在前一段旁白输出完后才能开始输出）。
   * textSpeed=0（即时全显）时增量恒 0，自动跳过等待。
   */
  const revealDueAtRef = useRef(0)
  /** 上行进度（消费时调用）：cumChars=该槽位累计值；spoken=true 表示已播完（下限一并推进） */
  const reportProgress = (cumChars: number | undefined, spoken: boolean) => {
    const tid = turnCoordinatorIdRef.current
    if (!tid || !cumChars || cumChars <= 0) return
    const delta = Math.max(0, cumChars - lastProgressCharsRef.current)
    if (delta > 0) {
      const speed = typingSpeedToMs(useSettingsStore.getState().settings.textSpeed ?? 80)
      if (speed > 0) revealDueAtRef.current = Math.max(revealDueAtRef.current, Date.now()) + delta * speed
    }
    lastProgressCharsRef.current = Math.max(lastProgressCharsRef.current, cumChars)
    if (spoken) api.ai.reportTurnProgress(tid, cumChars, cumChars)
    else api.ai.reportTurnProgress(tid, cumChars, 0)
  }
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
    revealDueAtRef.current = 0
    usePetReadingStore.getState().setPlaying(false)
  }

  /**
   * 朗读收尾检查：仅当「本轮生成已结束（streaming=false）且合成/播放队列全部排空」时
   * 才结束朗读流程（setActive(false)+clearText()，跟读气泡让位给定型消息）。
   * 边生成边读下，块与块之间存在排水间隙（LLM 仍在生成下一段 / 下一段合成中）：
   * 若在间隙里清场，跟读气泡会被清空、已朗读段落丢失、隐藏门释放后再重新隐藏——
   * 表现为气泡闪空、两窗显示不同步、整段读完才见到全文（2026-09-29 线上案例）。
   */
  const maybeFinalizeReading = () => {
    if (textQueueRef.current.length > 0 || audioQueueRef.current.length > 0) return
    if (isSynthesizingRef.current || isPlayingRef.current) return
    if (useSessionStore.getState().streaming) return
    const st = usePetReadingStore.getState()
    if (!st.active && !st.playing && !st.displayedText) return
    st.setPlaying(false)
    st.setActive(false)
    st.clearText()
  }

  /**
   * 合成循环：从文本队列取一个合成分段合成音频（携带分段索引与状态）放入音频队列，串行不并发。
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
      // narr 项（displayOnly 旁白）/剥空项：不合成音频，但**按序压入音频队列**成为零时长槽位，
      // 由播放循环统一消费并回报进度——这样旁白进度严格跟随"播放顺序"而非"合成顺序"。
      // （早先在合成循环里直接回报 spoken：旁白在"上一段台词刚合成完、还没播完"时就抢跑放行，
      // 表现为旁白文本比语音提前出现，2026-10-14 16:29 轮实锤；
      // 更早的"投送时直插音频队列"则会越过仍在合成的台词，顺序错乱。）
      if (!speakText || next.kind === 'narr') {
        audioQueueRef.current.push({ buffer: null, index: next.index, emotion: next.emotion, text: next.text, kind: 'narr', cumChars: next.cumChars })
        return
      }
      const audio = await api.tts.synthesize({ text: speakText, voiceId: next.voiceId, languageOverride: next.languageOverride, emotion: next.emotion, engine: next.engine, genieOverride: next.genieOverride, speed: next.speed ?? undefined })
      // 合完时若已被新一轮/终止清场，丢弃这段，避免旧音频串到新一轮（杂音/串场）
      if (audio && speechRoundRef.current === round) {
        audioQueueRef.current.push({ buffer: audio, index: next.index, emotion: next.emotion, text: next.text, kind: 'speak', cumChars: next.cumChars })
      }
    } catch (err) {
      console.error('[pet] TTS 合成失败', err)
      // 即使该段合成失败，也把文本顶上跟读气泡，避免"该回复静默消失/气泡不同步"：
      // 否则 active 卡住会把最后一条 AI 消息持续隐藏，pet 内容框就看不到这条回复。
      if (next.text) {
        usePetReadingStore.getState().appendText(next.text, next.kind ?? 'speak')
      }
      // 方案A：合成失败段同样推进字符进度（该段视作已消费），否则门控卡死在失败段之前
      reportProgress(next.cumChars, true)
      if (next.index !== null) stageRef.current?.setEmotion(next.emotion)
    } finally {
      isSynthesizingRef.current = false
      // 先复位合成锁、再触发播放：播放循环的"最后槽位"判定（isLastSlot）依赖合成锁——
      // 若带着锁触发，刚合成的真最后槽位会被误判为"后面还有槽位在合成"，
      // target 退化为槽位累计值，"尾字插值到文档总量"的语义失效
      void playLoop()
      // 继续合成下一段（预合成），不等播放；队列暂空时仅做收尾检查——
      // 生成未结束（还有后续语音块）时保持跟读状态与已读文本，不再在块间清场（见 maybeFinalizeReading）
      if (textQueueRef.current.length > 0) {
        void synthesizeLoop()
      } else {
        maybeFinalizeReading()
        // 方案A：以旁白收尾的轮次不走 playLoop（narr 槽位在合成循环直接消费）——
        // 在此补报 reading 收尾（主进程幂等：已 done 则忽略；播放循环排空分支同样会报，双报无害）
        const tid = turnCoordinatorIdRef.current
        if (tid && audioQueueRef.current.length === 0 && !isPlayingRef.current && !useSessionStore.getState().streaming) {
          api.ai.reportTurnReadingDone(tid)
        }
      }
    }
  }

  /**
   * 播放循环：取出音频播放；跟读模式下按"已朗读文本 + 当前块进度"驱动内容框逐字显示，
   * 并在块边界按该块状态切换立绘（立绘随状态切换保留、不降级）。
   */
  const playLoop = async () => {
    if (isPlayingRef.current) return
    const next = audioQueueRef.current.shift()
    if (!next) return

    isPlayingRef.current = true
    usePetReadingStore.getState().setPlaying(true)
    // 方案A：语音进度上行（字符口径；播完时 spoken 一并推进）。
    // voiceTextFollowAudio=true（默认）：台词槽位（有音频）开播**不整块解锁**——早先在此上报
    // 槽位累计值，speaking 瞬间到达槽位末尾、插值区间清空（base==target，2026-10-15 21:03 轮
    // 日志全为 77/77、173/173、248/248），打字机（textSpeed）远快于语速，块内文本先于音频
    // 出屏（实锤："牛奶浴的"先于语音打出）。改为保持当前进度，由下方插值按播放比例推进到
    // 槽位末尾——文本严格跟随语音逐字放行。零时长旁白槽位无音频可插值，恒开播即解锁（旁白
    // 按序上屏语义，由文字显示速度打字）。
    // =false（用户选择按文字显示速度输出）：台词槽位开播整块解锁，文本由打字机按 textSpeed
    // 打出（可能快于语音播完，通用设置文案已说明）。每次消费槽位时读设置，切换下一轮生效。
    const followAudio = useSettingsStore.getState().settings.voiceTextFollowAudio !== false
    // 旁白打字债务等待（在台词槽位自身解锁前取值——followAudio=false 时本块的整块解锁不计入）：
    // 旁白在前一段语音播完后按 textSpeed 全速打字，语音等其（及前序未打完文本）结清才开播。
    // 起步余量补偿打字机启动管道延迟（解锁→setState→渲染→Typewriter 启动，2026-10-17 19:20
    // 轮实锤：3 段前导旁白打完时间恰与债务等长，起步延迟导致语音开播时旁白还剩最后几个字）。
    // 仅在存在未结清债务时追加（+400ms），无旁白轮次零开销。
    const pendingTypingWait = Math.max(0, revealDueAtRef.current - Date.now())
    const narrTypingWaitMs = pendingTypingWait > 0 ? pendingTypingWait + 400 : 0
    if (next.buffer === null || !followAudio) reportProgress(next.cumChars, false)
    if (next.buffer !== null && narrTypingWaitMs > 0) {
      // 语音在前一段旁白（及前序未打完文本）输出完后才能开始输出（用户规则，2026-10-16 01:55
      // 轮实锤：7 段长旁白打字滞后，尾字与后续语音文本混流）；等待期间旁白文本正在全速打出
      const roundAtWait = speechRoundRef.current
      await new Promise((r) => setTimeout(r, narrTypingWaitMs))
      if (speechRoundRef.current !== roundAtWait) {
        // 等待期间发生新一轮/终止清场：丢弃本槽位（队列已被 resetSpeech 清空）
        isPlayingRef.current = false
        usePetReadingStore.getState().setPlaying(false)
        void playLoop()
        return
      }
    }
    // 播放进度插值：按音频实际播放进度持续上行字符进度，文本严格跟随语音——
    // 取代早先的"块级一次性放行 + 尾字 MAX"：块开播即放行整块文本、打字机速度快于
    // 语音时长，最后一句话的文本会先于语音播完（2026-10-15 02:02 轮实锤）。
    // 插值目标 = **本槽位自身的累计值**（本块文本随本块音频逐步放行）；
    // 最后一个槽位（队列已空）且文本已生成完 → 文档总量（吸收槽位/分段两条记账链的
    // 口径差，尾字在音频结束时刚好打完）。早先误用"下一槽位的累计值"当目标——
    // displayOnly 旁白槽位零时长消费瞬间就把进度跳进下一个台词块，其文本在音频
    // 还在合成时就全部可揭示（2026-10-15 02:44 轮实锤：文本先于语音 39s）。
    // 尚未消费的槽位检测：音频队列 + 待合成队列均空 = 当前是最后一个槽位。
    // 还须排除"合成中"——合成中的槽位已被 shift 出 textQueue、尚未 push 进 audioQueue，
    // 两条队列都看不见它；漏判会把当前槽位（常为零时长旁白）误当最后槽位，
    // target 直取文档总量且 spoken 一并落地 → 后续台词的文本在语音还在合成时就被整体放行
    // （2026-10-15 04:18 轮实锤："……再给我最后十秒"文本提前 12s 上屏，其语音 04:18:44 才开播）。
    const peekNextCum = (): number | null => audioQueueRef.current[0]?.cumChars ?? textQueueRef.current[0]?.cumChars ?? null
    const isLastSlot = peekNextCum() === null && !isSynthesizingRef.current
    const docNow = useTurnDocStore.getState().doc
    const docTotal = docNow ? docNow.segments.reduce((n, s) => n + s.text.length, 0) + docNow.trailing.length : 0
    const turnComplete = !useSessionStore.getState().streaming
    const targetChars = isLastSlot && turnComplete ? Math.max(next.cumChars ?? 0, docTotal) : (next.cumChars ?? 0)
    const baseChars = Math.min(lastProgressCharsRef.current, targetChars)
    let progressTimer: ReturnType<typeof setInterval> | null = null
    if (next.buffer !== null) {
      // 插值诊断日志：每个真实音频槽位都打一行，验证"目标=本槽位累计值/最后槽位=文档总量"的
      // 插值语义是否生效（早先仅在 target>base 时打——误判轮 base==target 完全静默无法观测）
      console.log('[pet] 播放插值：base=%d target=%d 最后槽=%s 文本完=%s 合成中=%s 槽位累计=%d', baseChars, targetChars, isLastSlot, turnComplete, isSynthesizingRef.current, next.cumChars ?? 0)
      if (targetChars > baseChars) {
        progressTimer = setInterval(() => {
          const p = stageRef.current?.getPlayProgress() ?? 1
          reportProgress(Math.round(baseChars + (targetChars - baseChars) * Math.min(1, Math.max(0, p))), false)
        }, 250)
      }
    }
    try {
      // 块边界：切立绘到该块状态（每个状态变化处都切换，一个不丢；旁白槽位 index=null 不切）
      if (next.index !== null) {
        stageRef.current?.setEmotion(next.emotion)
      }
      // 段随语音：该段语音开始播放时，把该段完整文本追加进朗读显示，打字机随后流式打出
      if (usePetReadingStore.getState().mode === 'follow' && next.text) {
        usePetReadingStore.getState().appendText(next.text, next.kind)
      }
      // 零时长槽位（displayOnly 纯旁白）：无音频可播，立即让位下一段——
      // 效果是旁白文本严格插在前后语音块之间按序上屏
      if (next.buffer !== null) {
        await stageRef.current?.speak(next.buffer)
      }
      // 播完回报：推进到插值目标（spoken 下限；最后一个槽位含文档总量口径差）
      reportProgress(targetChars, true)
    } catch (err) {
      console.error('[pet] TTS 播放失败', err)
      // 播放失败段同样推进进度（视作已消费），否则门控卡死
      reportProgress(targetChars, true)
    } finally {
      if (progressTimer) clearInterval(progressTimer)
      isPlayingRef.current = false
      // 继续播放下一段（如果队列中还有）；队列暂空时仅做收尾检查——
      // 生成未结束（后续语音块在路上）时保持跟读状态与已读文本，块间清场会导致
      // 跟读气泡清空/两窗不同步（见 maybeFinalizeReading 注释）
      if (audioQueueRef.current.length > 0) {
        void playLoop()
      } else {
        maybeFinalizeReading()
        // 方案A：本轮语音/旁白槽位全部消费完（合成队列也已排空）→ 上行 reading 收尾，
        // 主进程把文档推到 done（聊天窗/宠物窗据此落定型、光标消失）。
        // 条件：合成队列空（没有还在路上的语音块）且流式已结束（不会再有新块投放）。
        const tid = turnCoordinatorIdRef.current
        if (tid && textQueueRef.current.length === 0 && !isSynthesizingRef.current && !useSessionStore.getState().streaming) {
          api.ai.reportTurnReadingDone(tid)
        }
      }
    }
  }

  // 生成结束（stream-done → streaming 翻假）时补一次朗读收尾检查：
  // 最后一段语音常在流式结束后仍在合成/播放，播放循环里的收尾检查会因 streaming=true 跳过，
  // 若没有这里补触发，跟读气泡与隐藏门会一直挂着，定型消息无法上屏。
  // 同时补一次 reading 收尾上行：若全部语音在流式结束前就播完，各 finally 里的收尾上行都因
  // 当时 streaming=true 被跳过，回合会挂到 90s 看门狗才落定（边界补漏）。
  useEffect(() => useSessionStore.subscribe((s, prev) => {
    if (prev.streaming && !s.streaming) {
      maybeFinalizeReading()
      const tid = turnCoordinatorIdRef.current
      if (tid && textQueueRef.current.length === 0 && audioQueueRef.current.length === 0 && !isSynthesizingRef.current && !isPlayingRef.current) {
        api.ai.reportTurnReadingDone(tid)
      }
    }
  }), [])

  // 方案A语音链工作心跳：合成/播放进行中每 15s 上行一次 ping，喂主进程 reading 看门狗——
  // 慢合成（Genie 翻译偶发数分钟）不再被"进度停滞 90s"误判为链路死亡而强制落定
  // （强制落定会让两窗文本提前放行、语音迟到才播，2026-10-14 20:30 轮实锤）。
  // 链路真灭（无队列活动、无进度、无心跳）时看门狗照常兜底。
  useEffect(() => {
    const PING_INTERVAL_MS = 15_000
    const timer = setInterval(() => {
      const tid = turnCoordinatorIdRef.current
      if (!tid) return
      const busy =
        isSynthesizingRef.current ||
        isPlayingRef.current ||
        textQueueRef.current.length > 0 ||
        audioQueueRef.current.length > 0
      if (busy) api.ai.reportTurnReadingPing(tid)
    }, PING_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [])

  // 订阅"说话"事件：聊天窗口流式完成后触发，按主进程拆好的合成分段（dialogue 逐项）段级合成播放。
  // displayOnly=true 的块是纯旁白（（）描写）：不合成不发声，推一个 buffer=null 的零时长槽位
  // 进音频队列——由播放循环按序消费，保证旁白严格按语音顺序上屏（消灭旧版整块丢弃导致的
  // "（）输出时缺失、结束后才补进气泡"，2026-10-13 日志 4 例实锤）。
  useEffect(() => {
    const unsub = api.pet.onSpeak((payload) => {
      const { text, voiceId, languageOverride, chunks, follow, engine, genieOverride, displayOnly, ttsSpeed } = payload ?? {}
      if (!text?.trim()) return
      console.log(`[sync] pet onSpeak text=${text.slice(0, 16)} chunks=${chunks?.length ?? 0} engine=${engine ?? '?'} displayOnly=${!!displayOnly}`)
      const isFollow = follow === true
      // 仅"跟读文本"开启时用段落跟读气泡（段随语音，active 置真）；
      // 关闭跟读时语音在整段文本生成后播放，不改文本展示（保持流式打字机，active 不置真）
      if (isFollow) {
        usePetReadingStore.getState().setMode('follow')
        // 新一轮清理已由 onVoiceMode（流式开始）负责：此处不再 clearText——
        // 开头旁白前置流（ai:stream-narration）先于首个 speak 到达，此处清空会丢已上屏的旁白
        usePetReadingStore.getState().setActive(true)
      }
      // displayOnly 纯旁白块：不进音频队列（会越过"正在合成中的台词"造成顺序错乱，
      // 实测顺序 narr1→narr2→speak1→speak2），改进 textQueue 串行排队——
      // 由 synthesizeLoop 消费（narr 分支直接上屏不合成），严格排在未完成合成的台词之后
      if (displayOnly) {
        const t = text.trim()
        textQueueRef.current.push({
          text: t,
          voiceId: null,
          languageOverride: null,
          index: null,
          emotion: '平静',
          kind: 'narr',
          cumChars: takeProgressChars(t.length),
          speed: ttsSpeed ?? null,
        })
        void synthesizeLoop()
        return
      }
      const list: Array<{ text: string; emotion: string; kind?: 'speak' | 'narr' }> = chunks && chunks.length > 0
        ? chunks
        : [{ text: text.trim(), emotion: BUILTIN_DEFAULT_EMOTION }]
      const items = list
        .map((c) => ({ text: (c.text ?? '').trim(), emotion: c.emotion ?? BUILTIN_DEFAULT_EMOTION, kind: c.kind }))
        .filter((c) => c.text.length > 0)
        .map((c, i) => ({
          text: c.text,
          voiceId,
          languageOverride: languageOverride ?? null,
          index: chunks && chunks.length > 0 ? i : null,
          emotion: c.emotion,
          kind: c.kind,
          engine,
          genieOverride: genieOverride ?? null,
          cumChars: 0,
          speed: ttsSpeed ?? null,
        }))
      if (items.length === 0) return
      // 入队即分配累计字符数（同一 speak 块的所有合成分段共享该块的累计值——进度按块放行）
      for (const it of items) {
        it.cumChars = takeProgressChars(it.text.length)
      }
      textQueueRef.current.push(...items)
      void synthesizeLoop()
      void playLoop()
    })
    return unsub
  }, [])

  // 「开头括号旁白前置」流已退役：新契约下旁白是独立 narr 段，随语音零时长槽位按序上屏
  // （主进程 flushPendingBlock displayOnly），不再有独立前置通道。保留空订阅注释占位说明。

  // 流式开始时订阅本轮语音模式：有语音时用段落跟读打字，无语音时走流式打字机整段流式输出。
  // 注意：这里只切 mode 并清空文本，不让 active 直接为真——active 反映"语音真正开始朗读"，
  // 由 onSpeak（语音块实际调度）接管置真，避免 LLM 生成快于语音时先露出整段再消失。
  useEffect(() => api.pet.onVoiceMode(({ voiceEnabled }) => {
    const st = usePetReadingStore.getState()
    st.setMode(voiceEnabled ? 'follow' : 'typewriter')
    // 新一轮开始：立即清空已显示文本（不等流式开始），避免上一轮残留文本被透给聊天窗
    st.clearText()
    // 方案A：字符进度游标归零（新回合从 0 重新累计）
    resetProgressCursor()
  }), [])

  // 本轮 AI 请求出错 / 主动终止：重置朗读流程态（结束"待输出"光标），并清掉未播的语音队列，
  // 避免被终止的旧声音继续播放（易被误听为杂音/残留）
  useEffect(() => api.ai.onStreamError(() => {
    usePetReadingStore.getState().reset()
    resetSpeech()
    resetProgressCursor()
  }), [])

  // 【方案A第3步：旧镜像链退役】朗读 store 不再向聊天窗二手转发（reading-text/segments/
  // active/done 四通道退役）——聊天窗直接消费 turnDocStore 快照，朗读进度经
  // ai:turn-speaking/spoken 上行进文档后随快照分发（见 PetContentList/PetContentList 快照消费）。
  // 保留：朗读结束下降沿清理本地 streamingContent（宠物窗自身定型切换仍需要）。

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    const factor = e.deltaY < 0 ? 1.1 : 0.9
    stageRef.current?.zoom(factor)
    setScalePct(Math.round((stageRef.current?.getScale() ?? 1) * 100))
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    hideTimerRef.current = setTimeout(() => setScalePct(null), 900)
  }

  /** 右键全局菜单已删除（2026-10-17）：功能与快捷按钮冗余，右键语义让给消息级菜单
   *  （消息重答：右键最后一轮气泡 → 编辑并重发/重新回答，见 PetContentList/MessageList） */

  /** 打开聊天窗口并进入当前会话：快捷按钮统一入口（无会话时回退默认聊天窗） */
  const openChatWithCurrentSession = () => {
    const sid = useSessionStore.getState().currentSessionId
    if (sid) api.app.openChatWithSession(sid)
    else api.app.openChat()
  }

  return (
    <div
      style={{ width: PET_W, height: MODEL_H + INPUT_H }}
      className="app-drag relative overflow-hidden"
      onWheel={onWheel}
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
        <PetQuickButton title="打开聊天" onClick={openChatWithCurrentSession}>
          <MessageSquare size={14} strokeWidth={1.75} />
        </PetQuickButton>
        <PetQuickButton title="打开设置" onClick={() => api.app.openSettings()}>
          <Settings size={14} strokeWidth={1.75} />
          <PendingMemoryBadge />
        </PetQuickButton>
        <PetQuickButton title="退出应用" onClick={() => api.app.quit()}>
          {/* hover 变红（退出语义）：group-hover 覆盖按钮的 hover:text-text */}
          <LogOut size={14} strokeWidth={1.75} className="group-hover:!text-danger" />
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

      {/* 右键全局菜单已删除；退出/聊天/设置均走右上角快捷按钮 */}
    </div>
  )
}

function PetQuickButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="glass-strong group relative flex h-8 w-8 items-center justify-center rounded-full text-text-2 transition-colors hover:text-text hover:shadow-[0_0_10px_var(--primary-glow)]"
    >
      {children}
    </button>
  )
}
