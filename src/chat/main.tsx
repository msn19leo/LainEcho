import { createRoot } from 'react-dom/client'
import '../index.css'
import { ChatWindow } from './ChatWindow'
import { Toaster } from '../components/toast'
import { initTheme } from '../lib/theme'

initTheme()

createRoot(document.getElementById('root')!).render(
  <>
    <ChatWindow />
    <Toaster />
  </>,
)
