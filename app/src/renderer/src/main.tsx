import { RendererGuard, RendererFailureTest } from './components/RendererGuard'
import { installNoteLifecycle } from './noteLifecycle'
import { installRendererErrors } from './rendererErrors'
import { installFocusNavigation } from './focusNavigation'
import { installScrollActivity } from './scrollActivity'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import './workspace.css'
import './setup.css'
import { App } from './App'
import { Prompt } from './windows/Prompt'
import { Widget } from './windows/Widget'
import { applyLanguage, useLanguage } from './i18n'

// The small prompt card and the recording widget are the same page with #prompt and #widget
const Which = location.hash === '#prompt' ? Prompt : location.hash === '#widget' ? Widget : App
document.documentElement.classList.toggle('main-window', Which === App)
// Windows and Linux: the system's window buttons over the top right, no traffic lights (workspace.css)
if (window.yogurt.platform !== 'darwin') document.documentElement.dataset.chrome = 'overlay'
installRendererErrors()
if (Which === App) { installFocusNavigation(document); installScrollActivity(document); installNoteLifecycle() }
// everything re-renders in a newly picked language, in every window at once
function Page() { useLanguage(); return <Which /> }
const render = () => createRoot(document.getElementById('root')!).render(<StrictMode><RendererGuard><RendererFailureTest><Page /></RendererFailureTest></RendererGuard></StrictMode>)
window.yogurt.settings.onLanguage(applyLanguage)
// the interface language first, so no window flashes English (or the wrong direction)
window.yogurt.settings.get().then((s) => applyLanguage(s.locale), () => {}).finally(render)
