/**
 * toast 通知（sonner 实现）。
 * 用法：toast('已保存') / toast('删除失败', 'error')；在根组件挂载 <Toaster/>。
 * 视觉由 sonner 内置 spring 进出场 + index.css 中的主题变量覆盖统一。
 */
import { useEffect, useState } from 'react'
import { toast as sonnerToast, Toaster as SonnerToaster } from 'sonner'

type ToastType = 'success' | 'error' | 'info'

export function toast(message: string, type: ToastType = 'success') {
  if (type === 'success') sonnerToast.success(message)
  else if (type === 'error') sonnerToast.error(message)
  else sonnerToast(message)
}

/** 跟随 <html data-theme> 切换 sonner 内置主题 */
function useResolvedTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
  )
  useEffect(() => {
    const el = document.documentElement
    const update = () => setTheme(el.dataset.theme === 'light' ? 'light' : 'dark')
    update()
    const mo = new MutationObserver(update)
    mo.observe(el, { attributes: true, attributeFilter: ['data-theme'] })
    return () => mo.disconnect()
  }, [])
  return theme
}

export function Toaster() {
  const theme = useResolvedTheme()
  return (
    <SonnerToaster
      theme={theme}
      position="bottom-center"
      closeButton
      toastOptions={{ duration: 3200 }}
      gap={8}
      offset={20}
    />
  )
}
