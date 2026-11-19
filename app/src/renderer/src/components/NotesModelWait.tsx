import { useEffect, useState, type ReactNode } from 'react'
import type { SetupState } from '../../../shared/types'
import type { AiStatus, AiTask } from '../../../shared/ai'
import { t } from '../../../shared/i18n'
import { notesPercent } from '../notesSetup'

/**
 * Waiting notes and answers share the first model's failure and its existing setup retry. downloading: what to show
 * instead while the first notes model is still downloading (every system reports how far it is, as percent).
 */
export function NotesModelWait({ children, downloading, task = 'notes' }: { children: ReactNode; downloading?: (percent: string) => ReactNode
  /** what is waiting: with Yogurt AI not on this computer, it waits for the AI picked for this in Settings */
  task?: AiTask }) {
  const [setup, setSetup] = useState<SetupState>()
  const [ai, setAi] = useState<AiStatus>()
  const [retrying, setRetrying] = useState(false)
  const [retryFailed, setRetryFailed] = useState(false)
  useEffect(() => {
    const off = window.yogurt.setup.onState((s) => { setSetup(s); if (!s.notesError) setRetryFailed(false) })
    void window.yogurt.setup.state().then((s) => setSetup((current) => current ?? s))
    return off
  }, [])
  useEffect(() => { if (setup?.localNotesOff) void window.yogurt.ai.status().then(setAi).catch(() => {}) }, [setup?.localNotesOff])
  const retry = async () => {
    setRetrying(true); setRetryFailed(false)
    try { await window.yogurt.setup.retry() } catch { setRetryFailed(true) }
    finally { setRetrying(false) }
  }
  if (setup?.localNotesOff && ai?.tasks[task] === 'local') return (
    <div data-testid="notes-model-off" role="status" className="flex flex-col items-start gap-2 text-[14px] text-muted">
      <p>{task === 'ask' ? t('Answers need an AI model. Yogurt AI is not on this computer, so pick one for Ask in Settings → AI models.') : t('Summaries need an AI model. Yogurt AI is not on this computer, so pick one for summaries in Settings → AI models.')}</p>
      <button data-testid="notes-model-settings" onClick={() => window.yogurt.nav.go('/settings')} className="text-action">{t('Open Settings')}</button>
    </div>
  )
  if (!setup?.notesError) {
    if (downloading && setup && (setup.notesFraction !== undefined || setup.notesDownloading)) return downloading(notesPercent(setup.notesFraction ?? 0))
    return children
  }
  return (
    <div data-testid="notes-model-error" role="status" className="flex flex-col items-start gap-2 text-[14px] text-muted">
      <p className="font-medium text-ink">{t("The notes model couldn't download.")}</p>
      <p>{setup.notesError}</p>
      <button data-testid="notes-model-retry" onClick={() => void retry()} disabled={retrying} className="text-action">
        {retrying ? t('Retrying…') : t('Retry download')}
      </button>
      {retryFailed && <p className="text-danger">{t("Yogurt couldn't restart the download.")}</p>}
    </div>
  )
}
