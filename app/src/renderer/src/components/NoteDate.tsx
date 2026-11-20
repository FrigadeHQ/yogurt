import { usePopoverPresence } from '../motion'
import { Component, createRef, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { ScrollFade } from './ScrollFade'
import { CalendarDays, Plus, ChevronDown, ChevronLeft, ChevronRight, Clock, ExternalLink, Link2Off } from 'lucide-react'
import type { CalEvent, CalendarStatus, Meeting } from '../../../shared/types'
import { language, t } from '../../../shared/i18n'
import { noteDateLabel, timeOf } from '../dates'
import { eventTimeRange } from '../../../shared/dates'
import { useJoinWindow } from '../useJoinWindow'
import { useNoteCalendar, type NoteCalendar } from '../useNoteCalendar'
import { useNotePopover } from '../useNotePopover'
import { useLoadingState } from '../useLoadingState'
import { nearestEvents, shiftCalendarDay } from '../../../shared/calendarPicker'

export function NoteDate({ m }: { m: Meeting }) {
  const [open, setOpen] = useState<false | 'pointer' | 'keyboard'>(false)
  const presence = usePopoverPresence(open)
  const chip = useRef<HTMLButtonElement>(null)
  const { details, refresh } = useNoteCalendar(m)
  const event = details?.result.events.find(e => e.id === m.eventId || (m.eventId && e.aliases?.includes(m.eventId)))
  const eventTitle = m.eventId ? event?.title || m.eventTitle || (m.titleSource === 'calendar' && m.title) || t('Meeting') : undefined
  const color = event?.calendar?.id ? details?.colors[event.calendar.id] : undefined
  const date = noteDateLabel(m.startedAt)
  const close = useCallback(() => { setOpen(false); chip.current?.focus({ preventScroll: true }) }, [])
  return <div className="relative note-date-anchor">
    <button ref={chip} title={eventTitle} data-testid="note-date" aria-label={eventTitle ? `${date} ${eventTitle}` : undefined} aria-haspopup="dialog" aria-expanded={!!open} onClick={e => setOpen(o => o ? false : e.detail > 0 ? 'pointer' : 'keyboard')}
      className="note-chip note-date-chip flex items-center gap-1.5 rounded-md border border-line px-2.5 text-[13px] text-muted">
      <CalendarDays size={14} strokeWidth={1.75} aria-hidden="true" /><span>{date}</span>
      {eventTitle && <>
        <span aria-hidden="true" className={color ? 'note-date-chip-dot' : undefined} style={{ backgroundColor: color }}>{color ? null : ' · '}</span>
        <span className="note-date-chip-name" dir="auto">{eventTitle}</span>
      </>}
    </button>
    {presence.value && <DateCard key={m.id} m={m} details={details} event={event} eventTitle={eventTitle} color={color} refreshLinked={refresh} chip={chip} motionProps={presence.props} onClose={close} />}
  </div>
}

function DateCard({ m, details, event, eventTitle, color, refreshLinked, chip, motionProps, onClose }: { m: Meeting; details?: NoteCalendar; event?: CalEvent; eventTitle?: string; color?: string; refreshLinked: () => void; chip: RefObject<HTMLButtonElement | null>; motionProps: ReturnType<typeof usePopoverPresence>['props']; onClose: (restore?: boolean) => void }) {
  const card = useRef<HTMLDivElement>(null)
  // no calendar on this computer (Windows, Linux): the date and length only, as for a note with no event
  const calendar = window.yogurt.capabilities.calendar
  const linked = calendar && !!m.eventId
  const [revision, setRevision] = useState(0)
  const [picking, setPicking] = useState(false)
  const [day, setDay] = useState(m.eventStartedAt ?? m.startedAt)
  const [dayResult, setResult] = useState<Awaited<ReturnType<typeof window.yogurt.calendar.day>> | undefined>(details?.result)
  const result = linked ? details?.result : dayResult
  const reserveCalendar = useRef(linked && !details)
  const [linking, setLinking] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const [compactDate, setCompactDate] = useState(false)
  const loadingPhase = useLoadingState(calendar && !linked && !result)
  const pickerKeyboard = useRef(false)
  const previous = useRef<HTMLButtonElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const recovery = useRef<HTMLButtonElement>(null)
  useNotePopover(card, chip, onClose, !motionProps.inert)
  const days = useRef(new Map<string, Awaited<ReturnType<typeof window.yogurt.calendar.day>>>())
  if (details) {
    if (details.result.status !== 'granted') days.current.clear()
    days.current.set(new Date(m.eventStartedAt ?? m.startedAt).toDateString(), details.result)
  }
  const [selection, setSelection] = useState(m.eventId)
  // Keep the card mounted, but never commit the previous link's picker or day.
  if (selection !== m.eventId) {
    const nextDay = m.eventStartedAt ?? m.startedAt
    reserveCalendar.current = linked && !details
    setSelection(m.eventId); setPicking(false); setDay(nextDay)
    setResult(days.current.get(new Date(nextDay).toDateString()))
  }
  useEffect(() => {
    if (!calendar || linked) return
    let active = true
    void window.yogurt.calendar.day(day, 'link-event').catch(() => ({ status: 'error' as const, events: [] })).then(value => {
      if (!active) return
      if (value.status !== 'granted') days.current.clear()
      days.current.set(new Date(day).toDateString(), value)
      setResult(value)
    })
    return () => { active = false }
  }, [calendar, linked, day, revision])
  const browse = (nextDay: number) => {
    setResult(days.current.get(new Date(nextDay).toDateString()))
    setDay(nextDay)
  }
  useEffect(() => {
    if (!picking) browse(m.eventStartedAt ?? m.startedAt)
  }, [picking, m.eventStartedAt, m.startedAt])
  useEffect(() => {
    if (!calendar || linked) return
    const refresh = () => setRevision(n => n + 1)
    const off = window.yogurt.calendar.onChange(refresh)
    window.addEventListener('focus', refresh)
    return () => { off(); window.removeEventListener('focus', refresh) }
  }, [calendar, linked])
  const refresh = () => linked ? refreshLinked() : setRevision(n => n + 1)
  const connect = () => void window.yogurt.calendar.connect().then(refresh, () => linked ? refreshLinked() : setResult({ status: 'error', events: [] }))
  const available = result?.status === 'granted'
  const browsing = calendar && !linked && (!result || available)
  useEffect(() => {
    if (picking && pickerKeyboard.current && !linked && result && !available) recovery.current?.focus({ preventScroll: true })
  }, [picking, linked, result, available])
  const at = event?.start ?? (linked ? m.eventStartedAt : null) ?? m.startedAt
  const eventEnd = event?.end ?? (linked ? m.eventEndedAt : null)
  const eventCalendar = event?.calendar ?? (linked && m.eventCalendarName ? { name: m.eventCalendarName, source: m.eventCalendarSource } : null)
  const minutes = Math.max(0, Math.round((m.durationMs ?? (m.endedAt ? m.endedAt - m.startedAt : m.state === 'recording' ? Date.now() - m.startedAt : 0)) / 60_000))
  const joinable = useJoinWindow(at, eventEnd)
  const url = joinable ? event?.url?.trim() : undefined
  const date = new Date(browsing ? day : at)
  const showDate = !linked || date.toDateString() !== new Date(m.startedAt).toDateString()
  const dateOptions: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) }
  const fullDate = date.toLocaleDateString(language(), { ...dateOptions, weekday: 'long', month: 'long' })
  const shortDate = date.toLocaleDateString(language(), { ...dateOptions, weekday: 'short' })
  useLayoutEffect(() => {
    const el = heading.current
    if (!el) return
    const context = document.createElement('canvas').getContext('2d')!
    const measure = () => {
      context.font = getComputedStyle(el).font
      setCompactDate(context.measureText(fullDate).width > el.clientWidth)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [fullDate, showDate])
  const loading = loadingPhase !== 'skeleton' ? null : <div className="loading-content" data-loading-phase={loadingPhase} aria-busy="true">
    <div className="loading-placeholder"><span role="status" className="sr-only">{t('Looking at your calendar…')}</span>
      <div className="loading-mask" aria-hidden="true"><span className="loading-bar" style={{ width: '65%' }} /></div>
    </div>
  </div>
  const recoveryAction = result && !available ? <div className="note-date-access flex flex-wrap items-center gap-x-3 gap-y-2">
    <p role="status" className="text-xs text-muted">{result.status === 'error' ? t("Yogurt couldn't read your calendar") : t('Calendar access is off')}</p>
    <div className="ms-auto flex shrink-0"><button ref={recovery} className="workspace-button" onClick={result.status === 'error' ? refresh : connect}>{result.status === 'error' ? t('Try again') : result.status === 'denied' ? t('Open System Settings') : t('Connect calendar')}</button></div>
  </div> : null
  return <div ref={card} data-testid="note-date-card" {...motionProps} data-anchor="start" data-picking={browsing || picking} role="dialog" aria-label={t('Date')}
    className="people-card menu-entry note-date-card absolute start-0 top-full z-30 mt-2 w-[min(340px,calc(100vw-48px))] rounded-lg border border-line bg-float text-ink shadow-[var(--shadow)]"
    onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (linked && picking) { setPicking(false); toggle.current?.focus({ preventScroll: true }) } else onClose() } }}>
    <NoteDateBody view={`${m.eventId ?? 'unlinked'}/${browsing ? 'picker' : 'details'}/${linked ? 'linked' : result?.status ?? (loadingPhase === 'skeleton' ? 'skeleton' : 'waiting')}`}>
      {showDate && <div className="agenda-inspector-heading">
        <h3 ref={heading} data-testid="note-date-heading" tabIndex={linked ? undefined : -1} aria-live="polite" aria-label={fullDate} title={fullDate}>{compactDate ? shortDate : fullDate}</h3>
        {browsing && (available || picking) && <div className="flex shrink-0 items-center gap-1">
          <button type="button" ref={previous} className="ghost-btn workspace-icon" data-testid="note-date-previous" aria-label={t('Previous day')} disabled={linking} onClick={e => { pickerKeyboard.current = e.detail === 0; setPicking(true); browse(shiftCalendarDay(day, -1)) }}><ChevronLeft size={15} aria-hidden="true" /></button>
          <button type="button" className="ghost-btn workspace-icon" data-testid="note-date-next" aria-label={t('Next day')} disabled={linking} onClick={e => { pickerKeyboard.current = e.detail === 0; setPicking(true); browse(shiftCalendarDay(day, 1)) }}><ChevronRight size={15} aria-hidden="true" /></button>
        </div>}
      </div>}
      {linked && <div className="note-date-linked">
        <button type="button" ref={toggle} data-testid="note-date-events-toggle" className="note-date-event-toggle" aria-expanded={picking} disabled={linking} onClick={e => { pickerKeyboard.current = e.detail === 0; setPicking(v => !v) }}>
          <span className="note-date-color note-date-reveal" data-ready={!!color} aria-hidden="true" style={{ backgroundColor: color }} />
          <span className="note-date-identity"><strong dir="auto">{eventTitle}</strong>
            <span className="note-date-time">{eventEnd != null ? eventTimeRange(at, eventEnd) : `${timeOf(at)} · ${t('{count} min', { count: minutes })}`}</span>
            {(eventCalendar?.name || reserveCalendar.current) && <span className="note-date-calendar note-date-reveal" data-ready={!!eventCalendar?.name} title={eventCalendar?.name}>{eventCalendar?.name}</span>}
          </span>
          <ChevronDown size={15} aria-hidden="true" />
        </button>
        <div className="accordion note-date-motion note-date-picker-motion" data-open={picking} aria-hidden={!picking} inert={!picking}>
          <div><div className="note-date-picker-space"><EventPicker keyboard={pickerKeyboard.current} open={picking} m={m} day={day} result={result} loading={loading} previous={toggle} linking={linking} onLinking={setLinking} onLinked={() => requestAnimationFrame(() => (toggle.current ?? heading.current)?.focus({ preventScroll: true }))} /></div></div>
        </div>
      </div>}
      {!linked && !browsing && <div className="accordion note-date-motion note-date-details-motion" data-open={true}><div><div className="note-date-details"><div className="agenda-inspector-line"><Clock size={15} aria-hidden="true" /><div>
        <p>{timeOf(at)}{eventEnd != null ? ` – ${timeOf(eventEnd)}` : ` · ${t('{count} min', { count: minutes })}`}</p>
      </div></div>
      </div></div></div>}
      {linked && ((joinable && !result) || url || (result && (!available || !event))) && <div className="note-date-actions" aria-busy={!result}>
        <div className="note-date-reveal" data-ready={!!result}>
          {available && !event && <div className="note-date-access flex items-center gap-3 text-xs text-muted">
            <p role="status">{t('Calendar event unavailable')}</p>
            <button className="text-action ms-auto" onClick={refresh}>{t('Try again')}</button>
          </div>}
          {url && <div className="agenda-inspector-actions">
            <a className="workspace-button" title={t('Join meeting')} href={url} target="_blank" rel="noreferrer"><span>{t('Join meeting')}</span><ExternalLink size={12} aria-hidden="true" /></a>
          </div>}
          {result?.status !== 'unsupported' && recoveryAction}
        </div>
      </div>}
      {calendar && !linked && result?.status !== 'unsupported' && !browsing && recoveryAction}
      {browsing && <EventPicker keyboard={pickerKeyboard.current} m={m} day={day} result={result} loading={loading} previous={previous} linking={linking} onLinking={setLinking} onLinked={() => requestAnimationFrame(() => (toggle.current ?? heading.current)?.focus({ preventScroll: true }))} />}
    </NoteDateBody>
  </div>
}

