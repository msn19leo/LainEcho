import { createRoot } from 'react-dom/client'
import '../index.css'
import { EditorApp } from './EditorApp'
import { Toaster } from '../components/toast'
import { initTheme } from '../lib/theme'

initTheme()

createRoot(document.getElementById('root')!).render(
  <>
    <EditorApp />
    <Toaster />
  </>,
)
