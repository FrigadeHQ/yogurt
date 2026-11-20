import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadSettings, updateSettings } from '../src/main/settings'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { calendars, calendarStatus, meetingLink, parseEvents, refreshCalendarStatus, requestCalendarAccess, setCalendarLinkSource, setCalendarSelection, setCalendarSupported, setHelper, upcoming } from '../src/main/calendar'

const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures/helper-events.json'), 'utf8'))

describe('parseEvents', () => {
  it('orders attendees consistently across helper reads, including duplicate names', () => {
    const attendees = [{ name: 'Participant B', email: null }, { name: 'Participant A', email: 'b@example.com' },
      { name: 'Participant A', email: 'a@example.com' }, { name: 'Participant A', email: null }]
    const row = { id: 'event', start: '2026-11-03T18:00:00Z', end: '2026-11-03T19:00:00Z' }
    const expected = [attendees[3], attendees[2], attendees[1], attendees[0]]
    expect(parseEvents([{ ...row, attendees }])[0].attendees).toEqual(expected)
    expect(parseEvents([{ ...row, attendees: [...attendees].reverse() }])[0].attendees).toEqual(expected)
  })
  it('turns the helper JSON into events with times in ms, people and a meeting link', () => {
    const ev = parseEvents(fixture)
    expect(ev).toHaveLength(3)
    expect(ev[0]).toEqual({
      id: 'E1:2026-10-29T15:00:00Z', title: 'Design review',
      start: Date.parse('2026-10-29T15:00:00Z'), end: Date.parse('2026-10-29T15:30:00Z'),
      attendees: [{ name: 'Ann Lee', email: 'ann@example.com' }, { name: 'Bo', email: null }],
      url: 'https://zoom.us/j/123456789?pwd=abc',
    })
    expect(ev[1].url).toBeNull()
    expect(ev[1].attendees).toEqual([])
    expect(ev[2].url).toBe('https://teams.microsoft.com/l/meetup-join/abc')
  })
  it('keeps a meeting shared onto two calendars once (the Mac gives it twice, same id)', () => {
    const row = (calendar: string) => ({ id: 'E9:2026-11-02T18:00:00Z', title: 'Standup', start: '2026-11-02T18:00:00Z', end: '2026-11-02T18:30:00Z', calendar })
    const ev = parseEvents([row('Dana'), row('Mine'), { ...row('Mine'), id: 'E10:2026-11-02T18:00:00Z' }])
    expect(ev.map((e) => e.id)).toEqual(['E9:2026-11-02T18:00:00Z', 'E10:2026-11-02T18:00:00Z'])
  })
  it('skips rows it cannot read', () => {
    expect(parseEvents([{ title: 'x' }, null, 'no'])).toEqual([])
    expect(parseEvents({ not: 'a list' })).toEqual([])
  })
  it('combines copies by server identity and occurrence, never by title or time alone', () => {
    const row = { id: 'work-copy', externalId: 'pool-series', title: 'Lap Swim', start: '2026-11-03T17:00:00Z', end: '2026-11-03T19:00:00Z', calendarId: 'work', calendar: 'Work' }
    const ev = parseEvents([row, { ...row, id: 'personal-copy', calendarId: 'personal' },
      { ...row, id: 'next-slot', start: '2026-11-03T19:00:00Z', end: '2026-11-03T20:30:00Z' },
      { ...row, id: 'unrelated', externalId: 'other-event' }])
    expect(ev).toHaveLength(3)
    expect(ev[0].aliases).toContain('personal-copy')
    expect(ev.map((e) => e.id)).toContain('next-slot')
    expect(ev.map((e) => e.id)).toContain('unrelated')
  })
  it('hides excluded calendars but keeps aliases so existing notes remain linked', () => {
    const row = { id: 'hidden-copy', externalId: 'same-event', title: 'Standup', start: '2026-11-03T18:00:00Z', end: '2026-11-03T19:00:00Z', calendarId: 'personal', calendar: 'Personal' }
    const ev = parseEvents([row, { ...row, id: 'shown-copy', calendarId: 'work', calendar: 'Work' }], ['personal'])
    expect(ev).toHaveLength(1)
    expect(ev[0].id).toBe('shown-copy')
    expect(ev[0].aliases).toContain('hidden-copy')
    expect(ev[0].calendar).toMatchObject({ id: 'work', name: 'Work' })
    expect(parseEvents([row], ['personal'])).toEqual([])
    expect(parseEvents([row, { ...row, calendarId: 'work' }], ['personal'])).toHaveLength(1)
  })
})

