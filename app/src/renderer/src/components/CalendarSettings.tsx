import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Loading } from './Loading'
import { LoadingContent } from './LoadingContent'
import { CalendarLinkForm } from './CalendarLinkForm'
import { t } from '../../../shared/i18n'

let expanded = false

export function CalendarSettings({ connect = false }: { connect?: boolean } = {}) {
  // Windows and Linux: calendars are pasted calendar links, connected and removed here (and in the first run)
  const link = !!globalThis.window?.yogurt?.capabilities?.calendarLink
  const [view, setView] = useState<Awaited<ReturnType<typeof window.yogurt.calendar.list>>>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [open, setOpen] = useState(expanded || link)
  const [form, setForm] = useState<'closed' | 'automatic' | 'requested'>('closed')
  const adding = form !== 'closed'
  const addButton = useRef<HTMLButtonElement>(null), restoreFocus = useRef(false)
  const closeForm = () => { restoreFocus.current = true; setForm('closed') }
  useEffect(() => {
    if (!adding && !busy && restoreFocus.current) { restoreFocus.current = false; addButton.current?.focus({ preventScroll: true }) }
  }, [adding, busy])
  useEffect(() => {
    // Offer the empty-state form without taking focus from navigation or a Settings deep link.
    if (link && view && view.status !== 'error' && !view.calendars.length) setForm(current => current === 'closed' ? 'automatic' : current)
  }, [link, view?.status, view?.calendars.length])
  useEffect(() => {
    if (connect) { setOpen(true); setForm('requested') }
  }, [connect])
  const reload = useCallback(() => {
    void window.yogurt.calendar.list().then(setView, () => setView({ status: 'error', calendars: [], hideEventsWithoutCallLink: false }))
  }, [])
  useEffect(() => { reload(); window.addEventListener('focus', reload); return () => window.removeEventListener('focus', reload) }, [reload])
  const choose = async (id: string, enabled: boolean) => {
    setBusy(true); setError(false)
    setView((v) => v && { ...v, calendars: v.calendars.map((c) => c.id === id ? { ...c, enabled } : c) })
    try {
      if (!await window.yogurt.calendar.setEnabled(id, enabled)) throw new Error('Calendar unavailable')
    } catch { setError(true); reload() } finally { setBusy(false) }
  }
  const hideWithoutLink = async () => {
    if (!view) return
    const hide = !view.hideEventsWithoutCallLink
    setBusy(true); setError(false)
    setView({ ...view, hideEventsWithoutCallLink: hide })
    try {
      if (!await window.yogurt.calendar.setHideWithoutLink(hide)) throw new Error('Calendar unavailable')
    } catch { setError(true); reload() } finally { setBusy(false) }
  }
  const selected = view?.calendars.filter(c => c.enabled) ?? []
  // the Mac's own calendars, apart from calendar links next to them
  const sys = view?.systemStatus ?? view?.status
  const removeLink = async (id: string) => {
    setBusy(true); setError(false)
    try { if (!await window.yogurt.calendar.removeLink(id)) throw new Error('Calendar unavailable') } catch { setError(true) } finally { setBusy(false); reload() }
  }
  const summary = !view ? t('Loading calendars…')
    : view.status === 'error' ? t("Yogurt couldn't read your calendars.")
    : view.status !== 'granted' ? (link ? t('Connect a calendar to see your meetings.') : t('Allow calendar access to choose your calendars.'))
    : !view.calendars.length ? (link ? t('Connect a calendar to see your meetings.') : t('No calendars found on this Mac.'))
    : !selected.length ? t('No calendars selected.')
    : selected.length === 1 ? [selected[0].name, selected[0].source].filter(Boolean).join(' · ')
    : `${selected[0].name} ${t('and {count} more', { count: selected.length - 1 })}`
  return <section data-testid="calendar-settings">
    <h2 className="settings-section-heading">{t('Calendars')}</h2>
    <div className="settings-group">
      <button type="button" data-testid="calendar-settings-toggle" aria-expanded={open} aria-controls="settings-calendar-list" onClick={() => { expanded = !open; setOpen(expanded) }} className="settings-row settings-disclosure">
        <span className="settings-row-copy">
          <LoadingContent pending={!view} skeleton={<span className="settings-label settings-calendar-summary"><span className="loading-bar" style={{ width: 150 }} /></span>}><span data-testid="calendar-settings-summary" className="settings-label settings-calendar-summary" title={summary}>{summary}</span></LoadingContent>
          <span className="settings-description block">{t('Yogurt reads these calendars and never changes them.')}</span>
        </span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      <div id="settings-calendar-list" className="accordion" data-open={open} inert={!open || undefined}><div className="settings-calendar-list">
        <LoadingContent pending={!view} skeleton={<Loading layout="calendars" />}>{view && <>{!link && sys !== 'granted' && <div className="settings-row">
            <p className="settings-description settings-row-copy">{sys === 'error' ? t("Yogurt couldn't read your calendars.") : t('Allow calendar access to choose your calendars.')}</p>
            <button className="workspace-button" onClick={() => { if (sys === 'error') reload(); else void window.yogurt.calendar.connect().then(reload) }}>{sys === 'error' ? t('Try again') : t('Connect calendar')}</button>
          </div>}
          {!link && sys === 'granted' && !view.calendars.some((c) => !c.link) && <p className="settings-row settings-description">{t('No calendars found on this Mac.')}</p>}
          {view.calendars.map((c) => <label key={c.id} data-testid="calendar-choice" className="settings-row settings-calendar-choice">
            <span className="settings-calendar-dot" style={{ backgroundColor: c.color }} aria-hidden="true" />
            <span className="settings-row-copy"><span className="settings-label">{c.name}</span><span className="settings-description block">{c.source}</span></span>
            <input type="checkbox" checked={c.enabled} disabled={busy} onChange={(e) => void choose(c.id, e.target.checked)} />
            {c.link && <button type="button" data-testid="calendar-link-remove" className="workspace-button shrink-0" disabled={busy} onClick={(e) => { e.preventDefault(); void removeLink(c.id) }}>{t('Remove')}</button>}
          </label>)}</>}</LoadingContent>
        {view && view.status !== 'error' && <div className="settings-calendar-add">
          <button ref={addButton} type="button" data-testid="calendar-link-add" className="settings-row settings-disclosure"
            aria-expanded={adding} aria-controls="settings-calendar-add" disabled={busy}
            onClick={() => { if (adding) closeForm(); else setForm('requested') }}>
            <span className="settings-row-copy"><span className="settings-label">{t('Add a calendar by link')}</span>
              {!link && <span className="settings-description block">{t("Calendars from the Mac's Calendar app appear above automatically.")}</span>}
            </span><ChevronDown size={16} aria-hidden="true" />
          </button>
          <div id="settings-calendar-add" className="accordion" data-open={adding} inert={!adding || undefined} aria-hidden={!adding}>
            <div><div className="settings-calendar-link">
              <CalendarLinkForm only={link ? undefined : 'other'} autoFocus={form === 'requested'} onCancel={closeForm} onBusyChange={setBusy}
                onConnected={() => { closeForm(); reload() }} />
            </div></div>
          </div>
        </div>}
        {view?.status === 'granted' && view.calendars.length > 0 && <div data-testid="calendar-options" className="settings-calendar-actions">
          <div className="settings-row">
            <div className="settings-row-copy">
              <p className="settings-label">{t('Hide events without a call link')}</p>
              <p id="calendar-call-link-description" className="settings-description">{t('Keep your agenda and reminders focused on calls.')}</p>
            </div>
            <button type="button" data-testid="calendar-call-link-toggle" role="switch" aria-checked={view.hideEventsWithoutCallLink}
              aria-label={t('Hide events without a call link')} aria-describedby="calendar-call-link-description" disabled={busy}
              onClick={() => void hideWithoutLink()} className="settings-toggle"><span className="settings-toggle-knob" /></button>
          </div>
          {!link && <div className="settings-row">
            <span className="settings-row-copy"><span className="settings-label">{t('Calendar access')}</span><span className="settings-description block">{t('Remove Yogurt’s access in System Settings.')}</span></span>
            <button type="button" className="workspace-button shrink-0" onClick={() => void window.yogurt.permissions.open('calendar')}>{t('Open System Settings')}</button>
          </div>}
        </div>}
        {error && <p role="alert" className="settings-row text-danger">{t("Couldn't update your calendars. Try again.")}</p>}
      </div></div>
    </div>
  </section>
}
