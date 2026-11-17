import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { UpdateStatus } from '../src/shared/types'
const handlers = new Map<string, (...args: unknown[]) => any>()
const send = vi.fn()
vi.mock('electron', () => ({
  app: { getVersion: () => '0.3.1', quit: vi.fn() },
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send } }] },
  ipcMain: { handle: (name: string, fn: (...args: unknown[]) => any) => handlers.set(name, fn) },
  Notification: { isSupported: () => false },
}))
it('publishes ready immediately, protects recordings, and restarts only on request', async () => {
  const { hookUpdates } = await import('../src/main/updates')
  let recording = true
  const restarted = vi.fn()
  await hookUpdates({ file: join(mkdtempSync(join(tmpdir(), 'yogurt-update-')), 'settings.json'), available: false,
    recording: () => recording, fake: { version: '0.3.2', restarted } })
  const status = () => handlers.get('updates:status')!() as UpdateStatus
  expect(status()).toMatchObject({ state: 'ready', next: '0.3.2' })
  expect(send).toHaveBeenCalledWith('updates:status', expect.objectContaining({ state: 'ready' }))
  expect(handlers.get('updates:restart')!()).toBe(false)
  expect(status().state).toBe('ready'); expect(restarted).not.toHaveBeenCalled()
  recording = false
  expect(restarted).not.toHaveBeenCalled()
  handlers.get('updates:set')!({}, false)
  expect(status()).toMatchObject({ state: 'ready', on: false })
  handlers.get('updates:set')!({}, true)
  expect(handlers.get('updates:restart')!()).toBe(true)
  expect(restarted).toHaveBeenCalledOnce(); expect(status().state).toBe('latest')
  expect(handlers.get('updates:restart')!()).toBe(false)
  expect(handlers.has('updates:later')).toBe(true)
})
