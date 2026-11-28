import { useEffect, useLayoutEffect, useState } from 'react'
import { X } from './Icons'
import { REWRITE_NOTE_MAX } from '../../../shared/rewriteNote'
import { t } from '../../../shared/i18n'
import type { SummaryModelChoice, SummaryModelId } from '../../../shared/summaryModels'

export function RegenerateForm({ active, edited, disabled, hasSummary, onClose, onSubmit }: {
  hasSummary: boolean; active: boolean; edited: boolean; disabled: boolean; onClose: () => void; onSubmit: (note: string, model?: SummaryModelId) => void
}) {
  const [note, setNote] = useState('')
  const [models, setModels] = useState<SummaryModelChoice[]>([])
  const [model, setModel] = useState<SummaryModelId>()
  useLayoutEffect(() => { if (active) { setNote(''); setModel(undefined) } }, [active])
  useEffect(() => {
    if (!active || !hasSummary) return
    let current = true
    void window.yogurt.notes.summaryModels().then(choices => { if (current) setModels(choices) }, () => { if (current) setModels([]) })
    return () => { current = false }
  }, [active, hasSummary])
  const action = hasSummary ? t('Regenerate summary') : t('Generate summary')
  return <form onSubmit={(e) => { e.preventDefault(); if (!disabled) onSubmit(note.trim(), hasSummary ? model : undefined) }}>
    <div className="summary-regenerate-heading"><span>{action}</span>
      <button type="button" className="ghost-btn workspace-icon" aria-label={t('Close')} onClick={onClose}><X size={14} aria-hidden="true" /></button>
    </div>
    <input autoFocus data-testid="note-regenerate-input" className="summary-regenerate-input" aria-label={t('Note for the summary')}
      placeholder={t('Add a note, like shorter or in Spanish')} maxLength={REWRITE_NOTE_MAX} value={note}
      onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && e.nativeEvent.isComposing) e.preventDefault() }} />
    {hasSummary && <label className="mt-2 flex flex-col gap-1.5 text-xs">
      {t('Summary model')}
      <select className="w-full rounded-lg border border-line bg-bg px-2 py-1.5 text-sm text-ink"
        data-testid="note-regenerate-model" value={model ?? ''} disabled={disabled}
        onChange={e => setModel(models.find(choice => choice.id === e.target.value)?.id)}>
        <option value="">{t('Auto')}</option>
        {models.map(choice => <option key={choice.id} value={choice.id}>
          {choice.name}{choice.downloaded ? '' : ` · ${(choice.bytes / 1e9).toFixed(1)} GB`}
        </option>)}
      </select>
    </label>}
    {edited && <p id="note-rewrite-description" data-testid="note-confirm" className="summary-regenerate-warning">{t('Your edits to the summary will be replaced.')}</p>}
    <div className="summary-regenerate-actions"><button data-testid="note-write-again-confirm" type="submit" disabled={disabled} className="workspace-button primary">{hasSummary ? t('Regenerate') : t('Generate summary')}</button></div>
  </form>
}
