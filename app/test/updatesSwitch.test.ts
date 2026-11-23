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

it('a running copy fetches the feed once per UTC day; Check for updates still checks right away', async () => {
  vi.useFakeTimers()
  try {
    updater.removeAllListeners()
    updater.checkForUpdates.mockClear()
    const { hookUpdates } = await import('../src/main/updates')
    const { loadSettings, saveSettings } = await import('../src/main/settings')
    const file = join(mkdtempSync(join(tmpdir(), 'yogurt-updates-')), 'settings.json')
    let clock = Date.parse('2026-11-23T22:00:00Z')
    const now = () => clock
    // checked earlier today: nothing at start
    saveSettings(file, { lastUpdateCheck: Date.parse('2026-11-23T08:00:00Z') })
    await hookUpdates({ file, available: true, recording: () => false, now, jitterMs: 20 * 60 * 1000 })
    const tick = async (ms: number) => { clock += ms; await vi.advanceTimersByTimeAsync(ms) }
    await tick(60 * 60 * 1000)
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    // the day rolls over at 00:00 UTC, but this copy waits for its jitter
    await tick(75 * 60 * 1000)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(0)
    await tick(15 * 60 * 1000)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    updater.emit('update-not-available')
    expect(loadSettings(file).lastUpdateCheck).toBe(clock)
    await tick(6 * 60 * 60 * 1000)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    handlers.get('updates:check')!()
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
  } finally { vi.clearAllTimers(); vi.useRealTimers() }
})

it('a feed that fails to arrive is tried again, and turning updates off stops the daily check', async () => {
  vi.useFakeTimers()
  try {
    updater.removeAllListeners()
    updater.checkForUpdates.mockClear()
    const { hookUpdates } = await import('../src/main/updates')
    const file = join(mkdtempSync(join(tmpdir(), 'yogurt-updates-')), 'settings.json')
    await hookUpdates({ file, available: true, recording: () => false, now: () => Date.parse('2026-11-23T12:00:00Z'), jitterMs: 0 })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    updater.emit('error', new Error('offline'))
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
    handlers.get('updates:set')!({}, false)
    updater.emit('error', new Error('offline'))
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
  } finally { vi.clearAllTimers(); vi.useRealTimers() }
})
