import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from './Icons'
import { t } from '../../../shared/i18n'
import { RETENTION_MAX_DAYS, RETENTION_PRESETS, type Retention, type RetentionKind } from '../../../shared/retention'
import { TRASH_DAYS } from '../../../shared/trash'
import { Modal, ModalClose } from './Modal'

const PRESET_LABEL: Record<number, () => string> = {
  0: () => t('Once the summary is saved'), 7: () => t('After 1 week'), 30: () => t('After 1 month'), 90: () => t('After 3 months'),
  365: () => t('After 1 year'), 730: () => t('After 2 years'),
}
const ROWS: Array<{ kind: RetentionKind; label: () => string; description?: () => string }> = [
  { kind: 'audio', label: () => t('Delete audio') },
  { kind: 'transcript', label: () => t('Delete transcripts'), description: () => t('Its audio goes with it.') },
  { kind: 'meeting', label: () => t('Move meetings to the Trash'), description: () => t('Meetings in the Trash are deleted for good after {count} days, with their recordings.', { count: TRASH_DAYS }) },
]
const confirmText = (kind: RetentionKind, count: number) => kind === 'audio' ? t('{count} meetings already qualify. Their audio is deleted now.', { count })
  : kind === 'transcript' ? t('{count} meetings already qualify. Their transcripts and audio are deleted now; their notes stay.', { count })
    : t('{count} meetings already qualify. They move to the Trash now.', { count })
const choiceOf = (kind: RetentionKind, days: number | null) => days == null ? 'never' : RETENTION_PRESETS[kind].includes(days) ? String(days) : 'other'

/** Settings' own save: the toast with Try again when it fails, and its controls disabled while one is saving */
type Save = (write: () => Promise<void>, retryId: string) => Promise<void>

/** What Yogurt keeps: a rule per kind, Never unless picked. A rule that would act on meetings at once asks first, with the count. */
export function RetentionSettings({ retention, reveal = false, save, busy = false }: { retention?: Retention; reveal?: boolean; save: Save; busy?: boolean }) {
  return <>
    <h2 className="settings-section-heading">{t('What Yogurt keeps')}</h2>
    <p className="settings-description mb-2">{t('Counted from when each meeting ended. Audio and transcripts go only once the summary is saved, and notes stay.')}</p>
    <div data-testid="retention-settings" className="settings-group">
      {ROWS.map((row) => <RetentionRow key={row.kind} {...row} saved={retention ? retention[row.kind] : undefined} reveal={reveal && row.kind === 'audio'} save={save} busy={busy} />)}
    </div>
  </>
}

function RetentionRow({ kind, label, description, saved: initial, reveal, save: saveWith, busy }: { kind: RetentionKind; label: () => string; description?: () => string; saved?: number | null; reveal: boolean; save: Save; busy: boolean }) {
  const [saved, setSaved] = useState(initial ?? null)
  const [choice, setChoice] = useState(choiceOf(kind, initial ?? null))
  // the days field: only with Other, and empty until typed (or the saved number that isn't one of the choices)
  const [days, setDays] = useState(choiceOf(kind, initial ?? null) === 'other' ? String(initial) : '')
  const [confirm, setConfirm] = useState<{ days: number; count: number }>()
  const select = useRef<HTMLSelectElement>(null), field = useRef<HTMLInputElement>(null)
  const ready = initial !== undefined
  useEffect(() => {
    if (!ready) return
    setSaved(initial); setChoice(choiceOf(kind, initial)); setDays(choiceOf(kind, initial) === 'other' ? String(initial) : '')
  }, [ready, initial, kind])
  useEffect(() => {
    if (!reveal || !ready) return
    select.current?.closest('.settings-row')?.scrollIntoView({ block: 'center', behavior: 'instant' })
    select.current?.focus({ preventScroll: true })
  }, [reveal, ready])
  const show = (d: number | null) => { setChoice(choiceOf(kind, d)); setDays(choiceOf(kind, d) === 'other' ? String(d) : '') }
  // a failed save puts back what is saved; Try again repeats it
  const save = (d: number | null) => saveWith(async () => {
    try { await window.yogurt.settings.setRetention(kind, d) } catch (e) { show(saved); throw e }
    setSaved(d); show(d)
  }, `retention-${kind}-retry`)
  // Enter, then the blur as the confirmation opens: asked once
  const asking = useRef(false)
  const apply = async (d: number) => {
    if (d === saved) { show(d); return }
    if (asking.current) return
    asking.current = true
    try {
      const count = await window.yogurt.settings.retentionCount(kind, d).catch(() => 0)
      if (count > 0) setConfirm({ days: d, count })
      else await save(d)
    } finally { asking.current = false }
  }
  // a whole number of days is applied; leaving the field with anything else puts back what is saved
  const typed = (leaving: boolean) => {
    const d = Number(days)
    if (days.trim() && Number.isInteger(d) && d >= 1 && d <= RETENTION_MAX_DAYS) void apply(d)
    else if (leaving && !confirm) show(saved)
  }
  return <div data-testid={`retention-${kind}`} className={`settings-row${reveal && ready ? ' settings-reveal' : ''}`}>
    <div className="settings-row-copy">
      <label htmlFor={`retention-${kind}-choice`} className="settings-label">{label()}</label>
      {description && <p className="settings-description">{description()}</p>}
    </div>
    <span className="settings-retention">
      <span className="settings-select-wrap">
        <select ref={select} id={`retention-${kind}-choice`} data-testid={`retention-${kind}-choice`} value={choice} disabled={!ready || busy} className="settings-select"
          onChange={(e) => {
            const v = e.target.value
            if (v === 'other') { setChoice('other'); setDays(''); requestAnimationFrame(() => field.current?.focus()); return }
            setDays('')
            if (v === 'never') void save(null)
            else { setChoice(v); void apply(Number(v)) }
          }}>
          <option value="never">{t('Never')}</option>
          {RETENTION_PRESETS[kind].map((d) => <option key={d} value={String(d)}>{PRESET_LABEL[d]()}</option>)}
          <option value="other">{t('Other')}</option>
        </select>
        <ChevronDown size={14} aria-hidden="true" />
      </span>
      {choice === 'other' && <input ref={field} data-testid={`retention-${kind}-days`} type="number" inputMode="numeric" min={1} max={RETENTION_MAX_DAYS} step={1}
        aria-label={t('Number of days')} placeholder={t('Days')} value={days} className="settings-name-field settings-retention-days"
        onChange={(e) => setDays(e.target.value)} onBlur={() => typed(true)} onKeyDown={(e) => { if (e.key === 'Enter') typed(false) }} />}
    </span>
    {confirm && <Modal testId="retention-confirm" role="alertdialog" title={t('Apply to past meetings?')} description={confirmText(kind, confirm.count)}
      onCancel={() => { setConfirm(undefined); show(saved) }}>
      <div className="modal-actions">
        <button data-testid="retention-confirm-yes" onClick={() => { const d = confirm.days; setConfirm(undefined); void save(d) }} className="modal-button primary">{t('Apply')}</button>
        <ModalClose data-dialog-cancel data-testid="retention-confirm-cancel" className="workspace-button">{t('Cancel')}</ModalClose>
      </div>
    </Modal>}
  </div>
}
