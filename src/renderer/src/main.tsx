import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

const material = (window as unknown as { galaxySidebarMaterial?: string }).galaxySidebarMaterial
if (material === 'blur' || material === 'mica') document.documentElement.dataset.sidebarMaterial = material

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>
)
