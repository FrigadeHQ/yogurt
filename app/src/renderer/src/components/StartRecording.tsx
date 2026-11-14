import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Menu } from '@base-ui/react/menu'
import { ChevronDown } from 'lucide-react'
import { Mic } from './Icons'
import { toasts } from './TrashToast'
import { t } from '../../../shared/i18n'
import type { AgendaEvent } from '../../../shared/types'
import { eventPhase, recordingChoices } from '../agenda'
import { useDay } from '../dates'
import { personName } from './People'

let lastRecording: boolean | undefined

/** A fresh recording from a library destination; main owns capture and opening the note. */
export function StartRecording({ onStarted, testId = 'start-recording' }: { onStarted?: (id: string) => void; testId?: string }) {
  const [actions, setActions] = useState<HTMLElement | null>(null)
  const [recording, setRecording] = useState(lastRecording)
  const [starting, setStarting] = useState(false)
  const [events, setEvents] = useState<AgendaEvent[]>([])
  const [now, setNow] = useState(Date.now)
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const seq = useRef(0)
  const today = useDay()
  const load = useCallback(async () => {
    const mine = ++seq.current
    try {
      const day = await window.yogurt.calendar.day(Date.now())
      if (mine === seq.current) { setEvents(day.status === 'granted' ? day.events : []); setNow(Date.now()) }
    } catch { if (mine === seq.current) setEvents([]) }
  }, [])
  useEffect(() => {
    if (!window.yogurt.capabilities.calendar) return
    setEvents([])
    void load()
    const refresh = () => { setNow(Date.now()); void load() }
    const timer = setInterval(refresh, 60_000)
    const off = window.yogurt.calendar.onChange(() => { setEvents([]); refresh() })
    window.addEventListener('focus', refresh)
    return () => { seq.current++; off(); clearInterval(timer); window.removeEventListener('focus', refresh) }
  }, [load, today])
  useEffect(() => {
    // Switch at the live/soon boundaries, even between calendar refreshes.
    const at = Date.now()
    const next = Math.min(at + 60_000, ...events.flatMap(event => [event.start - 15 * 60_000, event.start, event.end]).filter(time => time > at))
    const timer = setTimeout(() => setNow(Date.now()), next - at)
    return () => clearTimeout(timer)
  }, [events, now])
  useLayoutEffect(() => {
    setActions(document.getElementById('workspace-actions'))
    let active = true, updated = false
    const off = window.yogurt.widget.onState((view) => { updated = true; setRecording(lastRecording = view?.kind === 'recording') })
    void window.yogurt.widget.state().then((view) => { if (active && !updated) setRecording(lastRecording = view?.kind === 'recording') })
    return () => { active = false; off() }
  }, [])
  const start = async (eventId: string | null) => {
    if (starting || recording !== false) return
    setStarting(true); setOpen(false); toasts.close('start-recording-message')
    try {
      const result = await window.yogurt.meetings.start(eventId)
      if ('error' in result) {
        if (result.error === 'gone') { setEvents([]); void load() }
        toasts.add({ id: 'start-recording-message', data: { testId: 'start-recording-message' }, title: result.error === 'gone' ? t('That meeting is no longer on your calendar.') : t("Yogurt couldn't start the notes. Try again in a moment.") })
        return
      }
      if (!result.alreadyRecording) onStarted?.(result.id)
    } catch {
      toasts.add({ id: 'start-recording-message', data: { testId: 'start-recording-message' }, title: t("Yogurt couldn't start the notes. Try again in a moment.") })
    } finally { setStarting(false) }
  }
  const choices = recordingChoices(events, now)
  useEffect(() => { if (recording !== false || !choices.length) setOpen(false) }, [recording, choices.length])
  if (recording !== false || !actions) return null
  const live = choices.filter(event => eventPhase(event, now) === 'live')
  const label = live.length === 1 ? t('Take notes · {title}', { title: live[0].title || t('Meeting') })
    : live.length > 1 ? t('Take notes · {count} now', { count: live.length }) : t('Start recording')
  const content = <><Mic size={14} aria-hidden="true" /><span className="recording-label">{label}</span></>
  const button = { 'data-testid': testId, disabled: starting, title: label, className: 'workspace-button primary recording-main no-drag' }
  return createPortal(<Menu.Root modal={false} open={open && choices.length > 0} onOpenChange={setOpen}>
    <div ref={root} className="recording-split no-drag" data-split={choices.length > 0}>
      {live.length > 1 ? <Menu.Trigger {...button}>{content}</Menu.Trigger>
        : <button {...button} onClick={() => void start(live[0]?.id ?? null)}>{content}</button>}
      {choices.length > 0 && <Menu.Trigger data-testid="recording-choices" disabled={starting} className="workspace-button primary recording-chevron no-drag" aria-label={t('More for “{name}”', { name: t('Start recording') })} title={t('More')}><ChevronDown size={13} aria-hidden="true" /></Menu.Trigger>}
    </div>
    {choices.length > 0 && <Menu.Portal>
      <Menu.Positioner anchor={root} side="bottom" align="end" sideOffset={8} className="ask-menu-positioner">
        <Menu.Popup className="menu-entry ask-actions-menu recording-menu" aria-label={t('Start recording')} onKeyDown={e => { if (e.key === 'Escape') e.stopPropagation() }}>
          {choices.map(event => <Menu.Item key={event.id} data-testid="recording-meeting" label={event.title || t('Meeting')} disabled={starting} onClick={() => void start(event.id)}>
            <span className="recording-meeting-copy"><span title={event.title || t('Meeting')}>{event.title || t('Meeting')}</span>{event.attendees.length > 0 && <small>{event.attendees.map(person => personName(person.name)).join(', ')}</small>}</span>
            <span className="recording-timing">{eventPhase(event, now) === 'live' ? t('Now') : t('in {count} min', { count: Math.ceil((event.start - now) / 60_000) })}</span>
          </Menu.Item>)}
          <Menu.Separator className="recording-menu-separator" />
          <Menu.Item data-testid="recording-unattached" disabled={starting} onClick={() => void start(null)}><Mic size={14} aria-hidden="true" />{t('Start recording')}</Menu.Item>
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>}
  </Menu.Root>, actions)
}
