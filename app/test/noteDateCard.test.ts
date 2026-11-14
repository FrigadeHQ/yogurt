import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { timeOf } from '../src/renderer/src/dates'
import { NoteDate } from '../src/renderer/src/components/NoteDate'
import type { CalEvent, CalendarStatus, Meeting } from '../src/shared/types'
import { LOCALES, setLanguage, t } from '../src/shared/i18n'

// SSR supplies settled hook states; interactions and async reads are covered by the CI spec.
const state = vi.hoisted(() => ({ values: [] as unknown[], index: 0, keyboard: false, focusEffect: undefined as undefined | { run: () => void; previous: { current: unknown } } }))
vi.mock('react', async importOriginal => {
  const react = await importOriginal<typeof import('react')>()
  return { ...react,
    useState: (initial: unknown) => react.useState(state.index < state.values.length ? state.values[state.index++] : initial),
    useRef: (initial: unknown) => react.useRef(initial === false ? state.keyboard : initial),
    useEffect: (effect: () => void, deps?: unknown[]) => {
      // Capture the picker's focus effect; browser refs are absent during SSR, so it uses its fallback.
      if (deps?.length === 4 && typeof deps[1] === 'boolean' && deps[3] && typeof deps[3] === 'object' && 'current' in deps[3]) state.focusEffect = { run: effect, previous: deps[3] }
      react.useEffect(effect, deps)
    },
  }
})
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 10, 13)) })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); setLanguage('en') })
const at = +new Date(2026, 10, 10, 12, 24)
const meeting = { id: 'note', title: 'Planning', startedAt: at, durationMs: 420_000, eventId: null, attendees: [], state: 'done' } as unknown as Meeting
function render(status?: CalendarStatus, { picking = false, linked = false, calendar = true, day = at, linking = false, loading = false, compact = false, keyboard = false, snapshot = {} as Partial<Meeting>, event = null as CalEvent | null, events = [] as CalEvent[] } = {}) {
  vi.stubGlobal('window', { yogurt: { capabilities: { calendar } }, matchMedia: () => ({ matches: false }) })
  state.index = 0; state.keyboard = keyboard; state.focusEffect = undefined
  state.values = ['keyboard', { value: 'keyboard', pointer: false }, 0, picking, day, status ? { status, events: event ? [event, ...events.filter(e => e.id !== event.id)] : events } : undefined, linking, compact, false, loading ? 'skeleton' : 'waiting', linked ? 'event' : null]
  return renderToStaticMarkup(createElement(NoteDate, { m: { ...meeting, ...snapshot, eventId: linked ? 'event' : null } }))
}

it.each([
  ['notDetermined', 'Calendar access is off', 'Connect calendar'],
  ['denied', 'Calendar access is off', 'Open System Settings'],
  ['error', "Yogurt couldn't read your calendar", 'Try again'],
] as const)('keeps date and duration with a normal recovery action for %s', (status, message, action) => {
  for (const picking of [false, true]) {
    const html = render(status, { picking })
    expect(html).toContain('Tuesday, Nov 10')
    expect(html).toContain('7 min')
    expect(html).toContain(message.replaceAll("'", '&#x27;'))
    expect(html).toContain(`class="workspace-button agenda-open-note">${action}</button>`)
    expect(html).not.toContain('note-date-days')
    expect(html).not.toContain('note-date-previous')
    expect(html).not.toContain('note-date-next')
    expect(html).not.toContain('class="underline"')
  }
})
it('keeps empty-day navigation in the same header before and during browsing', () => {
  const html = render('granted')
  expect(html).toContain('7 min')
  expect(html).toContain('No events')
  expect(html).toContain('Link to a calendar event')
  expect(html).not.toContain('note-date-days')
  expect(html).toContain('note-date-next')
  const picker = render('granted', { picking: true })
  expect(picker).toContain('No events')
  expect(picker).toContain('note-date-next')
  expect(picker).toContain('note-date-previous')
})
it('keeps the unlinked picker ordered and separate from unlinking', () => {
  const events = [20, 1].map(n => ({ id: String(n), title: `Event ${n}`, start: at + n * 60_000, end: at + (n + 30) * 60_000, attendees: [], url: null }))
  const html = render('granted', { picking: true, events })
  expect(html).toContain('data-event-id="1"')
  expect(html.indexOf('data-event-id="1"')).toBeLessThan(html.indexOf('data-event-id="20"'))
  expect(html).not.toContain('note-date-unlink')
  expect(render('denied', { picking: true, linked: true })).toContain('note-date-unlink')
})
it('shows loading without a premature connect action and omits controls on unsupported computers', () => {
  expect(render()).not.toContain('Looking at your calendar…')
  expect(render()).not.toContain('Connect calendar')
  for (const html of [render('unsupported'), render(undefined, { calendar: false })]) {
    expect(html).toContain('7 min')
    expect(html).not.toContain('Connect calendar')
    expect(html).not.toContain('note-date-days')
    expect(html).not.toContain('note-date-previous')
    expect(html).not.toContain('note-date-next')
    expect(html).not.toContain('Looking at your calendar…')
  }
})
it('uses existing short translations for every recovery and empty state in all 32 locales', () => {
  expect(LOCALES).toHaveLength(32)
  for (const { id } of LOCALES) {
    setLanguage(id)
    for (const key of ['Calendar access is off', "Yogurt couldn't read your calendar", 'Connect calendar', 'Open System Settings', 'Try again', 'No events', 'Link event', 'Previous day', 'Next day']) {
      expect(t(key)).toBeTruthy()
      expect(t(key)).not.toMatch(/[:：—\n]/)
      if (id !== 'en') expect(t(key)).not.toBe(key)
    }
  }
})

