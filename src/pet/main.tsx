import { createRoot } from 'react-dom/client'
import '../index.css'
import PetApp from './PetApp'

document.body.classList.add('pet-body')
document.body.style.overflow = 'hidden'

createRoot(document.getElementById('root')!).render(<PetApp />)
