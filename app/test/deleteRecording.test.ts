import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type Store } from '../src/main/store'
import { keepsRecording, loadSettings, updateSettings } from '../src/main/settings'
import { deleteRecording } from '../src/main/deleteRecording'
import { trackFile, createAudioHandler } from '../src/main/audio'
import { hookNotes } from '../src/main/notes'
import { createQueue } from '../src/main/notes/queue'

const roots: string[] = [], stores: Store[] = []
afterEach(() => { vi.useRealTimers(); stores.splice(0).forEach(s => s.close()); roots.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })) })
function setup({ transcript = true, summary = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'yogurt-recording-')); roots.push(root)
  const store = openStore(join(root, 'yogurt.db')); stores.push(store)
  const m = store.createMeeting({ title: 'Launch', startedAt: 1, endedAt: 2000, eventId: null, app: null, state: 'done', attendees: [{ name: 'Ann', email: 'ann@example.com' }] })
  if (transcript) store.addSegments([{ meetingId: m.id, track: 'them', startMs: 0, endMs: 1000, text: 'Launch on Tuesday', speaker: 'Ann' }])
  store.setNotes(m.id, { mine: 'My launch notes', ...(summary ? { enhanced: '## Launch\nTuesday' } : {}) })
  const folder = store.createFolder('Launch'); store.addToFolder(folder.id, m.id)
  store.addChatTurn(m.id, 'When is launch?')
  const dir = join(root, m.id); mkdirSync(dir)
  for (const name of ['me.m4a', 'them.ogg', 'me.wav', 'them.f32', 'me.m4a.joined', 'me.joined.m4a', 'them.joined.ogg', 'metadata.json']) writeFileSync(join(dir, name), 'fixture')
  mkdirSync(join(dir, 'original'))
  linkSync(join(dir, 'me.m4a'), join(dir, 'original', 'previous-me.m4a'))
  writeFileSync(join(dir, 'original', 'previous-them.1.ogg'), 'original recording')
  const deps = { store, dirOf: () => dir, busy: () => false, settle: async () => {}, removed: vi.fn() }
  const remove = (keep?: (endedAt: number | null) => boolean) => deleteRecording(m.id, { ...deps, ...(keep ? { keep } : {}) })
  return { root, store, m, dir, deps, remove }
}

