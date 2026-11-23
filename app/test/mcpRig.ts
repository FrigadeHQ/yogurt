import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import { openStore, type Store } from '../src/main/store'
import { createMcp, type Mcp, type McpApp } from '../src/main/mcp/server'
import type { CalEvent } from '../src/main/calendar'

/** A made-up Yogurt for the MCP tests: a real store with two meetings, and the app's actions recorded as calls. */
const dirs: string[] = []
const stores: Store[] = []
afterEach(() => {
  stores.splice(0).forEach((s) => s.close())
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'yogurt-mcp-')); dirs.push(d); return d }

export const EVENT: CalEvent = { id: 'evt-9', title: 'Pricing sync', start: Date.parse('2026-11-21T15:00:00Z'), end: Date.parse('2026-11-21T15:30:00Z'),
  attendees: [{ name: 'Dana Smith', email: 'dana@acme.com' }], url: 'https://meet.example.com/abc', calendar: { id: 'c1', name: 'Work', source: 'iCloud' } }

export function setup(o: { enabled?: boolean; changes?: boolean; platform?: string; app?: Partial<McpApp> } = {}) {
  const dir = tmp()
  const store = openStore(join(dir, 'yogurt.db')); stores.push(store)
  const base = { endedAt: null, eventId: null, app: 'Zoom', state: 'done' as const }
  const older = store.createMeeting({ ...base, title: 'Budget review', startedAt: Date.parse('2026-11-01T17:00:00Z'), endedAt: Date.parse('2026-11-01T17:25:00Z'), attendees: [{ name: 'Ann Lee', email: 'ann@acme.com' }] })
  const newer = store.createMeeting({ ...base, title: 'Launch plan', startedAt: Date.parse('2026-11-02T16:00:00Z'), attendees: [] })
  store.addSegments([
    { meetingId: older.id, track: 'me', startMs: 5_000, endMs: 7_000, text: 'Can we keep travel flat?', speaker: 'me' },
    { meetingId: older.id, track: 'them', startMs: 65_000, endMs: 68_000, text: 'Travel spend is down a little.', speaker: 'Ann Lee' },
    { meetingId: older.id, track: 'them', startMs: 70_000, endMs: 71_000, text: 'Sure.', speaker: null },
    { meetingId: older.id, track: 'me', startMs: 72_000, endMs: 73_000, text: 'an echo', speaker: 'me', hidden: true },
  ])
  store.setNotes(older.id, { mine: 'travel flat', enhanced: '## Budget\n- Travel stays flat.' })
  const audioDir = join(dir, 'meetings', older.id); mkdirSync(audioDir, { recursive: true })
  writeFileSync(join(audioDir, 'me.m4a'), 'x'); writeFileSync(join(audioDir, 'them.m4a'), 'x')
  let on = o.enabled ?? true
  let changes = o.changes ?? false
  const calls: Array<[string, ...unknown[]]> = []
  const logs: string[] = []
  let recording: ReturnType<Store['meeting']> | null = null
  const rec = <A extends unknown[], R>(name: string, fn: (...a: A) => R) => (...a: A): R => { calls.push([name, ...a]); return fn(...a) }
  const app: McpApp = {
    ask: rec('ask', async () => ({ answer: 'Travel stays flat [1].', sources: [{ n: 1, meetingId: older.id, title: 'Budget review', startedAt: older.startedAt, atMs: 65_000, excerpt: 'Travel spend is down a little.' }] })),
    comingUp: rec('comingUp', async () => ({ status: 'granted' as const, events: [EVENT] })),
    calendarDay: rec('calendarDay', async () => ({ status: 'granted' as const, events: [EVENT] })),
    settings: () => ({ myName: 'Sam Rivera', locale: 'en', spoken: 'en', summaryLanguage: '', jargon: ['Acme'], stopWhenCallEnds: true, retention: { audio: 0, video: 7, transcript: null, meeting: 365 } }),
    changed: rec('changed', () => {}),
    imported: rec('imported', () => {}),
    rename: rec('rename', (id: string, title: string) => { store.updateMeeting(id, { title, titleSource: 'user' }); return true }),
    setAttendees: rec('setAttendees', (id: string, people) => { store.updateMeeting(id, { attendees: people, keepAttendees: true }); return true }),
    linkEvent: rec('linkEvent', async (id: string, eventId: string) => { if (eventId !== EVENT.id) return false; store.updateMeeting(id, { eventId }); return true }),
    unlinkEvent: rec('unlinkEvent', (id: string) => { store.updateMeeting(id, { eventId: null }); return true }),
    trash: rec('trash', (id: string) => { store.trashMeeting(id); return 'trashed' as const }),
    restore: rec('restore', (id: string) => { store.restoreMeeting(id); return true }),
    setMyNotes: rec('setMyNotes', (id: string, md: string) => { store.setNotes(id, { mine: md }); return 'saved' as const }),
    setSummary: rec('setSummary', (id: string, md: string) => { store.setNotes(id, { enhanced: md, edited: true }); return 'saved' as const }),
    rewriteSummary: rec('rewriteSummary', () => 'queued' as const),
    notesReady: () => true,
    startRecording: rec('startRecording', async (s: { title?: string }) => {
      recording = store.createMeeting({ ...base, state: 'recording', title: s.title ?? 'Meeting', startedAt: Date.now(), attendees: [] })
      return { id: recording.id }
    }),
    pauseRecording: rec('pauseRecording', () => true),
    stopRecording: rec('stopRecording', () => { recording = null; return true }),
    recording: () => recording ?? null,
    setJargon: rec('setJargon', (terms: string[]) => terms),
    setSpoken: rec('setSpoken', () => true),
    setSummaryLanguage: rec('setSummaryLanguage', () => true),
    ...o.app,
  }
  const mcp = createMcp({
    store, enabled: () => on, changesEnabled: () => changes, me: () => 'Sam Rivera', version: '0.1.0', platform: o.platform, app, log: (l) => logs.push(l),
    audio: async (id) => id === older.id ? [{ track: 'me', path: join(audioDir, 'me.m4a') }, { track: 'them', path: join(audioDir, 'them.m4a') }] : [],
  })
  return { store, mcp, older, newer, dir, calls, logs, turn: (v: boolean) => { on = v }, allowChanges: (v: boolean) => { changes = v } }
}

export const call = async (mcp: Mcp, name: string, args: Record<string, unknown> = {}) => {
  const r = await mcp.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }) as { result: { content: Array<{ text: string }>; isError?: boolean } }
  return { text: r.result.content.map((c) => c.text).join('\n'), isError: !!r.result.isError }
}
export const json = async (mcp: Mcp, name: string, args: Record<string, unknown> = {}) => {
  const r = await call(mcp, name, args)
  if (r.isError) throw new Error(`${name} refused: ${r.text}`)
  return JSON.parse(r.text)
}
