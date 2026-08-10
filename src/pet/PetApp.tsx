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
 */
import { useRef, useState } from 'react'
import { api } from '../api'
import { PetStage, type PetStageHandle } from './PetStage'

/** 桌宠窗口固定尺寸（与主进程 PET_WIDTH/PET_HEIGHT 保持一致）。
 *  用固定像素而非 h-full/w-full：Windows 透明窗口拖动时 CSS 布局尺寸会被报告失真，
 *  百分比尺寸会跟着变大。钉死像素则完全不受影响。 */
const PET_SIZE = { width: 380, height: 440 }

export default function PetApp() {
  const stageRef = useRef<PetStageHandle>(null)
  const [, setStatus] = useState<string>('loading')

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    const factor = e.deltaY < 0 ? 1.1 : 0.9
    stageRef.current?.zoom(factor)
  }

  return (
    <div
      style={{ width: PET_SIZE.width, height: PET_SIZE.height }}
      className="app-drag relative overflow-hidden"
      onWheel={onWheel}
    >
      <PetStage stageRef={stageRef} onStatus={(s) => setStatus(s)} />

      {/* 原生拖动区域不接收鼠标事件，聊天/设置改为右上角 no-drag 小按钮 */}
      <div className="app-no-drag absolute right-2 top-2 flex items-center gap-1.5">
        <button
          title="打开聊天"
          onClick={() => api.app.openChat()}
          className="flex h-7 w-7 items-center justify-center rounded-full border border-border bg-panel/80 text-[13px] text-text-2 backdrop-blur transition hover:border-border-strong hover:text-text"
        >
          💬
        </button>
        <button
          title="打开设置"
          onClick={() => api.app.openSettings()}
          className="flex h-7 w-7 items-center justify-center rounded-full border border-border bg-panel/80 text-[13px] text-text-2 backdrop-blur transition hover:border-border-strong hover:text-text"
        >
          ⚙
        </button>
      </div>
    </div>
  )
}
