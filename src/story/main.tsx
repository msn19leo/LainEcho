import { createRoot } from 'react-dom/client'
import '../index.css'
import { StoryApp } from './App'
import { Toaster } from '../components/toast'
import { initTheme } from '../lib/theme'
import { setupLogForward } from '../lib/logForward'

initTheme()
setupLogForward('story')

createRoot(document.getElementById('root')!).render(
  <>
    <StoryApp />
    <Toaster />
  </>,
)
