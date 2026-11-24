import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type Store } from '../src/main/store'
import { initMeetings } from '../src/main/meeting'
import { AUDIO_SPEAKER } from '../src/shared/audioUpload'
import { applyOp, changesSince, FROM_IPHONE, notesHash, type Change } from '../src/main/companion/records'

let store: Store
beforeEach(() => { store = openStore(':memory:'); initMeetings(store) })
const base = { endedAt: 2000, eventId: null, app: 'Zoom', attendees: [], state: 'done' as const }
const deps = () => ({ notesRewrite: (id: string, mine: string) => store.setNotes(id, { mine }), nowMs: () => 5000 })
const head = () => changesSince(store, 0, 10_000).cursor
const keys = (changes: Change[]) => changes.map((c) => `${c.entity}:${c.id}${c.deleted ? ':deleted' : ''}`)

describe('companion change log', () => {
  it('a new meeting, a notes edit, transcript lines and a folder change each appear once after the cursor', () => {
    const since = head()
    const m = store.createMeeting({ ...base, title: 'Banana sync', startedAt: 1000, attendees: [{ name: 'Ada Example', email: 'ada@example.com' }] })
    store.setNotes(m.id, { mine: 'first' })
    store.setNotes(m.id, { mine: 'second', enhanced: '## Summary' })
    store.addSegments([
      { meetingId: m.id, track: 'me', startMs: 0, endMs: 900, text: 'hello there', speaker: 'me' },
      { meetingId: m.id, track: 'them', startMs: 1000, endMs: 1900, text: 'hi back', speaker: null },
      { meetingId: m.id, track: 'me', startMs: 2000, endMs: 2500, text: 'an echo', speaker: 'me', hidden: true },
    ])
    const f = store.createFolder('Fruit')
    store.addToFolder(f.id, m.id)
    const { changes, cursor, more } = changesSince(store, since, 100)
    expect(more).toBe(false)
    expect(cursor).toBeGreaterThan(since)
    expect(keys(changes).sort()).toEqual([`folder:${f.id}`, `folderMembers:${f.id}`, `meeting:${m.id}`, `notes:${m.id}`, 'people:ada@example.com', `segments:${m.id}`].sort())
    const rec = (e: string) => changes.find((c) => c.entity === e)!.record
    expect(rec('meeting')).toEqual({ id: m.id, title: 'Banana sync', startedAt: 1000, endedAt: 2000, attendees: [{ name: 'Ada Example', email: 'ada@example.com' }], app: 'Zoom', trashedAt: null, language: null })
    expect(rec('notes')).toEqual({ meetingId: m.id, mine: 'second', summary: '## Summary', mineHash: notesHash('second') })
    expect(rec('segments')).toEqual({ meetingId: m.id, oneMic: false, segments: [{ startMs: 0, endMs: 900, speaker: 'me', text: 'hello there' }, { startMs: 1000, endMs: 1900, speaker: null, text: 'hi back' }] })
    expect(rec('folder')).toEqual({ id: f.id, name: 'Fruit', createdAt: f.createdAt })
    expect(rec('folderMembers')).toEqual({ folderId: f.id, meetingIds: [m.id] })
    expect(rec('people')).toEqual({ email: 'ada@example.com', displayName: null })
    // nothing new: nothing after the cursor
    expect(changesSince(store, cursor, 100)).toMatchObject({ changes: [], cursor, more: false })
    store.removeFromFolder(f.id, m.id)
    const after = changesSince(store, cursor, 100)
    expect(keys(after.changes)).toEqual([`folderMembers:${f.id}`])
    expect(after.changes[0].record).toEqual({ folderId: f.id, meetingIds: [] })
    expect(after.cursor).toBeGreaterThan(cursor)
  })

  it('pages with limit and more', () => {
    const since = head()
    for (const t of ['Apple', 'Pear', 'Plum']) store.createMeeting({ ...base, title: t, startedAt: 1000 })
    const one = changesSince(store, since, 2)
    expect(one.changes).toHaveLength(2)
    expect(one.more).toBe(true)
    const two = changesSince(store, one.cursor, 2)
    expect(two.changes).toHaveLength(1)
    expect(two.more).toBe(false)
    expect(two.changes.map((c) => (c.record as { title: string }).title)).toEqual(['Plum'])
  })

  it('clamps limit to 1..500 and stops a page early past about 1 MB, always with at least one change', () => {
    const since = head()
    const long = 'word '.repeat(60_000) // ~300 KB per transcript
    for (let i = 0; i < 5; i++) {
      const m = store.createMeeting({ ...base, title: `Long ${i}`, startedAt: 1000 + i })
      store.addSegments([{ meetingId: m.id, track: 'them', startMs: 0, endMs: 1, text: long, speaker: null }])
    }
    const all: Change[] = []
    let cursor = since, more = true, pages = 0
    while (more) {
      const page = changesSince(store, cursor, 500)
      expect(page.changes.length).toBeGreaterThan(0)
      expect(JSON.stringify(page.changes).length < 1_100_000 || page.changes.length === 1).toBe(true)
      all.push(...page.changes); cursor = page.cursor; more = page.more; pages++
    }
    expect(pages).toBeGreaterThan(1)
    expect(all.filter((c) => c.entity === 'segments')).toHaveLength(5)
    expect(changesSince(store, since, 0).changes).toHaveLength(1)
    expect(changesSince(store, since, Number.NaN).changes).toHaveLength(1)
    expect(changesSince(store, since, 10_000).changes.length).toBeLessThanOrEqual(500)
  })

  it('gives the log an epoch that stays the same across opens', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yogurt-companion-'))
    try {
      const a = openStore(join(dir, 'yogurt.db'))
      const epoch = changesSince(a, 0, 10).epoch
      expect(epoch).toMatch(/^[0-9a-f-]{36}$/)
      a.close()
      const b = openStore(join(dir, 'yogurt.db'))
      expect(changesSince(b, 0, 10).epoch).toBe(epoch)
      b.close()
      expect(changesSince(store, 0, 10).epoch).not.toBe(epoch)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('triggers are made again under a new version, so their columns can change', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yogurt-companion-'))
    try {
      const a = openStore(join(dir, 'yogurt.db'))
      a.db.exec('DROP TRIGGER companion_meetings_au')
      a.db.prepare("UPDATE companion_meta SET value = '0' WHERE key = 'triggers'").run()
      a.close()
      const b = openStore(join(dir, 'yogurt.db'))
      const m = b.createMeeting({ ...base, title: 'Kiwi', startedAt: 1000 })
      const since = changesSince(b, 0, 500).cursor
      b.updateMeeting(m.id, { title: 'Kiwi two' })
      expect(keys(changesSince(b, since, 10).changes)).toEqual([`meeting:${m.id}`])
      b.close()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('what was there before the log existed is sent from the start', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yogurt-companion-'))
    try {
      const old = openStore(join(dir, 'yogurt.db'))
      const m = old.createMeeting({ ...base, title: 'Old one', startedAt: 1000 })
      // a database from before the companion: no log, no triggers
      for (const r of old.db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'companion_%'").all()) old.db.exec(`DROP TRIGGER ${String(r.name)}`)
      old.db.exec('DROP TABLE companion_changes')
      old.close()
      const reopened = openStore(join(dir, 'yogurt.db'))
      expect(keys(changesSince(reopened, 0, 100).changes)).toContain(`meeting:${m.id}`)
      reopened.close()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('deleting a folder, and a meeting deleted for good, become tombstones; a trashed meeting is a record with trashedAt', () => {
    const m = store.createMeeting({ ...base, title: 'Cherry', startedAt: 1000 })
    const gone = store.createMeeting({ ...base, title: 'Lime', startedAt: 1000 })
    const f = store.createFolder('Stone fruit')
    store.addToFolder(f.id, m.id)
    const since = head()
    store.deleteFolder(f.id)
    store.trashMeeting(m.id, 4000)
    store.deleteMeeting(gone.id)
    const { changes } = changesSince(store, since, 100)
    expect(changes).toContainEqual({ entity: 'folder', id: f.id, deleted: true })
    expect(changes).toContainEqual({ entity: 'folderMembers', id: f.id, deleted: true })
    expect(changes).toContainEqual({ entity: 'meeting', id: gone.id, deleted: true })
    expect(changes.find((c) => c.entity === 'meeting' && c.id === m.id)?.record).toMatchObject({ trashedAt: 4000 })
    expect(new Set(keys(changes)).size).toBe(changes.length)
  })
})

describe('companion one-mic meetings', () => {
  it('an uploaded or phone recording says oneMic and names nobody, never the reserved audio speaker', () => {
    const m = store.createMeeting({ ...base, title: 'Room chat', startedAt: 1000, source: 'audio-file' })
    store.addSegments([{ meetingId: m.id, track: 'them', startMs: 0, endMs: 900, text: 'made-up line', speaker: AUDIO_SPEAKER }])
    const seg = changesSince(store, 0, 100).changes.find((c) => c.entity === 'segments' && c.id === m.id)!.record
    expect(seg).toEqual({ meetingId: m.id, oneMic: true, segments: [{ startMs: 0, endMs: 900, speaker: null, text: 'made-up line' }] })
  })
})

describe('companion ops', () => {
  it('setMine with the matching base replaces My notes', () => {
    const m = store.createMeeting({ ...base, title: 'Grape', startedAt: 1000 })
    store.setNotes(m.id, { mine: 'desk' })
    expect(applyOp(store, { kind: 'setMine', meetingId: m.id, text: 'phone', baseHash: notesHash('desk') }, deps())).toEqual({ applied: true })
    expect(store.notes(m.id).mine).toBe('phone')
  })

  it('setMine with a stale base keeps the desktop text and adds the phone text under a heading', () => {
    const m = store.createMeeting({ ...base, title: 'Grape', startedAt: 1000 })
    store.setNotes(m.id, { mine: 'desk edit' })
    const op = { kind: 'setMine' as const, meetingId: m.id, text: 'phone edit', baseHash: notesHash('older') }
    expect(applyOp(store, op, deps())).toEqual({ applied: true, merged: true })
    expect(FROM_IPHONE).toBe('\n\n## From your iPhone\n\n')
    expect(store.notes(m.id).mine).toBe('desk edit\n\n## From your iPhone\n\nphone edit')
    // sent again (a retry): not added twice
    expect(applyOp(store, op, deps())).toEqual({ applied: true, merged: true })
    expect(store.notes(m.id).mine).toBe('desk edit\n\n## From your iPhone\n\nphone edit')
  })

  it('a short phone text found inside the desktop notes is still added', () => {
    const m = store.createMeeting({ ...base, title: 'Grape', startedAt: 1000 })
    store.setNotes(m.id, { mine: 'book' })
    expect(applyOp(store, { kind: 'setMine', meetingId: m.id, text: 'ok', baseHash: notesHash('older') }, deps())).toEqual({ applied: true, merged: true })
    expect(store.notes(m.id).mine).toBe('book' + FROM_IPHONE + 'ok')
  })

  it('a phone text that only starts an earlier phone block is still added; a block in the middle counts as there', () => {
    const m = store.createMeeting({ ...base, title: 'Grape', startedAt: 1000 })
    store.setNotes(m.id, { mine: 'desk' + FROM_IPHONE + 'phone edit' })
    applyOp(store, { kind: 'setMine', meetingId: m.id, text: 'phone', baseHash: notesHash('older') }, deps())
    expect(store.notes(m.id).mine).toBe('desk' + FROM_IPHONE + 'phone edit' + FROM_IPHONE + 'phone')
    // 'phone edit' is a whole block followed by another one: a retry, not added again
    applyOp(store, { kind: 'setMine', meetingId: m.id, text: 'phone edit', baseHash: notesHash('older') }, deps())
    expect(store.notes(m.id).mine).toBe('desk' + FROM_IPHONE + 'phone edit' + FROM_IPHONE + 'phone')
  })

  it('setMine with the text the desktop already has writes nothing', () => {
    const m = store.createMeeting({ ...base, title: 'Grape', startedAt: 1000 })
    store.setNotes(m.id, { mine: 'same' })
    const since = head()
    let writes = 0
    expect(applyOp(store, { kind: 'setMine', meetingId: m.id, text: 'same', baseHash: notesHash('older') }, { ...deps(), notesRewrite: () => { writes++ } })).toEqual({ applied: true })
    expect(writes).toBe(0)
    expect(changesSince(store, since, 10).changes).toEqual([])
  })

  it('notesHash is sha256 of the NFC text', () => {
    expect(notesHash('café')).toBe(notesHash('café'))
    expect(notesHash('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  it('rename, folders, trash and restore go through the desktop rules', () => {
    const m = store.createMeeting({ ...base, title: 'Melon', startedAt: 1000 })
    const f = store.createFolder('Fruit')
    expect(applyOp(store, { kind: 'rename', meetingId: m.id, title: '  Melon   review ' }, deps())).toEqual({ applied: true })
    expect(store.meeting(m.id)).toMatchObject({ title: 'Melon review', titleSource: 'user' })
    applyOp(store, { kind: 'addToFolder', meetingId: m.id, folderId: f.id }, deps())
    expect(store.folderMeetingIds(f.id)).toEqual([m.id])
    applyOp(store, { kind: 'removeFromFolder', meetingId: m.id, folderId: f.id }, deps())
    expect(store.folderMeetingIds(f.id)).toEqual([])
    applyOp(store, { kind: 'trash', meetingId: m.id }, deps())
    expect(store.meeting(m.id)?.trashedAt).toBe(5000)
    expect(store.trashed().map((t) => t.id)).toEqual([m.id])
    applyOp(store, { kind: 'restore', meetingId: m.id }, deps())
    expect(store.meeting(m.id)?.trashedAt).toBeUndefined()
  })

  it('refuses an op for a meeting or folder that is not there, and never trashes a recording', () => {
    const rec = store.createMeeting({ ...base, title: 'Live', startedAt: 1000, state: 'recording' })
    expect(() => applyOp(store, { kind: 'rename', meetingId: 'nope', title: 'x' }, deps())).toThrow('gone')
    expect(() => applyOp(store, { kind: 'addToFolder', meetingId: rec.id, folderId: 'nope' }, deps())).toThrow('gone')
    expect(() => applyOp(store, { kind: 'trash', meetingId: rec.id }, deps())).toThrow('recording')
    expect(store.meeting(rec.id)?.trashedAt).toBeUndefined()
  })
})

it('replaces phone words, sends an empty transcript, and publishes review-only updates', () => {
  const { id } = store.createMeeting({ ...base, title: 'Sync', startedAt: 1000 })
  store.addSegments([{ meetingId: id, track: 'them', speaker: 'Jo', text: 'Kord', startMs: 20, endMs: 40 }])
  store.setNotes(id, { enhanced: 'Earlier summary' })
  const row = store.segments(id)[0], start = head()
  store.changeTranscript(id, 0, { kind: 'wording', id: row.id, expected: 'Kord', text: 'Cord' })
  const edited = changesSince(store, start, 100)
  expect(edited.changes.find(c => c.entity === 'segments')?.record).toMatchObject({ segments: [{ text: 'Cord', startMs: 20, endMs: 40 }] })
  expect(edited.changes.find(c => c.entity === 'notes')?.record).toMatchObject({ summary: null })
  store.changeTranscript(id, 1, { kind: 'remove', ids: [row.id] })
  const empty = changesSince(store, edited.cursor, 100)
  expect(empty.changes.find(c => c.entity === 'segments')?.record).toMatchObject({ segments: [] })
  store.reviewSummary(id, 2, 'Earlier summary')
  expect(changesSince(store, empty.cursor, 100).changes.find(c => c.entity === 'notes')?.record).toMatchObject({ summary: 'Earlier summary' })
})