function EventPicker({ open = true, keyboard, m, day, result, loading, previous, linking, onLinking, onLinked }: { open?: boolean; keyboard: boolean; m: Meeting; day: number; result: { status: CalendarStatus; events: CalEvent[] } | undefined; loading: ReactNode; previous: RefObject<HTMLButtonElement | null>; linking: boolean; onLinking: (linking: boolean) => void; onLinked: () => void }) {
  const [linkError, setLinkError] = useState(false)
  const list = useRef<HTMLDivElement>(null)
  const unlink = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    if (list.current) list.current.scrollTop = 0
    if (keyboard) (list.current?.querySelector<HTMLButtonElement>('[data-event-id]') ?? unlink.current ?? previous.current)?.focus({ preventScroll: true })
  }, [open, keyboard, result, previous])
  useEffect(() => { if (open) setLinkError(false) }, [open])
  const link = async (eventId: string | null) => {
    if (linking) return
    onLinking(true); setLinkError(false)
    try { await window.yogurt.meetings.linkEvent(m.id, eventId, day); onLinked() }
    catch { setLinkError(true) }
    finally { onLinking(false) }
  }
  const events = result?.events
  return <div className="note-date-picker">
    {!m.eventId && (!result || result.status === 'granted') && <ScrollFade enabled={!!events?.length}><div ref={list} data-testid="note-date-events" className="note-date-events" role="group" aria-label={t('Select calendar event')} onKeyDown={e => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
      const rows = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-event-id]:not(:disabled)'))
      if (!rows.length) return
      e.preventDefault()
      const index = rows.indexOf(document.activeElement as HTMLButtonElement)
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : (index + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length
      rows[next].focus({ preventScroll: true }); rows[next].scrollIntoView({ block: 'nearest', container: 'nearest' } as ScrollIntoViewOptions)
    }}>
      {!result ? loading
        : !result.events.length ? <p data-testid="note-date-events-none">{t('No events')}</p>
        : nearestEvents(events!, m.startedAt).map(e => <button key={e.id} data-event-id={e.id} data-testid="note-date-event" className="note-date-event" disabled={linking} onClick={() => void link(e.id)}>
          <span><span className="sr-only">{t('Select calendar event')} </span><strong>{e.title || t('Meeting')}</strong><small>{timeOf(e.start)} – {timeOf(e.end)}</small>{e.calendar?.name && <small>{e.calendar.name}</small>}</span>
          <Plus size={15} aria-hidden="true" className="shrink-0 text-muted" />
        </button>)}
    </div></ScrollFade>}
    {m.eventId && <button ref={unlink} data-testid="note-date-unlink" className="note-date-link" disabled={linking} onClick={() => void link(null)}><Link2Off size={14} aria-hidden="true" /><span>{t('Unlink calendar event')}<small>{t('Keep the title, attendees and notes.')}</small></span></button>}
    {linkError && <p role="alert" className="text-xs text-danger">{t("Yogurt couldn't update the calendar link. Try again.")}</p>}
  </div>
}

