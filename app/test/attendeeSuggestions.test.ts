import { expect, it } from 'vitest'
import { openStore } from '../src/main/store'
import { attendeeSuggestions } from '../src/shared/searchPeople'

it('ranks saved attendees by most recent meeting and resolves remembered names', () => {
  const store = openStore(':memory:')
  try {
    const older = { name: 'Guest Alpha', email: 'alpha@example.test' }
    const newer = { name: 'Guest Beta', email: 'beta@example.test' }
    const create = (startedAt: number, attendees: typeof older[]) => store.createMeeting({ title: 'Planning', startedAt,
      endedAt: startedAt + 1, eventId: null, app: null, attendees, state: 'done' })
    create(1, [older]); create(2, [newer]); create(3, [newer])
    const known = store.searchPeople()
    expect(attendeeSuggestions('Gue', known, [], '')).toEqual([newer, older])
    expect(attendeeSuggestions('Guest Beta', known, [], '')).toEqual([newer])
    expect(attendeeSuggestions('beta@', known, [], '')).toEqual([newer])
  } finally { store.close() }
})

it('excludes the owner and existing attendees by normalized name or email, deduplicates, and caps at five', () => {
  const people = Array.from({ length: 9 }, (_, i) => ({ name: `Guest Person${i}`, email: `person${i}@example.test` }))
  const selected = [{ name: 'Renamed person', email: ' PERSON1@EXAMPLE.TEST ' }, { name: ' GUEST  PERSON2 ', email: null }]
  expect(attendeeSuggestions('Gue', [...people, people[3]], selected, ' guest person0 ')).toEqual(people.slice(3, 8))
  expect(attendeeSuggestions('', people, [], '')).toEqual([])
  expect(attendeeSuggestions('Unlisted attendee', people, [], '')).toEqual([])
})

it('includes calendar-only invitees after saved people and keeps an email when choosing an exact name', () => {
  const known = { name: 'Guest Beta', email: 'beta@example.test' }
  const invitee = { name: 'Guest Alpha', email: 'alpha@example.test' }
  expect(attendeeSuggestions('Guest', [known, invitee, known], [], '')).toEqual([known, invitee])
  expect(attendeeSuggestions('Guest Alpha', [known, invitee], [], '')).toEqual([invitee])
})


it('excludes calendar aliases of the owner by their remembered email identity', () => {
  const owner = { name: 'Guest Example', email: 'owner@example.test' }
  const alias = { name: 'Guest', email: 'OWNER@example.test' }
  expect(attendeeSuggestions('Guest', [owner, alias], [], 'Guest Example')).toEqual([])
})

it('prioritizes this occurrence and its aliases, then recency, then other invitees, before the cap', () => {
  const people = Array.from({ length: 7 }, (_, i) => ({ name: `Guest ${i}`, email: `guest${i}@example.test` }))
  const [recent, older, own, other] = people
  const events = [
    { id: 'other', title: 'Other event', start: 1, end: 2, url: null, attendees: [other] },
    { id: 'current', aliases: ['alias'], title: 'Current event', start: 3, end: 4, url: null, attendees: [own, older] },
  ]
  for (const id of ['current', 'alias']) {
    expect(attendeeSuggestions('Guest', [recent, older], [], '', events, id)).toEqual([own, older, recent, other])
    expect(attendeeSuggestions('Guest', people, [], '', events, id)).toEqual([own, older, recent, other, people[4]])
  }
  expect(attendeeSuggestions('Guest', [recent, older], [], '', events, null)).toEqual([recent, older, other, own])
})

it('hides normalized name-only duplicates in favor of email entries before taking five', () => {
  const bare = { name: ' Guest   Example ', email: null }
  const first = { name: 'guest example', email: 'first@example.test' }
  const second = { name: 'Guest Example', email: 'second@example.test' }
  for (const people of [[bare, first, second], [first, second, bare]]) {
    expect(attendeeSuggestions('Guest', people, [], '')).toEqual([first, second])
    expect(attendeeSuggestions('Guest Example', people, [], '')).toEqual([first, second])
    expect(attendeeSuggestions('Guest', people, [first], '')).toEqual([second])
  }
  expect(attendeeSuggestions('Guest', [bare], [], '')).toEqual([bare])
  expect(attendeeSuggestions('Guest', [{ ...bare, email: ' ' }, first], [], '')).toEqual([first])
  const others = Array.from({ length: 5 }, (_, i) => ({ name: `Guest ${i}`, email: null }))
  expect(attendeeSuggestions('Guest', [bare, first, ...others], [], '')).toEqual([first, ...others.slice(0, 4)])
})

it('uses the email identity even when its name-only duplicate is an invitee', () => {
  const bare = { name: 'Guest Example', email: null }
  const rich = { ...bare, email: 'guest@example.test' }
  const event = { id: 'current', title: 'Event', start: 1, end: 2, url: null, attendees: [bare] }
  expect(attendeeSuggestions('Guest', [rich], [], '', [event], event.id)).toEqual([rich])
})

it('matches the whole attendee input while preserving distinct identities and invitee order', () => {
  const first = { name: 'Guest Shared', email: 'first@example.test' }
  const second = { ...first, email: 'second@example.test' }
  const recent = { name: 'Guest Recent', email: 'recent@example.test' }
  const known = [recent, { ...first, email: null }, second]
  const event = { id: 'current', title: 'Event', start: 1, end: 2, url: null, attendees: [first] }
  for (const query of ['Guest Shared', 'Guest Sha', '  GUEST   SHARED  ', 'Shared']) {
    expect(attendeeSuggestions(query, known, [], '', [event], event.id)).toEqual([first, second])
    expect(attendeeSuggestions(query, known, [first], '', [event], event.id)).toEqual([second])
  }
  for (const query of ['Guest Unknown', 'Guest Shared extra', 'extra Guest Shared', 'recent@ invalid']) {
    expect(attendeeSuggestions(query, known, [], '', [event], event.id)).toEqual([])
  }
  expect(attendeeSuggestions('Guest', known, [], '', [event], event.id)).toEqual([first, recent, second])
  expect(attendeeSuggestions('first@', known, [], '', [event], event.id)).toEqual([first])
})