it('shows the selected date once with day buttons and no close button', () => {
  const day = +new Date(2026, 10, 11, 12, 24)
  for (const linked of [false, true]) {
    const html = render('granted', { picking: true, linked, day })
    const header = html.match(/<div class="agenda-inspector-heading">[\s\S]*?<\/h3>[\s\S]*?<\/div><\/div>/)?.[0] ?? ''
    expect(header).toContain('Wednesday, Nov 11')
    expect(header).toContain('aria-live="polite"')
    expect(header).toContain('note-date-previous')
    expect(header.indexOf('note-date-previous')).toBeLessThan(header.indexOf('note-date-next'))
    expect(html).not.toContain('note-date-close')
    expect(html).not.toContain('aria-label="Close"')
    expect(html.match(/>Wednesday, Nov 11<\/h3>/g)).toHaveLength(1)
    expect(html).not.toContain('Tuesday, Nov 10')
    expect(html).not.toContain('note-date-days')
  }
})
it('keeps the meeting date as the linked detail heading and locks navigation while linking', () => {
  const html = render('granted', { linked: true })
  expect(html.match(/>Tuesday, Nov 10<\/h3>/g)).toHaveLength(1)
  expect(html).toContain('note-date-events-toggle')
  const busy = render('granted', { picking: true, linking: true })
  for (const direction of ['previous', 'next']) expect(busy).toMatch(new RegExp(`data-testid="note-date-${direction}"[^>]*disabled=""`))
})

it('places the linked actions directly under the title before details and access recovery', () => {
  const event = { id: 'event', title: 'Planning', start: at, end: at + 1_800_000, attendees: [], url: null }
  for (const status of ['granted', 'denied'] as const) {
    const html = render(status, { linked: true, picking: true, events: [event, { ...event, id: 'alias', aliases: ['event'] }], event: status === 'granted' ? event : null })
    expect(html.match(/Planning/g)).toHaveLength(1)
    expect(html).not.toContain('data-event-id="event"')
    expect(html).not.toContain('data-event-id="alias"')
    expect(html.indexOf('note-date-events-toggle')).toBeLessThan(html.indexOf('note-date-unlink'))
    expect(html.indexOf('note-date-unlink')).toBeLessThan(html.indexOf('note-date-details'))
    if (status === 'denied') expect(html.indexOf('note-date-unlink')).toBeLessThan(html.indexOf('Open System Settings'))
  }
})
it('omits the waiting placeholder entirely, then uses the delayed app skeleton', () => {
  expect(render()).not.toContain('loading-placeholder')
  const html = render(undefined, { loading: true })
  expect(html).toContain('data-loading-phase="skeleton"')
  expect(html).toContain('loading-mask')
  expect(html).toContain('loading-bar')
  expect(html).not.toContain('Connect calendar')
})
it('keeps the year for dates outside the current year', () => {
  expect(render('granted', { picking: true, day: +new Date(2025, 10, 11) })).toContain('2025')
})

