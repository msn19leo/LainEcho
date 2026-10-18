import { createRoot } from 'react-dom/client'
import '../index.css'
import { EditorApp } from './EditorApp'
import { Toaster } from '../components/toast'
import { initTheme } from '../lib/theme'
import { setupLogForward } from '../lib/logForward'

initTheme()
setupLogForward('editor')

createRoot(document.getElementById('root')!).render(
  <>
    <EditorApp />
    <Toaster />
  </>,
)
