import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { openStore } from '../src/main/store'
import { parseEvents, setCalendarOwnEmail } from '../src/main/calendar'
import { initMeetings, linkEvent, prepareMeeting, refreshEventSnapshots, startMeeting, stopMeeting, unlinkEvent } from '../src/main/meeting'
import { mergeBackup } from '../src/main/backup'
import { groupPeople, matchingOwnEmail, normalizedEmail } from '../src/shared/people'

const people = [{ name: 'Attendee One', email: 'one@studio.example' }, { name: 'Attendee Two', email: 'two@client.example' }]
const note = { title: 'Planning', startedAt: 1, endedAt: 2, eventId: null, app: null, attendees: people, state: 'done' as const }
const event = { id: 'invite', title: 'Planning', start: 1, end: 2, attendees: people, url: null, ownEmail: 'self@studio.example' }
afterEach(() => setCalendarOwnEmail(() => {}))

it('uses only a valid, known own address with an exact matching attendee domain', () => {
  expect(matchingOwnEmail(people, ['SELF@STUDIO.EXAMPLE', 'self@elsewhere.example'])).toBe('self@studio.example')
  expect(matchingOwnEmail(people, ['self@elsewhere.example', 'self@sub.studio.example'])).toBeNull()
  expect(matchingOwnEmail(people, [])).toBeNull()
  expect(matchingOwnEmail([], ['self@studio.example'])).toBeNull()
  expect(matchingOwnEmail(people, ['z@studio.example', 'a@studio.example'])).toBe('a@studio.example')
  for (const value of [null, {}, '', 'not-email', 'two@@studio.example', 'two@studio', 'two name@studio.example']) expect(normalizedEmail(value)).toBeNull()
})

it('keeps the helper own address on its event without adding it to attendees', () => {
  const known: string[] = []
  setCalendarOwnEmail(email => { known.push(email) })
  const row = { id: 'event', start: '2026-11-01T10:00:00Z', end: '2026-11-01T11:00:00Z', me: ' SELF@STUDIO.EXAMPLE ', attendees: people }
  expect(parseEvents([row])[0]).toMatchObject({ ownEmail: 'self@studio.example', attendees: people })
  expect(known).toEqual(['self@studio.example'])
  expect(parseEvents([{ ...row, me: 'bad' }])[0].ownEmail).toBeUndefined()
  parseEvents([{ me: 'invalid-event@studio.example' }]); expect(known).toEqual(['self@studio.example'])
})

it('saves the event address for prepared, started and later-linked notes, and refreshes old snapshots', () => {
  const store = openStore(':memory:'); initMeetings(store)
  try {
    const prepared = prepareMeeting(event)
    expect(prepared.ownEmail).toBe(event.ownEmail)
    const started = startMeeting({ title: 'Planning', app: null, event: { ...event, id: 'other' } })
    expect(started.ownEmail).toBe(event.ownEmail); stopMeeting(started.id)
    const m = store.createMeeting(note)
    expect(linkEvent(m.id, { ...event, ownEmail: 'self@another.example' })?.ownEmail).toBe('self@another.example')
    expect(unlinkEvent(m.id)?.ownEmail).toBe('self@studio.example')
    store.updateMeeting(m.id, { attendees: [{ name: 'Visitor', email: 'one@unrelated.example' }] })
    expect(store.meeting(m.id)?.ownEmail).toBeUndefined()
    const old = store.createMeeting({ ...note, eventId: event.id })
    expect(old.ownEmail).toBeUndefined()
    refreshEventSnapshots([event])
    expect(store.meeting(old.id)?.ownEmail).toBe(event.ownEmail)
    expect(store.meeting(old.id)?.attendees).toEqual(people)
    refreshEventSnapshots([]); expect(store.meeting(old.id)?.ownEmail).toBe(event.ownEmail)
    const rows = [{ p: { name: 'Sample Self', email: store.meeting(old.id)!.ownEmail! }, mine: true }, ...people.map(p => ({ p }))]
    expect(groupPeople(rows).find(g => g.domain === 'studio.example')?.people).toEqual([rows[0], rows[1]])
  } finally { store.close() }
})

it('retains event and fallback addresses after reopening without calendar access, and merges them in backups', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-own-')), file = join(dir, 'notes.db')
  let store = openStore(file)
  const into = openStore(':memory:')
  try {
    const linked = store.createMeeting({ ...note, eventId: event.id, ownEmail: event.ownEmail })
    const unlinked = store.createMeeting(note)
    store.rememberOwnEmail('second@client.example')
    store.close(); store = openStore(file)
    expect(store.meeting(linked.id)?.ownEmail).toBe(event.ownEmail)
    expect(store.meeting(unlinked.id)?.ownEmail).toBe('second@client.example')
    into.rememberOwnEmail('local@elsewhere.example')
    mergeBackup(into.db, store.db)
    expect(into.meeting(linked.id)?.ownEmail).toBe(event.ownEmail)
    expect(into.meeting(unlinked.id)?.ownEmail).toBe('second@client.example')
    expect(into.ownEmails()).toEqual(['local@elsewhere.example', 'second@client.example', 'self@studio.example'])
  } finally { store.close(); into.close(); rmSync(dir, { recursive: true, force: true }) }
})
