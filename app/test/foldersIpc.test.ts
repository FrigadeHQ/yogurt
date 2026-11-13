import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type Store } from '../src/main/store'
import { hookFolders } from '../src/main/foldersIpc'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) } }))
const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args)

let dir: string, store: Store
const changed = vi.fn()
beforeEach(() => {
  handlers.clear(); changed.mockReset()
  dir = mkdtempSync(join(tmpdir(), 'yogurt-folders-ipc-'))
  store = openStore(join(dir, 'yogurt.db'))
  hookFolders({ store, changed })
})
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })

describe('folders IPC', () => {
  it('never returns a pending suggestion for a meeting in any folder', async () => {
    const suggested = store.createFolder('Customers'), other = store.createFolder('Planning')
    const m = store.createMeeting({ title: 'Kickoff', startedAt: 1, endedAt: 2, eventId: null, app: null, attendees: [], state: 'done' })
    store.saveFolderSuggestion(m.id, { folderId: suggested.id, confidence: 0.9 }, 'folders-v1')
    // A legacy or imported pending record must still respect existing membership.
    store.db.prepare('INSERT INTO folder_meetings (folder_id, meeting_id, added_at) VALUES (?, ?, ?)').run(other.id, m.id, 1)
    expect(store.folderSuggestion(m.id).state).toBe('pending')
    expect(await call('folders:suggestion', m.id)).toBeNull()
  })
  it('exposes pending suggestions without filing, and accepts or dismisses them permanently', async () => {
    const f = store.createFolder('Customers')
    for (const action of ['accept', 'dismiss']) {
      const m = store.createMeeting({ title: 'Kickoff', startedAt: 1, endedAt: 2, eventId: null, app: null, attendees: [], state: 'done' })
      store.saveFolderSuggestion(m.id, { folderId: f.id, confidence: 0.9 }, 'folders-v1')
      expect(await call('folders:suggestion', m.id)).toMatchObject({ id: f.id })
      expect(await call('folders:of', m.id)).toEqual([])
      if (action === 'accept') {
        await call('folders:add', f.id, m.id)
        expect(store.folderSuggestion(m.id).state).toBe('accepted')
        await call('folders:remove', f.id, m.id)
      } else {
        await call('folders:dismiss-suggestion', m.id)
        expect(store.folderSuggestion(m.id).state).toBe('dismissed')
      }
      store.saveFolderSuggestion(m.id, { folderId: f.id, confidence: 1 }, 'folders-v2')
      expect(await call('folders:suggestion', m.id)).toBeNull()
      expect(await call('folders:of', m.id)).toEqual([])
    }
  })
  it('accepts only a complete valid reorder and broadcasts it once', async () => {
    const a = store.createFolder('Alpha'), b = store.createFolder('Beta')
    for (const value of [null, 'bad', [a.id], [a.id, a.id], [b.id, 123], [b.id, 'missing']]) {
      expect(await call('folders:reorder', value)).toBe(false)
    }
    expect(changed).not.toHaveBeenCalled()
    expect(await call('folders:reorder', [b.id, a.id])).toBe(true)
    expect(store.folders().map(f => f.id)).toEqual([b.id, a.id])
    expect(changed).toHaveBeenCalledTimes(1)
  })
  it('creates, files, renames and deletes, telling the windows each time', async () => {
    const m = store.createMeeting({ title: 'Kickoff', startedAt: 1, endedAt: 2, eventId: null, app: null, attendees: [], state: 'done' })
    const s = await call('folders:create', 'Acme') as { id: string }
    await call('folders:add', s.id, m.id)
    expect(await call('folders:of', m.id)).toMatchObject([{ name: 'Acme', count: 1 }])
    await call('folders:rename', s.id, 'Acme Inc')
    expect(await call('folders:list')).toMatchObject([{ name: 'Acme Inc' }])
    await call('folders:remove', s.id, m.id)
    await call('folders:delete', s.id)
    expect(await call('folders:list')).toEqual([])
    expect(changed).toHaveBeenCalledTimes(5)
  })
  it('accepts only curated appearance choices, including on creation', async () => {
    const a = await call('folders:create', 'Design', { icon: 'palette', color: 'violet', id: '../override', name: 'Wrong', count: 999 }) as { id: string }
    expect(a.id).not.toBe('../override')
    expect(store.folder(a.id)).toMatchObject({ name: 'Design', count: 0, icon: 'palette', color: 'violet' })
    expect(await call('folders:appearance', a.id, { icon: 'rocket', color: 'blue' })).toBe(true)
    for (const invalid of [null, {}, { icon: '<svg>', color: 'blue' }, { icon: 'star', color: 'url(evil)' }, { icon: 2, color: 'blue' }]) {
      expect(await call('folders:appearance', a.id, invalid)).toBe(false)
      expect(await call('folders:create', 'Bad', invalid)).toBeUndefined()
    }
    expect(await call('folders:appearance', 'missing', { icon: 'star', color: 'blue' })).toBe(false)
    expect(store.folders()).toHaveLength(1)
    expect(store.folder(a.id)).toMatchObject({ icon: 'rocket', color: 'blue' })
    expect(changed).toHaveBeenCalledTimes(2)
  })
  it('ignores what a page should never send: odd ids, blank names, meetings or folders that are not here', async () => {
    expect(await call('folders:create', '   ')).toBeUndefined()
    expect(await call('folders:create', 42)).toBeUndefined()
    const s = await call('folders:create', 'Acme') as { id: string }
    await call('folders:add', s.id, 'no-such-meeting')
    await call('folders:add', '../x', 'y')
    await call('folders:rename', s.id, { name: 'x' })
    expect(await call('folders:list')).toMatchObject([{ name: 'Acme', count: 0 }])
    expect(await call('folders:of', null)).toEqual([])
    expect(changed).toHaveBeenCalledTimes(1)
  })
})
