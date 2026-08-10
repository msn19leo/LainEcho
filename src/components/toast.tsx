/**
 * 轻量 toast 通知。
 * 用法：toast('已保存') / toast('删除失败', 'error')；在根组件挂载 <Toaster/>。
 */
import { useEffect } from 'react'
import { create } from 'zustand'
import { cn } from '../lib/utils'

type ToastType = 'success' | 'error' | 'info'

interface ToastItem {
  id: number
  message: string
  type: ToastType
}

interface ToastState {
  items: ToastItem[]
  push: (message: string, type: ToastType) => void
  dismiss: (id: number) => void
}

let toastId = 0

export const useToastStore = create<ToastState>((set) => ({
  items: [],
  push: (message, type) => {
    const id = ++toastId
    set((s) => ({ items: [...s.items, { id, message, type }] }))
    setTimeout(() => {
      set((s) => ({ items: s.items.filter((i) => i.id !== id) }))
    }, 3200)
  },
  dismiss: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
}))

export function toast(message: string, type: ToastType = 'success') {
  useToastStore.getState().push(message, type)
}

export function Toaster() {
  const { items, dismiss } = useToastStore()

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // 关闭最上层 toast
        const last = items[items.length - 1]
        if (last) dismiss(last.id)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [items, dismiss])

  return (
    <div className="pointer-events-none fixed bottom-5 left-1/2 z-[999] flex -translate-x-1/2 flex-col items-center gap-2">
      {items.map((item) => (
        <button
          key={item.id}
          onClick={() => dismiss(item.id)}
          className={cn(
            'pointer-events-auto rounded-lg px-4 py-2 text-sm shadow-lg backdrop-blur transition',
            item.type === 'success' && 'bg-[#16a34a]/90 text-white',
            item.type === 'error' && 'bg-[#dc2626]/90 text-white',
            item.type === 'info' && 'bg-[#1e222b]/95 text-text border border-border',
          )}
        >
          {item.message}
        </button>
      ))}
    </div>
  )
}
