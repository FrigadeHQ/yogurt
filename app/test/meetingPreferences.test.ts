import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hookPreferences } from '../src/main/preferences'
import { loadSettings } from '../src/main/settings'

const handlers = vi.hoisted(() => new Map<string, Function>())
vi.mock('electron', () => ({ app: { getPreferredSystemLanguages: () => ['en-US'] },
  ipcMain: { handle: (channel: string, fn: Function) => handlers.set(channel, fn) }, BrowserWindow: {}, nativeTheme: {} }))
let dir: string
afterEach(() => { rmSync(dir, { recursive: true, force: true }); handlers.clear() })

it('defaults to detection on, persists off across launches and only signals successful changes', () => {
  dir = mkdtempSync(join(tmpdir(), 'yogurt-prefs-'))
  const file = join(dir, 'settings.json')
  const deps = { file, permissions: {} as Parameters<typeof hookPreferences>[0]['permissions'], ask: false,
    setLogin: vi.fn(), setTrayVisible: vi.fn(), setShowNextMeeting: vi.fn(), setDockVisible: vi.fn(),
    loginOn: () => false, macName: () => '', relaunch: () => false }
  const changed = vi.fn()
  const { read } = hookPreferences({ ...deps, detectionChanged: changed })
  const set = (on: unknown) => handlers.get('settings:detect-meetings')!({}, on)
  expect(read().detectMeetingsAutomatically).toBe(true)
  set('false')
  set(true)
  expect(changed).not.toHaveBeenCalled()
  set(false)
  expect(changed).toHaveBeenCalledWith(false)
  expect(loadSettings(file)).toEqual({ detectMeetingsAutomatically: false })
  const reopened = hookPreferences({ ...deps, detectionChanged: changed })
  expect(reopened.read().detectMeetingsAutomatically).toBe(false)
  set(true)
  expect(changed.mock.calls).toEqual([[false], [true]])
  expect(loadSettings(file)).toEqual({})
})
