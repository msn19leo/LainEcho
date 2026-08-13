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

/** 桌宠窗口固定尺寸（与主进程 PET_WIDTH/PET_HEIGHT 保持一致）。
 *  用固定像素而非 h-full/w-full：Windows 透明窗口拖动时 CSS 布局尺寸会被报告失真，
 *  百分比尺寸会跟着变大。钉死像素则完全不受影响。 */
const PET_SIZE = { width: 300, height: 440 }

interface MenuPos {
  x: number
  y: number
}

export default function PetApp() {
  const stageRef = useRef<PetStageHandle>(null)
  const [menu, setMenu] = useState<MenuPos | null>(null)
  const [scalePct, setScalePct] = useState<number | null>(null)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ============ TTS 双队列架构 ============
  // 合成和播放完全解耦：合成循环持续从文本队列取句合成，
  // 播放循环持续从音频队列取音频播放。两条流水线并行运行。
  // 效果：播放第 1 句时，合成循环已在合成第 2 句 → 句间几乎无间隔。
  // 旧串行架构间隔 = 合成时间 + 播放时间；新架构间隔 ≈ max(合成时间, 播放时间)。

  /** 待合成的文本队列（入队顺序 = 播放顺序） */
  const textQueueRef = useRef<Array<{ text: string; voiceId: string; languageOverride: import('../types').TTSLanguage | null }>>([])
  /** 已合成待播放的音频队列 */
  const audioQueueRef = useRef<Array<ArrayBuffer>>([])
  /** 合成锁：同时只合成一句，避免 MiMo API 并发请求 */
  const isSynthesizingRef = useRef(false)
  /** 播放锁：同时只播放一段音频，避免叠加 */
  const isPlayingRef = useRef(false)

  /**
   * 合成循环：从文本队列取一句合成，结果放入音频队列。
   * 合成完成后继续合成下一句（如果队列中还有），实现预合成。
   */
  const synthesizeLoop = async () => {
    if (isSynthesizingRef.current) return
    const next = textQueueRef.current.shift()
    if (!next) return

    isSynthesizingRef.current = true
    try {
      const audio = await api.tts.synthesize({ text: next.text, voiceId: next.voiceId, languageOverride: next.languageOverride })
      if (audio) {
        audioQueueRef.current.push(audio)
        // 有新音频了，尝试触发播放
        void playLoop()
      }
    } catch (err) {
      console.error('[pet] TTS 合成失败', err)
    } finally {
      isSynthesizingRef.current = false
      // 继续合成下一句（预合成），不等播放
      if (textQueueRef.current.length > 0) {
        void synthesizeLoop()
      }
    }
  }

  /**
   * 播放循环：从音频队列取一段播放，播放完成后继续播放下一段。
   * 与合成循环并行运行，互不阻塞。
   */
  const playLoop = async () => {
    if (isPlayingRef.current) return
    const next = audioQueueRef.current.shift()
    if (!next) return

    isPlayingRef.current = true
    try {
      await stageRef.current?.speak(next)
    } catch (err) {
      console.error('[pet] TTS 播放失败', err)
    } finally {
      isPlayingRef.current = false
      // 继续播放下一段（如果队列中还有）
      if (audioQueueRef.current.length > 0) {
        void playLoop()
      }
    }
  }

  // 订阅"说话"事件：聊天窗口流式分句触发，入文本队列并启动合成+播放流水线
  useEffect(() => {
    const unsub = api.pet.onSpeak((payload) => {
      const { text, voiceId, languageOverride } = payload ?? {}
      if (!voiceId || !text?.trim()) return
      textQueueRef.current.push({ text: text.trim(), voiceId, languageOverride: languageOverride ?? null })
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
      style={{ width: PET_SIZE.width, height: PET_SIZE.height }}
      className="app-drag relative overflow-hidden"
      onWheel={onWheel}
      onContextMenu={onContextMenu}
    >
      <PetStage stageRef={stageRef} onStatus={() => {}} />

      {/* 原生拖动区域不接收鼠标事件，聊天/设置改为右上角 no-drag 小按钮 */}
      <div className="app-no-drag absolute right-2 top-2 flex items-center gap-2">
        <PetQuickButton title="打开聊天" onClick={() => api.app.openChat()}>
          <MessageSquare size={14} strokeWidth={1.75} />
        </PetQuickButton>
        <PetQuickButton title="打开设置" onClick={() => api.app.openSettings()}>
          <Settings size={14} strokeWidth={1.75} />
        </PetQuickButton>
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
