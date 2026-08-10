import { createRoot } from 'react-dom/client'
import '../index.css'
import { ChatWindow } from './ChatWindow'
import { Toaster } from '../components/toast'

createRoot(document.getElementById('root')!).render(
  <>
    <ChatWindow />
    <Toaster />
  </>,
)
