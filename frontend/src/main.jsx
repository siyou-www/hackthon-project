import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import Notifications from './Notifications.jsx'
import PwaUpdatePrompt from './PwaUpdatePrompt.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Notifications>
      <App />
      <PwaUpdatePrompt />
    </Notifications>
  </StrictMode>,
)
