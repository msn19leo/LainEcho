/**
 * 图片全屏查看（lightbox）。
 *
 * 项目原本没有该组件：气泡内缩略图与输入区附件预览共用同一个查看器。
 * 点击遮罩或按 Esc 关闭；点击图片本身不关闭（避免误触）。
 */
import { useEffect } from 'react'
import { X } from 'lucide-react'

interface LightboxProps {
  /** 图片地址（pet-res:// 或普通 URL） */
  src: string
  onClose: () => void
}

export function Lightbox({ src, onClose }: LightboxProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-6 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <button
        type="button"
        onClick={onClose}
        title="关闭"
        className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full bg-black/50 text-white transition-colors hover:bg-black/70"
      >
        <X size={16} strokeWidth={2} />
      </button>
      <img
        src={src}
        alt=""
        className="max-h-full max-w-full cursor-zoom-out rounded-[var(--radius-md)] object-contain shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  )
}
