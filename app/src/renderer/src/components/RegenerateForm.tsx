import { useLayoutEffect, useState } from 'react'
import { X } from 'lucide-react'
import { REWRITE_NOTE_MAX } from '../../../shared/rewriteNote'
import { t } from '../../../shared/i18n'

/**
 * One note, two ways: Edit applies it to the summary as it is now (edits included, the transcript read only when
 * ticked), Regenerate writes the summary again from the meeting.
 */
export function RegenerateForm({ active, edited, disabled, hasSummary, hasTranscript, onClose, onSubmit, onEdit }: {
  hasSummary: boolean; active: boolean; edited: boolean; disabled: boolean; onClose: () => void; onSubmit: (note: string) => void
  /** the meeting has transcript lines Edit can read too */
  hasTranscript: boolean
  onEdit: (note: string, withTranscript: boolean) => void
}) {
  const [note, setNote] = useState('')
  const [withTranscript, setWithTranscript] = useState(false)
  useLayoutEffect(() => { if (active) { setNote(''); setWithTranscript(false) } }, [active])
  const action = hasSummary ? t('Edit or regenerate summary') : t('Generate summary')
  return <form onSubmit={(e) => { e.preventDefault(); if (!disabled) onSubmit(note.trim()) }}>
    <div className="summary-regenerate-heading"><span>{action}</span>
      <button type="button" className="ghost-btn workspace-icon" aria-label={t('Close')} onClick={onClose}><X size={14} aria-hidden="true" /></button>
    </div>
    <input autoFocus data-testid="note-regenerate-input" className="summary-regenerate-input" aria-label={t('Note for the summary')}
      placeholder={t('Add a note, like shorter or in Spanish')} maxLength={REWRITE_NOTE_MAX} value={note}
      onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && e.nativeEvent.isComposing) e.preventDefault() }} />
    {hasSummary && hasTranscript && <label className="summary-regenerate-option">
      <input type="checkbox" data-testid="note-edit-transcript" checked={withTranscript} onChange={(e) => setWithTranscript(e.target.checked)} />
      {t('Edit using the transcript too')}
    </label>}
    {hasSummary && hasTranscript && withTranscript && <p data-testid="note-edit-transcript-warning" className="summary-regenerate-warning">{t('Slower, and depends on the notes model: a long meeting may not fit it and is then read in parts.')}</p>}
    {edited && <p id="note-rewrite-description" data-testid="note-confirm" className="summary-regenerate-warning">{hasSummary ? t('Regenerate replaces your edits to the summary. Edit keeps them.') : t('Your edits to the summary will be replaced.')}</p>}
    <div className="summary-regenerate-actions">
      {hasSummary && <button data-testid="note-edit-confirm" type="button" disabled={disabled || !note.trim()} className="workspace-button"
        onClick={() => { if (!disabled && note.trim()) onEdit(note.trim(), hasTranscript && withTranscript) }}>{t('Edit summary')}</button>}
      <button data-testid="note-write-again-confirm" type="submit" disabled={disabled} className="workspace-button primary">{hasSummary ? t('Regenerate') : t('Generate summary')}</button>
    </div>
  </form>
}