describe('deleting only a recording', () => {
  it('removes every audio format and keeps text, people, folders, search, chat and Trash restore', async () => {
    const s = setup(), before = s.store.db.prepare('SELECT * FROM meetings').all()
    const notes = s.store.notes(s.m.id), lines = s.store.segments(s.m.id), folders = s.store.folders(), people = s.store.db.prepare('SELECT * FROM people').all()
    expect(await s.remove()).toBe('deleted')
    expect(readdirSync(s.dir)).toEqual(['metadata.json'])
    expect(s.store.db.prepare('SELECT * FROM meetings').all()).toEqual(before)
    expect(s.store.notes(s.m.id)).toEqual(notes)
    expect(s.store.segments(s.m.id)).toEqual(lines)
    expect(s.store.folders()).toEqual(folders)
    expect(s.store.db.prepare('SELECT * FROM people').all()).toEqual(people)
    expect(s.store.chatTurns(s.m.id)[0].question).toBe('When is launch?')
    expect(s.store.search('launch', 10).map(h => h.meetingId)).toContain(s.m.id)
    expect(s.store.trashMeeting(s.m.id)).toBe(true)
    s.store.restoreMeeting(s.m.id)
    expect(s.store.notes(s.m.id)).toEqual(notes)
    expect(trackFile(s.dir, 'me', ['m4a', 'wav', 'ogg'])).toBeNull()
    const handle = createAudioHandler({ dirOf: () => s.dir, known: () => true, ready: async () => {}, exts: ['m4a'] })
    expect((await handle(new Request(`yogurt-audio://${s.m.id}/me`))).status).toBe(404)
    expect(await s.remove()).toBe('deleted')
  })
  it('never deletes without a saved transcript, even with typed notes and a summary', async () => {
    const s = setup({ transcript: false })
    expect(await s.remove()).toBe('not-transcribed')
    expect(await s.remove(() => false)).toBe('not-transcribed')
    expect(existsSync(join(s.dir, 'me.m4a'))).toBe(true)
  })
  it('retains audio while transcription is pending, including old transcripts from a resumed meeting', async () => {
    const s = setup()
    s.store.updateMeeting(s.m.id, { transcriptionPending: true })
    expect(await s.remove()).toBe('not-transcribed')
    expect(await s.remove(() => false)).toBe('not-transcribed')
    const reopened = openStore(join(s.root, 'yogurt.db')); stores.push(reopened)
    expect(reopened.meeting(s.m.id)?.transcriptionPending).toBe(true)
    expect(existsSync(join(s.dir, 'me.m4a'))).toBe(true)
  })
  it('keeps recordings by default and until a nonempty summary is saved', async () => {
    const s = setup({ summary: false })
    expect(await s.remove(() => true)).toBe('kept')
    expect(await s.remove(() => false)).toBe('kept')
    s.store.setNotes(s.m.id, { enhanced: '  ' })
    expect(await s.remove(() => false)).toBe('kept')
    s.store.setNotes(s.m.id, { enhanced: 'Summary saved' })
    expect(await s.remove(() => true)).toBe('kept')
    expect(await s.remove(() => false)).toBe('deleted')
  })
  it('keeps older recordings when delayed summaries arrive, and deletes only after the current opt-out time', async () => {
    const s = setup({ summary: false }), file = join(s.root, 'settings.json')
    const keep = (endedAt: number | null) => keepsRecording(loadSettings(file), endedAt)
    updateSettings(file, { keepRecordings: false, recordingsOffAt: 2000 })
    // The meeting ended before opting out; its summary arrives afterward.
    s.store.updateMeeting(s.m.id, { endedAt: 1999 })
    s.store.setNotes(s.m.id, { enhanced: 'Delayed summary' })
    expect(await s.remove(keep)).toBe('kept')
    s.store.setNotes(s.m.id, { enhanced: 'Rewritten summary' })
    expect(await s.remove(keep)).toBe('kept')
    for (const endedAt of [null, 2000]) {
      s.store.updateMeeting(s.m.id, { endedAt })
      expect(await s.remove(keep)).toBe('kept')
    }
    // Turning it on and off again starts a new window, never a retrospective cleanup.
    s.store.updateMeeting(s.m.id, { endedAt: 3000 })
    updateSettings(file, { keepRecordings: false, recordingsOffAt: 4000 })
    expect(await s.remove(keep)).toBe('kept')
    expect(existsSync(join(s.dir, 'me.m4a'))).toBe(true)
    s.store.updateMeeting(s.m.id, { endedAt: 4001 })
    expect(await s.remove(keep)).toBe('deleted')
  })
  it('keeps recordings without a valid opt-out time, while explicit deletion still works', async () => {
    const s = setup()
    for (const recordingsOffAt of [undefined, NaN, Infinity]) {
      expect(await s.remove(endedAt => keepsRecording({ keepRecordings: false, recordingsOffAt }, endedAt))).toBe('kept')
    }
    expect(await s.remove()).toBe('deleted')
  })
  it('waits for finishing and rechecks both the preference and a resumed recording', async () => {
    const s = setup(); let release!: () => void, keep = false
    s.deps.settle = () => new Promise<void>(resolve => { release = resolve })
    const pending = s.remove(() => keep)
    expect(existsSync(join(s.dir, 'me.m4a'))).toBe(true)
    keep = true; release(); expect(await pending).toBe('kept')
    const manual = s.remove()
    s.store.updateMeeting(s.m.id, { state: 'recording' }); release()
    expect(await manual).toBe('recording')
    expect(existsSync(join(s.dir, 'me.m4a'))).toBe(true)
  })
  it('refuses live recordings, pending saves, invalid IDs and failed joins', async () => {
    const s = setup()
    expect(await deleteRecording('../outside', s.deps)).toBe('missing')
    s.deps.busy = () => true; expect(await s.remove()).toBe('recording')
    s.deps.busy = () => false
    writeFileSync(join(s.dir, 'part.1.json'), '{}')
    expect(await s.remove()).toBe('failed')
    expect(existsSync(join(s.dir, 'me.m4a'))).toBe(true)
  })
  it('a stuck recorder times out safely without deleting audio', async () => {
    vi.useFakeTimers()
    const s = setup(); s.deps.settle = () => new Promise(() => {})
    const pending = s.remove()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await pending).toBe('failed')
    expect(existsSync(join(s.dir, 'me.m4a'))).toBe(true)
  })
  it('automatic deletion runs only after the actual transcript and summary save', async () => {
    const s = setup({ transcript: false, summary: false })
    let stopped!: () => void, transcribed!: () => void, generated!: () => void
    const transcript = new Promise<void>(r => { transcribed = r }), generation = new Promise<void>(r => { generated = r })
    const removed: Promise<unknown>[] = []
    const queue = createQueue({ recording: () => false, smallMac: false })
    const notes = hookNotes({ store: s.store, queue, model: { llm: async () => ({ contextSize: 32_000, count: async xs => xs.map(x => x.length),
      chat: async (_prompt, token) => { await generation; token('## Summary\n- Launch Tuesday'); return '## Summary\n- Launch Tuesday' } }) },
      language: () => null, transcribed: () => transcript, onStop: fn => { stopped = () => fn(s.m) }, send: () => {}, changed: () => {}, summarized: () => { removed.push(s.remove(() => false)) } })
    stopped()
    expect(existsSync(join(s.dir, 'me.m4a'))).toBe(true)
    s.store.addSegments([{ meetingId: s.m.id, track: 'me', startMs: 0, endMs: 1000, text: 'Launch Tuesday', speaker: null }])
    transcribed(); await Promise.resolve()
    expect(s.store.notes(s.m.id).enhanced).toBeNull()
    expect(existsSync(join(s.dir, 'me.m4a'))).toBe(true)
    generated(); await notes.written(s.m.id); await Promise.all(removed)
    expect(removed).toHaveLength(1)
    expect(s.store.notes(s.m.id).enhanced).toContain('Launch Tuesday')
    expect(existsSync(join(s.dir, 'me.m4a'))).toBe(false)
  })
})
