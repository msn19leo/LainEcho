/**
 * FloatingDock —— 窗口紧贴式浮动面板容器。
 *
 * 设计逻辑：
 *   - 窗口大小 = Dock 可视区域大小，Dock 始终从窗口客户区 (0,0) 开始布局。
 *   - 折叠态：窗口 56x56，仅显示头像小球；展开态：窗口 width x height。
 *   - 拖拽：拖拽头像 = 移动整个窗口（api.win.setPosition），无多余透明区拦截鼠标。
 *   - 展开/折叠：切换时调用 api.win.setSize 调整窗口大小。
 *   - 动效：展开/折叠用 scale + opacity 弹性曲线；GPU 加速 transform。
 *   - 毛玻璃：glass-strong + 24px 大圆角 + 主色光晕。
 *
 * 折叠按钮：通过 DockContext 暴露 collapse 方法，由 children（如顶栏）自行渲染按钮，
 * 避免 absolute 定位与顶栏按钮重叠。
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { AvatarRing } from './AvatarRing'
import { springElastic, tapPress, popIn } from '../lib/motion'
import { duration } from '../lib/tokens'
import { api } from '../api'

interface FloatingDockProps {
  /** 折叠态头像图源 */
  avatarSrc?: string | null
  /** 角色名（头像占位首字 + alt） */
  avatarName?: string
  /** 展开态面板内容（顶栏 / 消息流 / 输入框），垂直排列占满面板 */
  children: ReactNode
  /** 展开态面板宽度（px） */
  width?: number
  /** 展开态面板高度（px） */
  height?: number
  /** 初始是否展开 */
  defaultExpanded?: boolean
  /** 面板内覆盖层（如会话侧边栏），以 absolute 定位覆盖在主内容上面（不挤压）。
   *  面板为 absolute 定位上下文，overlay 用 absolute left-0 top-0 h-full 即可覆盖面板内左侧。 */
  overlay?: ReactNode
}

/** 拖拽与点击的位移阈值（px）：小于阈值视为点击 */
const DRAG_THRESHOLD = 4
/** 折叠态头像小球尺寸 */
const COLLAPSE_SIZE = 56

/** Dock 上下文：暴露折叠能力给 children（顶栏按钮等子组件通过 useDockCollapse 获取） */
const DockContext = createContext<{ collapse: () => void } | null>(null)

/** 从 Dock 内部获取折叠方法（供顶栏折叠按钮使用） */
export function useDockCollapse(): (() => void) | undefined {
  const ctx = useContext(DockContext)
  return ctx?.collapse
}

