import './assets/main.css'

import { createRoot } from 'react-dom/client'
import App from './App'
import { installEditableFocusGuard } from './lib/focus-guard'

// Antes de montar a UI: instala o guard que impede qualquer .focus() programático de tirar o foco de
// um campo editável. Ver installEditableFocusGuard.
installEditableFocusGuard()

createRoot(document.getElementById('root')!).render(<App />)
