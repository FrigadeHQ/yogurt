import { useLayoutEffect, useState } from 'react'
import { X } from './Icons'
import { REWRITE_NOTE_MAX } from '../../../shared/rewriteNote'
import { t } from '../../../shared/i18n'

export function RegenerateForm({ active, edited, disabled, hasSummary, onClose, onSubmit }: {
  hasSummary: boolean; active: boolean; edited: boolean; disabled: boolean; onClose: () => void; onSubmit: (note: string) => void
}) {
  const [note, setNote] = useState('')
  useLayoutEffect(() => { if (active) setNote('') }, [active])
  const action = hasSummary ? t('Regenerate summary') : t('Generate summary')
  return <form onSubmit={(e) => { e.preventDefault(); if (!disabled) onSubmit(note.trim()) }}>
    <div className="summary-regenerate-heading"><span>{action}</span>
      <button type="button" className="ghost-btn workspace-icon" aria-label={t('Close')} onClick={onClose}><X size={14} aria-hidden="true" /></button>
    </div>
    <input autoFocus data-testid="note-regenerate-input" className="summary-regenerate-input" aria-label={t('Note for the summary')}
      placeholder={t('Add a note, like shorter or in Spanish')} maxLength={REWRITE_NOTE_MAX} value={note}
      onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && e.nativeEvent.isComposing) e.preventDefault() }} />
    {edited && <p id="note-rewrite-description" data-testid="note-confirm" className="summary-regenerate-warning">{t('Your edits to the summary will be replaced.')}</p>}
    <div className="summary-regenerate-actions"><button data-testid="note-write-again-confirm" type="submit" disabled={disabled} className="workspace-button primary">{hasSummary ? t('Regenerate') : t('Generate summary')}</button></div>
  </form>
}
