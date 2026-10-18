import { createRoot } from 'react-dom/client'
import '../index.css'
import PetApp from './PetApp'
import { initTheme } from '../lib/theme'
import { setupLogForward } from '../lib/logForward'

initTheme()
setupLogForward('pet')

document.body.classList.add('pet-body')
document.body.style.overflow = 'hidden'

createRoot(document.getElementById('root')!).render(<PetApp />)