it('uses an abbreviated weekday while retaining the full accessible date when space is tight', () => {
  setLanguage('pt-BR')
  const html = render('granted', { picking: true, day: +new Date(2025, 2, 24), compact: true })
  expect(html).toContain('aria-label="segunda-feira, 24 de mar. de 2025"')
  expect(html).toContain('>seg., 24 de mar. de 2025</h3>')
})

it('shows only Unlink and its description for linked notes, regardless of calendar results', () => {
  const event = { id: 'other', title: 'Design review', start: at, end: at + 1_800_000, attendees: [], url: null }
  for (const status of [undefined, 'granted', 'denied', 'error'] as const) {
    for (const events of [[], [event]]) {
      const html = render(status, { linked: true, picking: true, events })
      expect(html).not.toContain('data-testid="note-date-events"')
      expect(html).not.toContain('data-testid="note-date-event"')
      expect(html).not.toContain('Switch to')
      expect(html).not.toContain('Design review')
      expect(html).toContain('Unlink calendar event')
      expect(html).toContain('Keep the title, attendees and notes.')
    }
  }
  const unlinked = render('granted', { events: [event] })
  expect(unlinked).toContain('Link event')
  expect(unlinked).not.toContain('data-testid="note-date-events"')
  const choosing = render('granted', { picking: true, events: [event] })
  expect(choosing).toContain('Design review')
  expect(choosing).not.toContain('note-date-unlink')
})
it('keeps A details visible while the attached picker stays mounted and becomes inert when closed', () => {
  for (const picking of [false, true]) {
    const html = render('granted', { linked: true, picking })
    const picker = html.match(/class="accordion note-date-motion note-date-picker-motion"[^>]*>/)?.[0]
    const details = html.match(/class="accordion note-date-motion note-date-details-motion"[^>]*>/)?.[0]
    expect(picker).toContain(`data-open="${picking}"`)
    expect(details).toContain('data-open="true"')
    expect(details).not.toContain('inert=')
    expect(details).not.toContain('aria-hidden="true"')
    expect(picker).toContain(`aria-hidden="${!picking}"`)
    if (picking) expect(picker).not.toContain('inert=')
    else expect(picker).toContain('inert=""')
    expect(html).toContain('note-date-unlink')
    expect(html).toContain('7 min')
  }
})

it('keeps the linked title, time range and calendar when access is off, using the saved snapshot', () => {
  const snapshot = { title: 'My renamed note', eventTitle: 'Calendar title', eventStartedAt: at + 3_600_000, eventEndedAt: at + 5_400_000, eventCalendarName: 'Work', eventCalendarSource: 'Team calendar' }
  const event = { id: 'event', title: snapshot.eventTitle, start: snapshot.eventStartedAt, end: snapshot.eventEndedAt, attendees: [], url: null, calendar: { id: 'work', name: 'Work', source: 'Team calendar' } }
  for (const status of ['granted', 'denied'] as const) {
    const html = render(status, { linked: true, snapshot, event: status === 'granted' ? event : null })
    expect(html).toContain('Calendar title')
    expect(html).not.toContain('My renamed note')
    expect(html).toContain(`${timeOf(event.start)} – ${timeOf(event.end)}`)
    expect(html).toContain('Work')
    expect(html).toContain('Team calendar')
    expect(html).not.toContain('7 min')
    if (status === 'denied') {
      expect(html).toContain('Calendar access is off')
      expect(html).toContain('Open System Settings')
    }
  }
  const legacy = render('denied', { linked: true })
  expect(legacy).toContain('7 min')
  expect(legacy).not.toContain('agenda-inspector-footer')
})

it.each([false, true])('only moves picker focus for keyboard activation, keyboard=%s', keyboard => {
  for (const picking of [false, true]) {
    render('granted', { linked: true, picking, keyboard })
    const effect = state.focusEffect!
    expect(effect).toBeDefined()
    const focus = vi.fn()
    effect.previous.current = { focus }
    effect.run()
    expect(focus).toHaveBeenCalledTimes(keyboard && picking ? 1 : 0)
  }
})