describe('meetingLink', () => {
  it('finds a call link in text and ignores other links', () => {
    expect(meetingLink('Join: https://meet.google.com/abc-defg-hij thanks')).toBe('https://meet.google.com/abc-defg-hij')
    expect(meetingLink('Notes at https://docs.example.com/x')).toBeNull()
    expect(meetingLink(undefined)).toBeNull()
  })
})

describe('upcoming', () => {
  beforeEach(() => setHelper(async () => { throw new Error('no helper') }))
  afterEach(() => setCalendarSelection(() => ({})))

  it('reads source calendars only with permission and applies the saved selection on each read', async () => {
    const row = { id: 'one', title: 'Work meeting', calendarId: 'work', start: '2026-11-03T18:00:00Z', end: '2026-11-03T19:00:00Z' }
    const calls: string[] = []
    setHelper(async (args) => { calls.push(args[0]); return args[0] === 'calendar-status' ? { status: 'granted' } : args[0] === 'calendars' ? [{ id: 'work', name: 'Work', source: 'Example' }, null] : [row] })
    expect(await calendars()).toEqual([{ id: 'work', name: 'Work', source: 'Example' }])
    setCalendarSelection(() => ({ hiddenCalendarIds: ['work'] }))
    expect(await upcoming(0, 1e12)).toEqual([])
    setCalendarSelection(() => ({}))
    expect(await upcoming(0, 1e12)).toHaveLength(1)
    setHelper(async (args) => { calls.push(args[0]); return { status: 'denied' } })
    calls.length = 0
    expect(await calendars()).toEqual([])
    expect(calls).toEqual(['calendar-status'])
  })

  it('defaults off, persists the filter across reads, and preserves other settings', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'calendar-filter-'))
    const file = join(dir, 'settings.json')
    setHelper(async args => args[0] === 'calendar-status' ? { status: 'granted' } : fixture)
    setCalendarSelection(() => loadSettings(file))
    try {
      expect(await upcoming(0, 1e12)).toHaveLength(3)
      updateSettings(file, { hiddenCalendarIds: ['excluded'], theme: 'dark' })
      updateSettings(file, { hideEventsWithoutCallLink: true })
      expect(loadSettings(file)).toEqual({ hiddenCalendarIds: ['excluded'], theme: 'dark', hideEventsWithoutCallLink: true })
      expect((await upcoming(0, 1e12)).map(e => e.title)).toEqual(['Design review', 'Sync'])
      setCalendarSelection(() => loadSettings(file))
      expect(await upcoming(0, 1e12)).toHaveLength(2)
      updateSettings(file, { hideEventsWithoutCallLink: false })
      expect(await upcoming(0, 1e12)).toHaveLength(3)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it.each([true, false])('includes enabled events for manual linking with the call-link filter set to %s', async hideEventsWithoutCallLink => {
    const base = { start: '2026-11-03T18:00:00Z', end: '2026-11-03T19:00:00Z', calendarId: 'work' }
    const rows = [
      { ...base, id: 'call', url: 'https://meet.google.com/abc-defg-hij' },
      { ...base, id: 'linked' }, { ...base, id: 'busy' },
      { ...base, id: 'hidden-linked', calendarId: 'hidden' }, { ...base, id: 'hidden-call', calendarId: 'hidden', url: 'https://zoom.us/j/123456789' },
    ]
    setHelper(async args => args[0] === 'calendar-status' ? { status: 'granted' } : rows)
    setCalendarSelection(() => ({ hideEventsWithoutCallLink, hiddenCalendarIds: ['hidden'] }))
    const ids = (events: { id: string }[]) => events.map(e => e.id)
    expect(ids(await upcoming(0, 1e12, 'link-event'))).toEqual(['call', 'linked', 'busy'])
    expect(ids(await upcoming(0, 1e12, e => e.id.endsWith('linked')))).toEqual(hideEventsWithoutCallLink ? ['call', 'linked'] : ['call', 'linked', 'busy'])
    expect(ids(await upcoming(0, 1e12))).toEqual(hideEventsWithoutCallLink ? ['call'] : ['call', 'linked', 'busy'])
  })

  it('keeps noted events by alias only when requested and never restores excluded calendars', async () => {
    const row = { id: 'original', externalId: 'event', calendarId: 'work', start: '2026-11-03T18:00:00Z', end: '2026-11-03T19:00:00Z', url: 'https://example.com/document' }
    setHelper(async args => args[0] === 'calendar-status' ? { status: 'granted' } : [row, { ...row, id: 'alias' }])
    setCalendarSelection(() => ({ hideEventsWithoutCallLink: true }))
    expect(await upcoming(0, 1e12)).toEqual([])
    const keep = (event: import('../src/main/calendar').CalEvent) => event.aliases?.includes('alias') === true
    expect(await upcoming(0, 1e12, keep)).toHaveLength(1)
    setCalendarSelection(() => ({ hideEventsWithoutCallLink: true, hiddenCalendarIds: ['work'] }))
    expect(await upcoming(0, 1e12, keep)).toEqual([])
  })

  it('keeps native calendar colours and ignores missing or invalid colour values', async () => {
    setHelper(async (args) => args[0] === 'calendar-status' ? { status: 'granted' } : [
      { id: 'work', name: 'Work', color: '#3478F6' },
      { id: 'personal', name: 'Personal' },
      { id: 'invalid', name: 'Invalid', color: 'url(remote)' },
    ])
    expect(await calendars()).toEqual([
      { id: 'work', name: 'Work', source: '', color: '#3478F6' },
      { id: 'personal', name: 'Personal', source: '' },
      { id: 'invalid', name: 'Invalid', source: '' },
    ])
  })

  it('asks the helper for the window and returns parsed events', async () => {
    const calls: string[][] = []
    setHelper(async (args) => { calls.push(args); return args[0] === 'calendar-status' ? { status: 'granted' } : fixture })
    const ev = await upcoming(Date.parse('2026-10-29T14:00:00Z'), Date.parse('2026-10-29T18:00:00Z'))
    expect(ev.map((e) => e.title)).toEqual(['Design review', 'Coffee', 'Sync'])
    expect(calls.find((c) => c[0] === 'events')).toEqual(['events', '2026-10-29T14:00:00.000Z', '2026-10-29T18:00:00.000Z'])
  })

  it('access denied: no events, and the status says denied', async () => {
    let asked = false
    setHelper(async (args) => { if (args[0] === 'events') asked = true; return { status: 'denied' } })
    expect(await upcoming(0, 1e12)).toEqual([])
    expect(calendarStatus()).toBe('denied')
    expect(asked).toBe(false)
  })

  it('a helper that fails gives no events, not a crash', async () => {
    setHelper(async (args) => { if (args[0] === 'calendar-status') return { status: 'granted' }; throw new Error('boom') })
    expect(await upcoming(0, 1e12)).toEqual([])
  })

  it('refreshCalendarStatus reads the helper', async () => {
    setHelper(async () => ({ status: 'notDetermined' }))
    expect(await refreshCalendarStatus()).toBe('notDetermined')
    expect(calendarStatus()).toBe('notDetermined')
  })

  it('a helper that fails says error, not that access is off', async () => {
    setHelper(async () => { throw new Error('boom') })
    expect(await refreshCalendarStatus()).toBe('error')
    expect(await requestCalendarAccess()).toBe('error')
    setHelper(async (args) => { if (args[0] === 'calendar-status') return { status: 'granted' }; throw new Error('boom') })
    expect(await upcoming(0, 1e12)).toEqual([])
    expect(calendarStatus()).toBe('error')
  })
})

