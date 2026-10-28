/**
 * 聊天图片缩略图。
 *
 * 统一处理"文件已不在"的降级：原图保留期到期被清理、或路径失效时，
 * 退化为 [图片] 占位芯片，避免历史消息里出现碎图标。
 * 输入区附件预览与消息气泡共用本组件，两处降级行为保持一致。
 */
import { useState } from 'react'
import { api } from '../api'
import type { ChatImage } from '../types'

interface ChatImageThumbProps {
  image: ChatImage
  /** 尺寸类（宽高由调用方决定；占位芯片与图片对齐） */
  sizeClass?: string
  onClick?: () => void
}

export function ChatImageThumb({ image, sizeClass = 'h-28 w-28', onClick }: ChatImageThumbProps) {
  const [broken, setBroken] = useState(false)

  if (broken) {
    return (
      <div
        className={`flex shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-border bg-surface-2 text-[11px] text-text-muted ${sizeClass}`}
      >
        [图片]
      </div>
    )
  }

  return (
    <img
      src={api.chat.imageUrl(image.path)}
      alt=""
      className={`shrink-0 rounded-[var(--radius-sm)] object-cover ${onClick ? 'cursor-zoom-in' : ''} ${sizeClass}`}
      onClick={onClick}
      onError={() => setBroken(true)}
    />
  )
}
