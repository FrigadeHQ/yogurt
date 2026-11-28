import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
const picked: { path?: string } = {}
vi.mock('electron', () => ({
  ipcMain: { handle: (c: string, f: (...a: unknown[]) => unknown) => { handlers.set(c, f) } },
  dialog: { showOpenDialog: async () => (picked.path ? { canceled: false, filePaths: [picked.path] } : { canceled: true, filePaths: [] }) },
  shell: { openPath: async () => '' },
}))

import { hookAutoExport } from '../src/main/autoExportIpc'
import { openStore } from '../src/main/store'
import { loadSettings } from '../src/main/settings'

let root: string, hook: ReturnType<typeof hookAutoExport>
const call = <T>(c: string, ...a: unknown[]) => handlers.get(c)!({}, ...a) as Promise<T>
type State = { on: boolean; folder: string | null; failed: boolean; offerEarlier: boolean }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'yogurt-auto-export-ipc-'))
  handlers.clear(); delete picked.path
  const store = openStore(':memory:')
  store.createMeeting({ title: 'Earlier', startedAt: Date.now(), endedAt: Date.now(), eventId: null, app: null, attendees: [], state: 'done' })
  hook = hookAutoExport({ settingsFile: join(root, 'settings.json'), indexFile: join(root, 'auto-export.json'), store, window: () => undefined, credit: () => false, busy: () => false, everyMs: 60_000 })
})
afterEach(() => { hook.stop(); rmSync(root, { recursive: true, force: true }) })

it('starts off, and turning on without picking a folder leaves it off', async () => {
  expect(await call<State>('auto-export:get')).toEqual({ on: false, folder: null, failed: false, offerEarlier: false })
  expect((await call<State>('auto-export:set', true)).on).toBe(false)
  expect(loadSettings(join(root, 'settings.json')).autoExport).toBeUndefined()
})

it('turning on asks for a folder once, offers earlier meetings once, and keeps the folder when turned off', async () => {
  picked.path = join(root, 'Vault'); mkdirSync(picked.path)
  expect(await call<State>('auto-export:set', true)).toEqual({ on: true, folder: picked.path, failed: false, offerEarlier: true })
  expect(await call('auto-export:earlier', true)).toEqual({ saved: 1, failed: false })
  expect(readdirSync(picked.path)).toHaveLength(1)
  expect((await call<State>('auto-export:get')).offerEarlier).toBe(false)
  expect((await call<State>('auto-export:set', false)).on).toBe(false)
  delete picked.path
  const back = await call<State>('auto-export:set', true)
  expect(back.on).toBe(true)
  expect(back.folder).toBe(join(root, 'Vault'))
})

it('Change moves to the new folder; cancelling keeps the old one', async () => {
  picked.path = join(root, 'A'); mkdirSync(picked.path)
  await call('auto-export:set', true)
  delete picked.path
  expect((await call<State>('auto-export:choose')).folder).toBe(join(root, 'A'))
  picked.path = join(root, 'B'); mkdirSync(picked.path)
  expect(await call<State>('auto-export:choose')).toMatchObject({ on: true, folder: join(root, 'B'), offerEarlier: true })
})
