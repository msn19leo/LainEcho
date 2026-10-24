import { createRoot } from 'react-dom/client'
import '../index.css'
import PetApp from './PetApp'
import { Toaster } from '../components/toast'
import { initTheme } from '../lib/theme'
import { setupLogForward } from '../lib/logForward'

initTheme()
setupLogForward('pet')

document.body.classList.add('pet-body')
document.body.style.overflow = 'hidden'

// Toaster：sessionStore.send 的 busy/前置拒绝回滚提示在宠物窗同样可见（PetInput 共用 send）
createRoot(document.getElementById('root')!).render(
  <>
    <PetApp />
    <Toaster />
  </>,
)