describe('a computer without a calendar (Windows, Linux)', () => {
  afterEach(() => setCalendarSupported(true))
  it('never runs the helper: unsupported, no calendars and no events, and nothing to ask', async () => {
    const calls: string[] = []
    setHelper(async (args) => { calls.push(args[0]); return { status: 'granted' } })
    setCalendarSupported(false)
    expect(await refreshCalendarStatus()).toBe('unsupported')
    expect(await requestCalendarAccess()).toBe('unsupported')
    expect(await calendars()).toEqual([])
    expect(await upcoming(0, 1e12)).toEqual([])
    expect(calendarStatus()).toBe('unsupported')
    expect(calls).toEqual([])
  })
})

describe('Windows and Linux: the calendar comes from calendar links, not the system helper', () => {
  afterEach(() => { setCalendarLinkSource(null); setCalendarSupported(true) })
  it('status, calendars and events come from the links; the helper is never asked; hidden calendars stay out', async () => {
    const asked: string[] = []
    setHelper(async (args) => { asked.push(args[0]); return null })
    setCalendarSupported(false)
    let linked = false
    setCalendarLinkSource({
      status: () => (linked ? 'granted' : 'notDetermined'),
      calendars: async () => [{ id: 'l1', name: 'Work', source: 'calendar.google.com' }, { id: 'l2', name: 'Home', source: 'example.com' }],
      events: async () => [
        { id: 'a|1', externalId: 'a', title: 'Standup', start: '2026-11-17T17:00:00.000Z', end: '2026-11-17T17:15:00.000Z', attendees: [{ name: 'Dana Smith', email: 'dana@example.com' }], url: null, location: null, notes: 'https://meet.google.com/abc-defg-hij', calendarId: 'l1', calendar: 'Work', calendarSource: 'Calendar link', me: null },
        { id: 'b|1', externalId: 'b', title: 'Dentist', start: '2026-11-17T19:00:00.000Z', end: '2026-11-17T20:00:00.000Z', attendees: [], url: null, location: null, notes: null, calendarId: 'l2', calendar: 'Home', calendarSource: 'Calendar link', me: null },
      ],
    })
    expect(await refreshCalendarStatus()).toBe('notDetermined')
    linked = true
    expect(await requestCalendarAccess()).toBe('granted')
    expect((await calendars()).map((c) => c.name)).toEqual(['Work', 'Home'])
    setCalendarSelection(() => ({ hiddenCalendarIds: ['l2'] }))
    const got = await upcoming(Date.parse('2026-11-17T00:00:00Z'), Date.parse('2026-11-18T00:00:00Z'))
    expect(got).toEqual([expect.objectContaining({ title: 'Standup', url: 'https://meet.google.com/abc-defg-hij', attendees: [{ name: 'Dana Smith', email: 'dana@example.com' }] })])
    expect(asked).toEqual([])
    setCalendarSelection(() => ({}))
  })
})

