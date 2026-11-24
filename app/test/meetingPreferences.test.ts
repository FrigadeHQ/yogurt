import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hookPreferences } from '../src/main/preferences'
import { loadSettings } from '../src/main/settings'
import { deliveryFor } from '../src/shared/notificationDelivery'

const handlers = vi.hoisted(() => new Map<string, Function>())
vi.mock('electron', () => ({ app: { getPreferredSystemLanguages: () => ['en-US'] },
  ipcMain: { handle: (channel: string, fn: Function) => handlers.set(channel, fn) }, BrowserWindow: {}, nativeTheme: {} }))
let dir: string
afterEach(() => { rmSync(dir, { recursive: true, force: true }); handlers.clear() })
function harness() {
  dir = mkdtempSync(join(tmpdir(), 'yogurt-prefs-'))
  const file = join(dir, 'settings.json')
  const deps = { file, permissions: {} as Parameters<typeof hookPreferences>[0]['permissions'], ask: false,
    setLogin: vi.fn(), setTrayVisible: vi.fn(), setShowNextMeeting: vi.fn(), setDockVisible: vi.fn(),
    loginOn: () => false, macName: () => '', relaunch: () => false }
  hookPreferences(deps)
  return { file, deps }
}

it('stores each notification channel separately and retains the sound choice while a banner is off', () => {
  const { file } = harness()
  const read = () => loadSettings(file).notificationDelivery
  expect(deliveryFor(read(), 'updates')).toEqual({ system: true, sound: true })
  expect(deliveryFor(read(), 'notes-ready')).toEqual({ system: false, sound: false })
  handlers.get('settings:notification')!({}, 'meeting-detected', 'sound', true)
  handlers.get('settings:notification')!({}, 'meeting-detected', 'system', false)
  handlers.get('settings:notification')!({}, 'call-ended', 'system', false)
  handlers.get('settings:notification')!({}, '__proto__', 'sound', true)
  expect(read()).toEqual({ 'meeting-detected': { system: false, sound: true }, 'call-ended': { system: false } })
})
