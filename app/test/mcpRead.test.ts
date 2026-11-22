import { describe, expect, it } from 'vitest'
import { setup, call, json, EVENT } from './mcpRig'

describe('reading more through MCP', () => {
  it("ask gives Yogurt's own answer with its sources, read from the folder or meetings named", async () => {
    const { mcp, store, older, calls } = setup()
    const f = store.createFolder('Finance')
    const got = await json(mcp, 'ask', { question: 'What happened to travel?', folder: 'finance', meeting_ids: [older.id] })
    expect(got).toEqual({ answer: 'Travel stays flat [1].', sources: [{ n: 1, meeting_id: older.id, title: 'Budget review', start: '2026-11-01T17:00:00.000Z', at: '01:05', excerpt: 'Travel spend is down a little.' }] })
    expect(calls).toContainEqual(['ask', 'What happened to travel?', [{ kind: 'folder', id: f.id }, { kind: 'meeting', id: older.id }]])
  })
  it('ask says plainly when the notes model is not there yet, or a recording needs the room', async () => {
    for (const unavailable of ['model', 'recording'] as const) {
      const { mcp } = setup({ app: { ask: async () => ({ unavailable }) } })
      const r = await call(mcp, 'ask', { question: 'Anything?' })
      expect(r).toMatchObject({ isError: true, text: expect.stringContaining(unavailable === 'model' ? 'still downloading' : 'recording') })
    }
  })
  it('ask needs a question, and meetings that are there', async () => {
    const { mcp } = setup()
    expect(await call(mcp, 'ask', {})).toMatchObject({ isError: true, text: 'question is needed.' })
    expect(await call(mcp, 'ask', { question: 'x', meeting_ids: ['nope'] })).toMatchObject({ isError: true, text: expect.stringContaining('No meeting') })
    expect(await call(mcp, 'ask', { question: 'x'.repeat(4001) })).toMatchObject({ isError: true, text: expect.stringContaining('too long') })
  })
  it('gives what is coming up and one day of the calendar, with call links and the note there is for an event', async () => {
    const { mcp, store, calls } = setup()
    const note = store.createMeeting({ title: 'Pricing sync', startedAt: EVENT.start, endedAt: null, eventId: EVENT.id, app: null, attendees: [], state: 'prepared' })
    const want = [{ event_id: 'evt-9', title: 'Pricing sync', start: '2026-11-21T15:00:00.000Z', end: '2026-11-21T15:30:00.000Z', calendar: 'Work', meeting_link: 'https://meet.example.com/abc',
      attendees: [{ name: 'Dana Smith', email: 'dana@acme.com' }], meeting_id: note.id }]
    expect(await json(mcp, 'upcoming_meetings')).toEqual(want)
    expect(await json(mcp, 'calendar_day', { date: '2026-11-21' })).toEqual(want)
    const asked = calls.find((c) => c[0] === 'calendarDay')![1] as number
    expect([new Date(asked).getFullYear(), new Date(asked).getMonth(), new Date(asked).getDate()]).toEqual([2026, 10, 21])
    expect(await call(mcp, 'calendar_day', { date: 'next week' })).toMatchObject({ isError: true, text: expect.stringContaining('must be a date') })
  })
  it('says where to connect a calendar when it has none', async () => {
    const { mcp } = setup({ app: { comingUp: async () => ({ status: 'denied', events: [] }) } })
    expect(await call(mcp, 'upcoming_meetings')).toMatchObject({ isError: false, text: expect.stringContaining('Settings, Calendars') })
  })
  it('lists the people in meetings, and narrows list_meetings and search to one of them by name or email', async () => {
    const { mcp, older } = setup()
    expect(await json(mcp, 'list_people')).toEqual([{ name: 'Ann Lee', email: 'ann@acme.com' }])
    expect((await json(mcp, 'list_meetings', { person: 'ann@acme.com' })).map((m: { id: string }) => m.id)).toEqual([older.id])
    expect((await json(mcp, 'list_meetings', { person: 'ann lee' })).map((m: { id: string }) => m.id)).toEqual([older.id])
    expect((await json(mcp, 'search', { query: 'travel', person: 'Ann Lee' })).map((h: { meeting_id: string }) => h.meeting_id)).toEqual([older.id])
    const r = await call(mcp, 'list_meetings', { person: 'Ann Smith' })
    expect(r).toMatchObject({ isError: true, text: expect.stringContaining('Ann Lee <ann@acme.com>') })
  })
  it('lists the Trash, which other reading tools never show', async () => {
    const { mcp, store, older } = setup()
    store.trashMeeting(older.id, Date.parse('2026-11-10T09:00:00Z'))
    expect(await json(mcp, 'list_trash')).toEqual([{ id: older.id, title: 'Budget review', start: '2026-11-01T17:00:00.000Z', trashed_at: '2026-11-10T09:00:00.000Z' }])
  })
  it('gives the settings that shape notes', async () => {
    const { mcp } = setup()
    expect(await json(mcp, 'get_settings')).toEqual({ my_name: 'Sam Rivera', interface_language: 'en', spoken_language: 'en (English only)', summary_language: "each meeting's own language",
      custom_words: ['Acme'], stop_recording_when_call_ends: true, keep_audio_recordings: false })
  })
  it("exports a meeting as the same Markdown Export Markdown saves, with either side's notes", async () => {
    const { mcp, older } = setup()
    const md = (await call(mcp, 'export_meeting', { id: older.id })).text
    expect(md).toMatch(/^# Budget review\n/)
    expect(md).toContain('With: Ann Lee')
    expect(md).toContain('- Travel stays flat.')
    expect(md).toContain('Travel spend is down a little.')
    expect((await call(mcp, 'export_meeting', { id: older.id, side: 'my_notes' })).text).toContain('travel flat')
    expect(await call(mcp, 'export_meeting', { id: older.id, side: 'both' })).toMatchObject({ isError: true })
  })
  it('says which folder Yogurt suggests for a meeting not filed yet', async () => {
    const { mcp, store, older } = setup()
    const f = store.createFolder('Finance')
    store.saveFolderSuggestion(older.id, { folderId: f.id, confidence: 0.9 }, 'v')
    expect((await json(mcp, 'get_meeting', { id: older.id })).suggested_folder).toEqual({ id: f.id, name: 'Finance' })
    store.addToFolder(f.id, older.id)
    expect((await json(mcp, 'get_meeting', { id: older.id })).suggested_folder).toBeNull()
  })
})
