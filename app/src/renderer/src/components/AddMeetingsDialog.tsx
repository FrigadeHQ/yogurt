import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { Folder, FolderMeetingChoice } from '../../../shared/types'
import { language, t } from '../../../shared/i18n'
import { Checkbox } from './Checkbox'
import { ScrollFade } from './ScrollFade'
import { Search } from './Icons'
import { InlineError } from './InlineError'
import { Modal, ModalClose } from './Modal'

export function AddMeetingsDialog({ folder, onDone }: { folder: Folder; onDone(added: boolean): void }) {
  const [rows, setRows] = useState<FolderMeetingChoice[]>()
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState(new Set<string>())
  const [focused, setFocused] = useState('')
  const [loadFailed, setLoadFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const [added, setAdded] = useState(false)
  const saving = useRef(false)
  const list = useRef<HTMLDivElement>(null)
  const locale = language()
  const date = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }), [locale])
  useEffect(() => {
    let seq = 0
    const read = () => {
      const mine = ++seq
      void window.yogurt.folders.meetingChoices(folder.id).then(next => {
        if (mine === seq) { setRows(next); setLoadFailed(false) }
      }, () => { if (mine === seq) setLoadFailed(true) })
    }
    read()
    let timer: ReturnType<typeof setTimeout>
    const changed = () => { clearTimeout(timer); timer = setTimeout(read, 150) }
    const offFolders = window.yogurt.folders.onChange(changed), offMeetings = window.yogurt.meetings.onChange(changed)
    return () => { seq++; clearTimeout(timer); offFolders(); offMeetings() }
  }, [folder.id, attempt])

  const selected = (rows ?? []).filter(row => !row.inFolder && chosen.has(row.id)).map(row => row.id)
  const needle = query.trim().toLocaleLowerCase(locale)
  const visible = (rows ?? []).filter(row => (row.title || t('Untitled meeting')).toLocaleLowerCase(locale).includes(needle))
  const tabStop = visible.find(row => row.id === focused && !row.inFolder) ?? visible.find(row => !row.inFolder)
  const arrows = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const choices = Array.from(list.current?.querySelectorAll<HTMLInputElement>('input:enabled') ?? [])
    if (!choices.length) return
    const index = choices.indexOf(event.target as HTMLInputElement)
    event.preventDefault()
    const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : choices.length - 1) : index + (event.key === 'ArrowDown' ? 1 : -1)
    choices[Math.max(0, Math.min(next, choices.length - 1))].focus()
  }
  const save = async () => {
    if (saving.current || loadFailed || !selected.length) return
    saving.current = true; setBusy(true); setSaveFailed(false)
    try {
      if (!await window.yogurt.folders.addMany(folder.id, selected)) throw new Error('Selection unavailable')
      setAdded(true)
    } catch {
      saving.current = false; setBusy(false); setSaveFailed(true); setAttempt(n => n + 1)
    }
  }
  return <Modal testId="folder-add-meetings" title={t('Add meetings to {folder}', { folder: folder.name })}
    closing={added} busy={busy} onCancel={() => onDone(added)}>
    <label className="shortcuts-search"><Search size={16} aria-hidden="true" />
      <input data-dialog-focus aria-label={t('Search')} placeholder={t('Search')} value={query} disabled={busy}
        onChange={e => setQuery(e.target.value)} onKeyDown={arrows} />
    </label>
    <ScrollFade><div ref={list} role="group" aria-label={t('Meetings')} className="folder-meeting-choices" onKeyDown={arrows}>
      {loadFailed ? <InlineError testId="folder-meetings-error" retry={() => setAttempt(n => n + 1)} />
        : !rows ? <p role="status">{t('Loading…')}</p>
        : !visible.length ? <p role="status">{needle ? t('Nothing found for “{query}”.', { query: query.trim() }) : t('No meetings here yet')}</p>
        : visible.map(row => <label key={row.id} className="folder-meeting-choice">
          <Checkbox checked={row.inFolder || chosen.has(row.id)} disabled={row.inFolder || busy}
            tabIndex={row.id === tabStop?.id ? 0 : -1} onFocus={() => setFocused(row.id)}
            onChange={e => { const checked = e.target.checked; setChosen(previous => {
              const next = new Set(previous)
              if (checked) next.add(row.id)
              else next.delete(row.id)
              return next
            }) }} />
          <span className="min-w-0"><span className="block [overflow-wrap:anywhere]">{row.title || t('Untitled meeting')}</span>
            <small>{date.format(row.startedAt)}{row.inFolder && <> · {t('In this folder')}</>}</small></span>
        </label>)}
    </div></ScrollFade>
    {saveFailed && <p className="modal-error" role="alert">{t("Yogurt couldn't make that change. Try again.")}</p>}
    <div className="modal-actions">
      <button className="modal-button primary" disabled={busy || loadFailed || !selected.length} onClick={() => void save()}>
        {selected.length ? t('Add {count} meetings to folder', { count: selected.length }) : t('Add meetings')}
      </button>
      <ModalClose data-dialog-cancel disabled={busy} className="workspace-button">{t('Cancel')}</ModalClose>
    </div>
  </Modal>
}
