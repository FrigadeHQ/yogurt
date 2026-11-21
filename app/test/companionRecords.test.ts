import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type Store } from '../src/main/store'
import { initMeetings } from '../src/main/meeting'
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
    expect(rec('segments')).toEqual({ meetingId: m.id, segments: [{ startMs: 0, endMs: 900, speaker: 'me', text: 'hello there' }, { startMs: 1000, endMs: 1900, speaker: null, text: 'hi back' }] })
    expect(rec('folder')).toEqual({ id: f.id, name: 'Fruit', createdAt: f.createdAt })
    expect(rec('folderMembers')).toEqual({ folderId: f.id, meetingIds: [m.id] })
    expect(rec('people')).toEqual({ email: 'ada@example.com', displayName: null })
    // nothing new: nothing after the cursor
    expect(changesSince(store, cursor, 100)).toEqual({ changes: [], cursor, more: false })
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
