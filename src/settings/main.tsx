import { createRoot } from 'react-dom/client'
import '../index.css'
import { SettingsLayout } from './SettingsLayout'
import { Toaster } from '../components/toast'
import { initTheme } from '../lib/theme'
import { setupLogForward } from '../lib/logForward'

initTheme()
setupLogForward('settings')

createRoot(document.getElementById('root')!).render(
  <>
    <SettingsLayout />
    <Toaster />
  </>,
)
