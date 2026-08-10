import { createRoot } from 'react-dom/client'
import '../index.css'
import { SettingsLayout } from './SettingsLayout'
import { Toaster } from '../components/toast'

createRoot(document.getElementById('root')!).render(
  <>
    <SettingsLayout />
    <Toaster />
  </>,
)
