import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openStore, type Store } from '../src/main/store'

let store: Store
beforeEach(() => { store = openStore(':memory:') })
afterEach(() => store.close())
const now = new Date(2026, 10, 12, 14)
const at = (day: number, hour = 10) => new Date(2026, 10, day, hour).getTime()
const make = (title: string, day = 10, attendees: string[] = []) => store.createMeeting({
  title, startedAt: at(day), endedAt: at(day, 11), eventId: null, app: null,
  attendees: attendees.map(name => ({ name, email: null })), state: 'done',
})
const transcript = (id: string, text: string, hidden = false) => store.addSegments([
  { meetingId: id, text, hidden, track: 'them', startMs: 0, endMs: 1000, speaker: null },
])
const search = (query: string, folder?: string) => store.search(query, 30, folder, { now, locale: 'en-US' })
const ids = (query: string, folder?: string) => search(query, folder).map(h => h.meetingId)

describe('meeting search', () => {
  it('finds standup nov 10 by local start time, including both day boundaries', () => {
    const first = make('Team standup'), last = make('Team standup'), outside = make('Team standup', 11)
    store.updateMeeting(first.id, { startedAt: at(10, 0) })
    store.updateMeeting(last.id, { startedAt: at(11, 0) - 1 })
    store.updateMeeting(outside.id, { startedAt: at(11, 0) })
    make('Other discussion')
    expect(ids('standup nov 10')).toEqual([last.id, first.id])
    expect(search('standup nov 10').every(h => h.confident)).toBe(true)
  })

  it('finds a first name and combines words across fields and transcript lines', () => {
    const m = make('Planning', 10, ['Robin Sample'])
    const folder = store.createFolder('Launch')
    store.addToFolder(folder.id, m.id)
    store.setNotes(m.id, { mine: 'Budget approved' })
    transcript(m.id, 'Schedule milestones')
    transcript(m.id, 'Assign owners')
    expect(ids('Robin')).toEqual([m.id])
    expect(ids('launch')).toEqual([m.id])
    expect(ids('meeting with robin about planning from the launch on budget and schedule owners')).toEqual([m.id])
    expect(ids('planning missing')).toEqual([])
    expect(search('robin launch')[0].confident).toBe(true)
    expect(search('budget')[0].confident).toBe(false)
  })

  it('matches only the last word as a prefix', () => {
    const m = make('Daily standup', 10, ['Robin Sample'])
    expect(ids('stand')).toEqual([m.id])
    expect(ids('robin stand')).toEqual([m.id])
    expect(ids('rob standup')).toEqual([])
    expect(ids('tand')).toEqual([])
  })

  it('allows a single typo only in title and attendee words of at least five letters', () => {
    const m = make('Standup', 10, ['Robin Sample'])
    const other = make('Other')
    store.setNotes(other.id, { mine: 'Standup' })
    transcript(other.id, 'Standup')
    const folder = store.createFolder('Standup')
    store.addToFolder(folder.id, other.id)
    expect(ids('standap')).toEqual([m.id])
    expect(ids('robim')).toEqual([m.id])
    expect(ids('stendap')).toEqual([])
    const newerTypo = make('Standap', 12)
    expect(ids('standup')).toEqual([m.id, newerTypo.id, other.id])
  })

  it('reads only matching cards with their people, folder color and plain notes preview', () => {
    const kept = make('Planning', 10, ['Ana López'])
    const deleted = make('Other')
    const f = store.createFolder('Design', { color: 'teal', icon: 'folder' })
    store.addToFolder(f.id, kept.id)
    store.setNotes(kept.id, { enhanced: '## Decisions\n- **Ship** on Friday.' })
    store.trashMeeting(deleted.id)
    expect(ids('with Ana nov 10')).toEqual([kept.id])
    expect(store.meetingCards({ ids: [kept.id, deleted.id], limit: 2 })).toMatchObject([
      { id: kept.id, attendees: [{ name: 'Ana López' }], folders: [{ name: 'Design', color: 'teal' }], preview: 'Ship on Friday.' },
    ])
  })

  it('filters yesterday even without other words and returns nothing for a miss', () => {
    const yesterday = make('Planning', 11)
    make('Planning', 12)
    expect(ids('yesterday')).toEqual([yesterday.id])
    expect(ids('planning yesterday')).toEqual([yesterday.id])
    expect(ids('unfindable')).toEqual([])
    expect(ids('meeting with the')).toEqual([])
  })

  it('ranks title, attendee/folder, notes, then transcript; recency breaks ties', () => {
    const title = make('Launch', 1)
    const attendee = make('One', 2, ['Launch'])
    const folderMeeting = make('Two', 3)
    const folder = store.createFolder('Launch')
    store.addToFolder(folder.id, folderMeeting.id)
    const notes = make('Three', 4)
    store.setNotes(notes.id, { mine: 'Launch' })
    const spoken = make('Four', 5)
    transcript(spoken.id, 'Launch')
    expect(ids('launch')).toEqual([title.id, folderMeeting.id, attendee.id, notes.id, spoken.id])
  })

  it('gives an exact phrase a bonus within a field tier', () => {
    const phrase = make('Launch planning', 1)
    const separated = make('Planning for launch', 2)
    expect(ids('launch planning')).toEqual([phrase.id, separated.id])
    const notePhrase = make('One', 3), noteSeparated = make('Two', 4)
    store.setNotes(notePhrase.id, { mine: 'Launch planning' })
    store.setNotes(noteSeparated.id, { mine: 'Planning for launch' })
    expect(ids('launch planning')).toEqual([phrase.id, separated.id, notePhrase.id, noteSeparated.id])
  })

  it('respects folder scope, Trash and hidden transcript lines for every term', () => {
    const inside = make('Standup'), outside = make('Standup'), trashed = make('Standup')
    const folder = store.createFolder('Project')
    store.addToFolder(folder.id, inside.id)
    store.addToFolder(folder.id, trashed.id)
    store.trashMeeting(trashed.id)
    transcript(inside.id, 'Hiddenword', true)
    expect(ids('standup nov 10', folder.id)).toEqual([inside.id])
    expect(ids('project', folder.id)).toEqual([inside.id])
    expect(ids('hiddenword')).toEqual([])
    expect(ids('nov 10')).toContain(outside.id)
    expect(ids('nov 10')).not.toContain(trashed.id)
  })
})

