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
import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { LogOut, MessageSquare, Settings } from 'lucide-react'
import { api } from '../api'
import { PositionedMenu, type MenuItem } from '../components/DropdownMenu'
import { PetStage, type PetStageHandle } from './PetStage'
import { PetMiniChat } from './PetMiniChat'
import { PetInput } from './PetInput'
import { bindPersistentSessionSync, useSessionStore } from '../store/sessionStore'
import { useCharacterStore } from '../store/characterStore'
import { DEFAULT_EMOTION, type StandardEmotion } from '../types'
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
  /** 迷你会话内容框：初始收起；展开高度可拖调（左上角角标）。状态持久化，重启恢复 */
  const [contentOpen, setContentOpen] = useState<boolean>(() => {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}').open ?? false
    } catch {
      return false
    }
  })
  const [contentH, setContentH] = useState<number>(() => {
    try {
      const h = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}').height
      return typeof h === 'number' && h >= 90 && h <= 320 ? h : CONTENT_H
    } catch {
      return CONTENT_H
    }
  })
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 宠物窗侧会话同步：只持久订阅 AI 流式/完成事件；初始为空，跟随聊天窗广播的当前会话，
  // 不主动加载"最近会话"（聊天窗为空时宠物窗也为空）
  useEffect(() => {
    // 宠物窗自己的 renderer 有独立的 characterStore：先加载角色卡列表，
    // 保证内容框名牌/头部能显示当前角色名（否则恒为 AI 兜底）
    void useCharacterStore.getState().load()
    return bindPersistentSessionSync()
  }, [])

  // 跟随聊天窗切换/新建会话：收到当前会话 id 时加载对应消息到宠物窗内容框；null 表示清空
  useEffect(() => api.pet.onCurrentSessionChanged((id) => {
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
        useSessionStore.setState({ currentSessionId: id, messages: detail.messages, streaming: false, streamingContent: '' })
        // 会话绑定的角色卡 → 设为当前卡，名牌显示其名字
        if (detail.characterCardId) {
          useCharacterStore.setState({ currentCardId: detail.characterCardId })
        }
      } catch {
        // 加载失败不阻塞
      }
    })()
  }), [])

  // 用户发送了消息：若内容框处于收起状态则主动展开
  useEffect(() => {
    const unsub = useSessionStore.subscribe((state, prev) => {
      if (!prev.streaming && state.streaming) setContentOpen(true)
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
  const textQueueRef = useRef<Array<{ text: string; voiceId: string; languageOverride: import('../types').TTSLanguage | null; index: number | null; emotion: StandardEmotion }>>([])
  /** 已合成待播放的音频队列（附带对应分段索引与情绪） */
  const audioQueueRef = useRef<Array<{ buffer: ArrayBuffer; index: number | null; emotion: StandardEmotion }>>([])
  /** 合成锁：同时只合成一段，避免 MiMo API 并发请求 */
  const isSynthesizingRef = useRef(false)
  /** 播放锁：同时只播放一段音频，避免叠加 */
  const isPlayingRef = useRef(false)

  /**
   * 合成循环：从文本队列取一个合成分段合成音频（携带分段索引与情绪）放入音频队列，串行不并发。
   */
  const synthesizeLoop = async () => {
    if (isSynthesizingRef.current) return
    const next = textQueueRef.current.shift()
    if (!next) return

    isSynthesizingRef.current = true
    try {
      // 合成前剥离心理/动作旁白（括号内容），只朗读台词
      const speakText = stripBrackets(next.text)
      // 整段只剩括号旁白（被剥空）：跳过该段，不合成、不产生音频，避免空文本报错
      if (!speakText) return
      const audio = await api.tts.synthesize({ text: speakText, voiceId: next.voiceId, languageOverride: next.languageOverride })
      if (audio) {
        audioQueueRef.current.push({ buffer: audio, index: next.index, emotion: next.emotion })
        // 有新音频了，尝试触发播放
        void playLoop()
      }
    } catch (err) {
      console.error('[pet] TTS 合成失败', err)
    } finally {
      isSynthesizingRef.current = false
      // 继续合成下一段（预合成），不等播放
      if (textQueueRef.current.length > 0) {
        void synthesizeLoop()
      }
    }
  }

  /**
   * 播放循环：取出音频播放；分段索引非空时上报段级高亮，并按该段情绪切换立绘。
   */
  const playLoop = async () => {
    if (isPlayingRef.current) return
    const next = audioQueueRef.current.shift()
    if (!next) return

    isPlayingRef.current = true
    try {
      if (next.index !== null) {
        api.pet.reportChunkActive(next.index)
        stageRef.current?.setEmotion(next.emotion)
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
        // 全部段落播放完毕（无待合成、无待播）：清空高亮，避免停在最后一段
        api.pet.reportChunkActive(null)
      }
    }
  }

  // 订阅"说话"事件：聊天窗口流式完成后触发，按主进程拆好的合成分段（dialogue 逐项）段级合成播放
  useEffect(() => {
    const unsub = api.pet.onSpeak((payload) => {
      const { text, voiceId, languageOverride, chunks } = payload ?? {}
      if (!voiceId || !text?.trim()) return
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
        }))
      if (items.length === 0) return
      textQueueRef.current.push(...items)
      void synthesizeLoop()
      void playLoop()
    })
    return unsub
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
        </PetQuickButton>
      </div>

      {/* 收起态：右下角胶囊唤起会话 */}
      {!contentOpen && (
        <div className="app-no-drag absolute bottom-10 right-2 z-50">
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
        <PetInput />
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
      className="glass-strong flex h-8 w-8 items-center justify-center rounded-full text-text-2 transition-colors hover:text-text hover:shadow-[0_0_10px_var(--primary-glow)]"
    >
      {children}
    </button>
  )
}