describe('a Mac: calendar links sit alongside the built-in calendar (Settings → Calendars → Add a calendar link)', () => {
  afterEach(() => { setCalendarLinkSource(null); setCalendarSupported(true); setCalendarSelection(() => ({})) })
  const linkEvent = { id: 'x|1', externalId: 'x', title: 'Book club', start: '2026-11-17T20:00:00.000Z', end: '2026-11-17T21:00:00.000Z', attendees: [], url: null, location: null, notes: null, calendarId: 'l1', calendar: 'Club', calendarSource: 'Calendar link', me: null }
  const macRow = { id: 'm1', title: 'Standup', start: '2026-11-17T17:00:00.000Z', end: '2026-11-17T17:15:00.000Z', attendees: [], calendarId: 'work', calendar: 'Work' }
  const links = (linked: boolean) => ({ status: () => (linked ? 'granted' as const : 'notDetermined' as const), calendars: async () => (linked ? [{ id: 'l1', name: 'Club', source: 'example.com' }] : []), events: async () => (linked ? [linkEvent] : []) })
  const day = [Date.parse('2026-11-17T00:00:00Z'), Date.parse('2026-11-18T00:00:00Z')] as const

  it.each(['calendar-status', 'events'])('keeps a healthy linked calendar when the Mac %s read fails', async failure => {
    setHelper(async args => {
      if (args[0] === failure) throw new Error('Calendar is unavailable')
      return args[0] === 'calendar-status' ? { status: 'granted' } : []
    })
    setCalendarLinkSource(links(true), { alongside: true })
    const unavailable: string[] = []
    expect((await upcoming(...day, undefined, unavailable)).map(event => event.title)).toEqual(['Book club'])
    expect(unavailable).toEqual(['Calendar'])
    expect(calendarStatus()).toBe('granted')
  })
  it('both: the Mac calendars and the links, their events together', async () => {
    setHelper(async (args) => args[0] === 'calendar-status' ? { status: 'granted' } : args[0] === 'calendars' ? [{ id: 'work', name: 'Work', source: 'iCloud' }] : [macRow])
    setCalendarLinkSource(links(true), { alongside: true })
    expect(await refreshCalendarStatus()).toBe('granted')
    expect((await calendars()).map((c) => c.name)).toEqual(['Work', 'Club'])
    expect((await upcoming(...day)).map((e) => e.title).sort()).toEqual(['Book club', 'Standup'])
  })
  it('a link alone, without the Mac calendar allowed, still fills the agenda; the Mac is still asked with its own prompt', async () => {
    const asked: string[] = []
    setHelper(async (args) => { asked.push(args[0]); return args[0] === 'calendar-status' || args[0] === 'calendar-auth' ? { status: 'notDetermined' } : [] })
    setCalendarLinkSource(links(true), { alongside: true })
    expect(await refreshCalendarStatus()).toBe('granted')
    expect((await upcoming(...day)).map((e) => e.title)).toEqual(['Book club'])
    await requestCalendarAccess()
    expect(asked).toContain('calendar-auth')
  })
  it('no link: exactly the Mac as before', async () => {
    setHelper(async (args) => args[0] === 'calendar-status' ? { status: 'denied' } : [])
    setCalendarLinkSource(links(false), { alongside: true })
    expect(await refreshCalendarStatus()).toBe('denied')
  })
})
