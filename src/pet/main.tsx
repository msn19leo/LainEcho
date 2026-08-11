import { createRoot } from 'react-dom/client'
import '../index.css'
import PetApp from './PetApp'
import { initTheme } from '../lib/theme'

initTheme()

// 诊断：把未捕获异常/未处理的 Promise 拒绝（含调用栈）转发到主进程终端
window.addEventListener('error', (e) => {
  console.error('[pet-error]', e.message, (e.error && (e.error.stack || e.error)) || '')
})
window.addEventListener('unhandledrejection', (e) => {
  console.error('[pet-rejection]', (e.reason && (e.reason.stack || e.reason)) || String(e.reason))
})

document.body.classList.add('pet-body')
document.body.style.overflow = 'hidden'

createRoot(document.getElementById('root')!).render(<PetApp />)
