import { useEffect, useState } from 'react'
import type { BetterNotesState } from '../../../shared/types'
import { language, t } from '../../../shared/i18n'
import { betterNotesText } from '../notesSetup'

/** Settings' row for the bigger notes model: whether it downloads, and how far it is. Only on computers that get one. */
export function BetterNotesSetting() {
  const [better, setBetter] = useState<BetterNotesState>()
  useEffect(() => {
    const off = window.yogurt.setup.onState((s) => setBetter(s.betterNotes))
    void window.yogurt.setup.state().then((s) => setBetter((current) => current ?? s.betterNotes))
    return off
  }, [])
  if (!better) return null
  const on = better.status !== 'off'
  const toggle = () => { setBetter({ ...better, status: on ? 'off' : 'waiting', fraction: undefined, etaSec: undefined }); void window.yogurt.setup.setBetterNotes(!on) }
  const size = new Intl.NumberFormat(language(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(better.totalBytes / 1e9)
  return (
    <div data-testid="better-notes" data-status={better.status} className="settings-row">
      <div className="settings-row-copy" aria-live="polite">
        <p className="settings-label">{t('Better notes model')}</p>
        <p className="settings-description">{t('A bigger model that writes better notes. It downloads after the first one ({size} GB).', { size })}</p>
        <p data-testid="better-notes-status" className="settings-description">{betterNotesText(better)}</p>
      </div>
      {better.status === 'failed' &&
        <button data-testid="better-notes-retry" onClick={() => void window.yogurt.setup.retry()} className="workspace-button settings-action">{t('Try again')}</button>}
      <button data-testid="better-notes-toggle" role="switch" aria-checked={on} aria-label={t('Better notes model')} onClick={toggle} className="settings-toggle">
        <span className="settings-toggle-knob" />
      </button>
    </div>
  )
}