describe('attendee filters', () => {
  const person = { name: 'Riley Example', email: 'riley@example.test' }
  const attending = (day: number, people = [person]) => {
    const m = make('Planning', day)
    store.updateMeeting(m.id, { attendees: people })
    return m
  }

  it('combines people with an inclusive date range', () => {
    const first = attending(8), last = attending(10)
    attending(7); attending(11); make('Planning', 9)
    expect(ids('Riley Example nov 8 - 10')).toEqual([last.id, first.id])
  })

  it.each(['may I ask', 'march on', 'sunday standup'])('finds a meeting titled %s without inventing a date filter', title => {
    const meeting = make(title, 10)
    expect(ids(title)).toEqual([meeting.id])
  })

  it('finds all attended meetings by exact name or email, not mentions in notes or titles', () => {
    const first = attending(10), second = attending(11, [{ name: 'Riley', email: 'RILEY@EXAMPLE.TEST' }])
    const mention = make('Riley Example', 12)
    store.setNotes(mention.id, { mine: 'riley@example.test' })
    expect(ids('Riley Example')).toEqual([second.id, first.id])
    expect(ids('RILEY@EXAMPLE.TEST')).toEqual([second.id, first.id])
    expect(store.searchPeople()).toEqual([person])
  })

  it('keeps partial names as ordinary text matches until a person is chosen', () => {
    const attended = attending(10), title = make('Riley discussion', 11)
    expect(ids('Ril')).toEqual([title.id, attended.id])
    expect(store.search('', Infinity, undefined, { people: [person] }).map(h => h.meetingId)).toEqual([attended.id])
  })

  it('combines automatic and chosen person filters with dates and folder scope', () => {
    const onDay = attending(10), anotherDay = attending(11)
    make('Planning', 10)
    expect(ids('Riley Example nov 10')).toEqual([onDay.id])
    expect(ids('riley@example.test nov 10')).toEqual([onDay.id])
    const chosen = store.search('nov 10', Infinity, undefined, { now, people: [person] })
    expect(chosen.map(h => h.meetingId)).toEqual([onDay.id])
    const folder = store.createFolder('Project')
    store.addToFolder(folder.id, anotherDay.id)
    expect(ids('Riley Example', folder.id)).toEqual([anotherDay.id])
    expect(ids('Riley Example nov 10', folder.id)).toEqual([])
  })

  it('falls back to names without emails and never includes trashed meetings', () => {
    const noEmail = { name: 'Casey Sample', email: null }
    const first = make('Planning', 10, [noEmail.name])
    const removed = make('Planning', 11, [noEmail.name])
    store.trashMeeting(removed.id)
    expect(ids(noEmail.name)).toEqual([first.id])
    expect(store.searchPeople()).toEqual([noEmail])
    store.trashMeeting(first.id)
    expect(store.searchPeople()).toEqual([])
  })

  it('requires a choice for shared names and filters that choice by email', () => {
    const other = { ...person, email: 'different@example.test' }
    const first = attending(10), second = attending(11, [other])
    expect(store.searchPeople()).toHaveLength(2)
    expect(ids(person.name)).toEqual([second.id, first.id])
    expect(store.search('', Infinity, undefined, { people: [person] }).map(h => h.meetingId)).toEqual([first.id])
    expect(store.search(person.name, Infinity, undefined, { people: [person] }).map(h => h.meetingId)).toEqual([first.id])
    expect(ids(other.email)).toEqual([second.id])
  })

  it('strips a completed single-word name before searching, including with a date', () => {
    const single = { name: 'Casey', email: 'casey@example.test' }
    const first = attending(10, [single]), second = attending(11, [single])
    const scoped = (query: string) => store.search(query, Infinity, undefined, { now, people: [single] }).map(h => h.meetingId)
    expect(scoped('Casey')).toEqual([second.id, first.id])
    expect(scoped('Casey yesterday')).toEqual([second.id])
  })
})