export function FloatingDock({
  avatarSrc,
  avatarName,
  children,
  width = 560,
  height = 600,
  defaultExpanded = true,
  overlay,
}: FloatingDockProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)

  /** 窗口当前屏幕位置缓存（拖拽用，避免 async getPosition 导致的跳变） */
  const winPosRef = useRef({ x: 0, y: 0 })

  /** 组件挂载时获取窗口初始位置 */
  useEffect(() => {
    void api.win.getPosition().then((pos) => {
      winPosRef.current = pos
    })
  }, [])

  /** 拖拽状态：记录鼠标屏幕坐标起点 + 窗口初始屏幕坐标（同步设置） */
  const dragState = useRef({
    dragging: false,
    startScreenX: 0,
    startScreenY: 0,
    startWinX: 0,
    startWinY: 0,
    moved: false,
    /** 上次 mousemove 的 screenX/Y，用于过滤窗口移动产生的合成事件 */
    lastScreenX: 0,
    lastScreenY: 0,
  })

  /** 展开/折叠切换时调整窗口大小 */
  useEffect(() => {
    const w = expanded ? width : COLLAPSE_SIZE
    const h = expanded ? height : COLLAPSE_SIZE
    void api.win.setSize(w, h)
  }, [expanded, width, height])

  /** 开始拖拽：同步记录鼠标屏幕坐标 + 缓存的窗口位置 */
  const onDragStart = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    const st = dragState.current
    st.dragging = true
    st.moved = false
    st.startScreenX = e.screenX
    st.startScreenY = e.screenY
    st.lastScreenX = e.screenX
    st.lastScreenY = e.screenY
    // 用缓存的窗口位置，避免 async 导致 startWinX/Y 为 0 的 bug
    st.startWinX = winPosRef.current.x
    st.startWinY = winPosRef.current.y
    e.preventDefault()
  }, [])

  /** 全局 mousemove/mouseup：拖拽时移动整个窗口 */
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const st = dragState.current
      if (!st.dragging) return
      // 过滤窗口移动产生的合成 mousemove 事件（screenX/Y 未变说明物理鼠标没动，
      // 是 setBounds 移动窗口后浏览器合成的，处理它会形成反馈循环导致窗口持续扩大）
      if (e.screenX === st.lastScreenX && e.screenY === st.lastScreenY) return
      st.lastScreenX = e.screenX
      st.lastScreenY = e.screenY
      const dx = e.screenX - st.startScreenX
      const dy = e.screenY - st.startScreenY
      if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) st.moved = true
      const newX = st.startWinX + dx
      const newY = st.startWinY + dy
      // 同步更新缓存，下次拖拽起点正确
      winPosRef.current = { x: newX, y: newY }
      void api.win.setPosition(newX, newY)
    }
    const onUp = () => {
      dragState.current.dragging = false
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  /** 头像点击：若刚拖拽过则不切换态，否则切换展开/折叠 */
  const onAvatarClick = useCallback(() => {
    if (dragState.current.moved) {
      dragState.current.moved = false
      return
    }
    setExpanded((v) => !v)
  }, [])

  /** 折叠方法（通过 Context 暴露给 children） */
  const collapse = useCallback(() => setExpanded(false), [])

  return (
    <div className="relative h-full w-full">
      {/* 头像小球（始终渲染，从窗口左上角 (0,0) 开始） */}
      <div className="pointer-events-auto absolute left-0 top-0" onMouseDown={onDragStart}>
        <AvatarRing
          src={avatarSrc}
          name={avatarName}
          size={COLLAPSE_SIZE}
          onClick={onAvatarClick}
          className="cursor-grab active:cursor-grabbing"
        />
      </div>

      {/* 展开态：毛玻璃面板，从头像右侧开始延展，占满窗口剩余区域
       *  布局：flex-col 垂直排列 children（顶栏 / 消息流 / 输入区），
       *  overlay 用 absolute 覆盖在主内容上面（不挤压主内容）。 */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="panel"
            initial={{ opacity: 0, scale: 0.92, transformOrigin: 'top left' }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.92, transformOrigin: 'top left' }}
            transition={{ duration: duration.base, ease: springElastic }}
            className="glass-strong glow-primary pointer-events-auto absolute left-[44px] top-0 flex flex-col overflow-hidden rounded-[var(--radius-lg)]"
            style={{ width: width - 44, height }}
          >
            {/* 通过 Context 暴露 collapse 给 children，由顶栏自行渲染折叠按钮 */}
            <DockContext.Provider value={{ collapse }}>
              {/* 主内容：顶栏 / 消息流 / 输入区，垂直排列占满面板 */}
              {children}

              {/* 面板内覆盖层（如会话侧边栏） —— absolute 覆盖在主内容上面，不挤压 */}
              {overlay}
            </DockContext.Provider>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/** 顶部拖拽手柄条（可放在面板顶部，扩展可拖拽区域） */
export function DockDragHandle({ onDoubleClick }: { onDoubleClick?: () => void }) {
  return (
    <motion.div
      whileTap={tapPress}
      className="app-drag flex h-3 shrink-0 items-center justify-center"
      onDoubleClick={onDoubleClick}
    >
      <span className="h-1 w-10 rounded-full bg-border-strong opacity-60" />
    </motion.div>
  )
}

/** 入场包裹：首次挂载时的弹性 popIn */
export function DockEnter({ children }: { children: ReactNode }) {
  return (
    <motion.div {...popIn} className="h-full w-full">
      {children}
    </motion.div>
  )
}