// Capture before DOM changes so the exit copy never remounts React controls or their effects.
type DateBodySnapshot = { height: number; copy: HTMLDivElement } | null
export class NoteDateBody extends Component<{ view: string; children: ReactNode }> {
  private shell = createRef<HTMLDivElement>()
  private body = createRef<HTMLDivElement>()
  private animations: Animation[] = []
  private copy: HTMLDivElement | null = null
  private stop = () => {
    this.animations.forEach(animation => animation.cancel())
    this.animations = []
    this.copy?.remove(); this.copy = null
  }
  getSnapshotBeforeUpdate(previous: Readonly<{ view: string; children: ReactNode }>): DateBodySnapshot {
    const shell = this.shell.current, body = this.body.current
    if (previous.view === this.props.view || !shell || !body || window.matchMedia('(prefers-reduced-motion: reduce)').matches || !parseFloat(getComputedStyle(shell).getPropertyValue('--note-date-ms'))) return null
    const copy = body.cloneNode(true) as HTMLDivElement
    copy.inert = true; copy.setAttribute('aria-hidden', 'true')
    copy.querySelectorAll('[id],[data-testid],[autofocus]').forEach(node => { node.removeAttribute('id'); node.removeAttribute('data-testid'); node.removeAttribute('autofocus') })
    copy.querySelectorAll('[data-focus-ring],[data-quiet-focus]').forEach(node => { node.removeAttribute('data-focus-ring'); node.removeAttribute('data-quiet-focus') })
    copy.classList.add('note-date-retiring')
    return { height: shell.getBoundingClientRect().height, copy }
  }
  componentDidUpdate(_previous: unknown, _state: unknown, snapshot: DateBodySnapshot) {
    if (!snapshot) {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) this.stop()
      return
    }
    this.stop()
    const shell = this.shell.current!, body = this.body.current!
    this.copy = snapshot.copy
    shell.append(snapshot.copy)
    const style = getComputedStyle(shell)
    const options = { duration: parseFloat(style.getPropertyValue('--note-date-ms')), easing: style.getPropertyValue('--note-date-ease').trim() }
    const animations = [
      shell.animate([{ height: `${snapshot.height}px` }, { height: `${body.getBoundingClientRect().height}px` }], options),
      body.animate([{ opacity: 0 }, { opacity: 1 }], options),
      snapshot.copy.animate([{ opacity: 1 }, { opacity: 0 }], options),
    ]
    this.animations = animations
    void Promise.all(animations.map(animation => animation.finished)).then(() => { if (this.animations === animations) this.stop() }, () => {})
  }
  componentWillUnmount() { this.stop() }
  render() { return <div ref={this.shell} className="note-date-swap"><div ref={this.body} className="agenda-inspector-content">{this.props.children}</div></div> }
}
