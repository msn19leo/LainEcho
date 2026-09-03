/**
 * 宠物窗会话内容框（展开态卡片）：
 * - 自带背景、小圆角；展示完整会话记录（用户 + AI 名牌/角色色 + 当前段逐字）。
 * - 左上角角标拖高（仅上下）；头部右侧收放按钮（收起）。
 * - 收起后由 PetApp 渲染小胶囊唤起，本组件不渲染窄条。
 */
import { useEffect, useRef } from 'react'
import { ChevronUp } from 'lucide-react'
import { useCharacterStore } from '../store/characterStore'
import { PetContentList } from './PetContentList'

const MIN_H = 90
const MAX_H = 320

interface PetMiniChatProps {
  contentH: number
  onToggle: () => void
  onResize: (h: number) => void
}

export function PetMiniChat({ contentH, onToggle, onResize }: PetMiniChatProps) {
  const dragRef = useRef<{ startY: number; startH: number } | null>(null)
  // 当前角色名（头部提示文字用）
  const cards = useCharacterStore((s) => s.cards)
  const currentCardId = useCharacterStore((s) => s.currentCardId)
  const charName = cards.find((c) => c.id === currentCardId)?.name ?? 'AI'

  // 左上角角标拖拽：向下拖=变高、向上拖=变矮（仅上下方向）
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    dragRef.current = { startY: e.clientY, startH: contentH }
  }
  useEffect(() => {
    const onMove = (ev: PointerEvent) => {
      if (!dragRef.current) return
      const dh = dragRef.current.startH + (ev.clientY - dragRef.current.startY)
      onResize(Math.min(MAX_H, Math.max(MIN_H, dh)))
    }
    const onUp = () => {
      dragRef.current = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [onResize])

  return (
    <div className="app-no-drag relative flex h-full flex-col overflow-hidden rounded-[8px] border border-[var(--border-strong)] bg-[var(--bg-panel)]/70 shadow-[var(--shadow-card)] backdrop-blur-[12px]">
      {/* 头部：左上角角标（拖高）+ 提示文字 + 右侧收放按钮 */}
      <div className="flex shrink-0 items-center justify-between pr-1 pt-0.5">
        <div className="flex items-center">
          <div
            className="-ml-0.5 h-4 w-4 cursor-row-resize select-none"
            style={{ touchAction: 'none' }}
            onPointerDown={onPointerDown}
            title="按住左上角上下拖动调整高度"
          >
            <div
              className="h-2 w-2 pointer-events-none"
              style={{ backgroundImage: 'linear-gradient(225deg, transparent 50%, var(--text-muted) 50%)' }}
            />
          </div>
          <span className="select-none truncate px-1 text-[11px] font-medium leading-[18px] text-text-muted">
            {`聊天会话（${charName}）`}
          </span>
        </div>
        <button
          type="button"
          onClick={onToggle}
          className="flex items-center gap-1 rounded-full border border-[var(--border-strong)] bg-[var(--bg-surface)]/80 px-2 py-0.5 text-[11px] font-medium text-text-muted transition-colors hover:text-text"
          title="收起会话"
        >
          <ChevronUp size={12} strokeWidth={1.75} />
          收起
        </button>
      </div>

      {/* 会话记录（用户 + AI，含流式逐字） */}
      <div className="min-h-0 flex-1">
        <PetContentList />
      </div>
    </div>
  )
}