import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  app: { getVersion: () => '0.3.6', quit: () => {} },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: (name: string, fn: (...a: unknown[]) => unknown) => handlers.set(name, fn) },
  Notification: { isSupported: () => false },
}))
const updater = Object.assign(new EventEmitter(), { autoDownload: false, autoInstallOnAppQuit: false, logger: undefined, checkForUpdates: vi.fn(async () => {}) })
vi.mock('electron-updater', () => ({ default: { autoUpdater: updater } }))

it('updates are on by default, and turning them off also keeps a downloaded version from installing on quit', async () => {
  vi.useFakeTimers()
  const { hookUpdates } = await import('../src/main/updates')
  const file = join(mkdtempSync(join(tmpdir(), 'yogurt-updates-')), 'settings.json')
  await hookUpdates({ file, available: true, recording: () => false })
  expect((handlers.get('updates:status')!() as { on: boolean }).on).toBe(true)
  expect(updater.autoInstallOnAppQuit).toBe(true)
  handlers.get('updates:set')!({}, false)
  expect(updater.autoInstallOnAppQuit).toBe(false)
  handlers.get('updates:set')!({}, true)
  expect(updater.autoInstallOnAppQuit).toBe(true)
  vi.useRealTimers()
})

it('Later hides only this version for this app session without changing installation or Settings restart', async () => {
  vi.useFakeTimers()
  try {
    updater.removeAllListeners()
    const { hookUpdates } = await import('../src/main/updates')
    const file = join(mkdtempSync(join(tmpdir(), 'yogurt-updates-')), 'settings.json')
    await hookUpdates({ file, available: true, recording: () => false })
    const status = () => handlers.get('updates:status')!() as import('../src/shared/types').UpdateStatus
    handlers.get('updates:later')!()
    updater.emit('update-downloaded', { version: '0.3.7' })
    expect(status()).toMatchObject({ state: 'ready', next: '0.3.7', dismissed: false })
    handlers.get('updates:later')!()
    expect(status()).toMatchObject({ state: 'ready', next: '0.3.7', dismissed: true, on: true })
    expect(updater.autoInstallOnAppQuit).toBe(true)
    expect(handlers.get('updates:restart')!()).toBe(true)
    updater.emit('update-downloaded', { version: '0.3.7' })
    expect(status().dismissed).toBe(true)
    updater.emit('update-downloaded', { version: '0.3.8' })
    expect(status()).toMatchObject({ state: 'ready', next: '0.3.8', dismissed: false })
    handlers.get('updates:later')!()
    expect(status().dismissed).toBe(true)
    updater.removeAllListeners()
    await hookUpdates({ file, available: true, recording: () => false })
    updater.emit('update-downloaded', { version: '0.3.8' })
    expect(status().dismissed).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(true)
  } finally { vi.clearAllTimers(); vi.useRealTimers() }
})
