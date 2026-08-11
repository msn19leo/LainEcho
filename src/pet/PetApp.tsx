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
import { useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { LogOut, MessageSquare, Settings } from 'lucide-react'
import { api } from '../api'
import { PositionedMenu, type MenuItem } from '../components/DropdownMenu'
import { PetStage, type PetStageHandle } from './PetStage'

/** 桌宠窗口固定尺寸（与主进程 PET_WIDTH/PET_HEIGHT 保持一致）。
 *  用固定像素而非 h-full/w-full：Windows 透明窗口拖动时 CSS 布局尺寸会被报告失真，
 *  百分比尺寸会跟着变大。钉死像素则完全不受影响。 */
const PET_SIZE = { width: 380, height: 440 }

interface MenuPos {
  x: number
  y: number
}

export default function PetApp() {
  const stageRef = useRef<PetStageHandle>(null)
  const [menu, setMenu] = useState<MenuPos | null>(null)
  const [scalePct, setScalePct] = useState<number | null>(null)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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
      <div className="app-no-drag absolute right-2 top-2 flex items-center gap-1.5">
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
            className="app-no-drag pointer-events-none absolute bottom-2 right-2 rounded-full border border-[var(--border-strong)] bg-[var(--bg-panel)]/90 px-2.5 py-1 text-xs font-medium text-text shadow-[var(--shadow-card)] backdrop-blur"
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
