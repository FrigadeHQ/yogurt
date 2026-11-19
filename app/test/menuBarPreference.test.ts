import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => any>())
vi.mock('electron', () => ({ app: { getPreferredSystemLanguages: () => ['en-US'] }, ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn) }, BrowserWindow: {}, nativeTheme: {} }))
import { hookPreferences } from '../src/main/preferences'
import { loadSettings, updateSettings } from '../src/main/settings'

const dirs: string[] = []
afterEach(() => { dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })); handlers.clear(); vi.restoreAllMocks() })
it.each(['win32', 'linux'])('%s tray defaults on, persists changes and rejects non-booleans without changing the Dock preference', (os) => {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-menu-pref-')); dirs.push(dir)
  const file = join(dir, 'settings.json')
  const setTrayVisible = vi.fn()
  const deps = { file, os, permissions: {} as Parameters<typeof hookPreferences>[0]['permissions'], ask: false, setLogin: vi.fn(), loginOn: () => false, macName: () => '', relaunch: () => false, setTrayVisible, setDockVisible: vi.fn() }
  hookPreferences(deps)
  const get = () => handlers.get('settings:get')!()
  const set = (value: unknown) => handlers.get('settings:menu-bar')!(null, value)
  expect(get().showInMenuBar).toBe(true)
  updateSettings(file, { openAtLogin: true, showInDock: false })
  set(false)
  expect(loadSettings(file)).toMatchObject({ showInMenuBar: false, openAtLogin: true })
  expect(setTrayVisible).toHaveBeenLastCalledWith(false)
  hookPreferences(deps)
  expect(get().showInMenuBar).toBe(false)
  for (const value of [null, 'true', 1, undefined]) set(value)
  expect(setTrayVisible).toHaveBeenCalledTimes(1)
  set(true)
  expect(get().showInMenuBar).toBe(true)
  expect(loadSettings(file).showInMenuBar).toBeUndefined()
  expect(setTrayVisible).toHaveBeenLastCalledWith(true)
  expect(loadSettings(file).showInDock).toBe(false)
  expect(deps.setDockVisible).not.toHaveBeenCalled()
})


it('reads What Yogurt keeps from settings, the audio switch from before rules included', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-audio-pref-')); dirs.push(dir)
  const file = join(dir, 'settings.json')
  hookPreferences({ file, permissions: {} as Parameters<typeof hookPreferences>[0]['permissions'], ask: false, setLogin: vi.fn(), loginOn: () => false, macName: () => 'Dana', relaunch: () => false, setTrayVisible: vi.fn(), setDockVisible: vi.fn() })
  const get = () => handlers.get('settings:get')!().retention
  expect(get()).toEqual({ audio: null, video: null, transcript: null, meeting: null })
  updateSettings(file, { keepRecordings: false, recordingsOffAt: 2000 })
  expect(get()).toEqual({ audio: 0, video: null, transcript: null, meeting: null })
  updateSettings(file, { keepRecordings: undefined, recordingsOffAt: undefined, audioDays: 30, transcriptDays: 45, meetingDays: 365 })
  expect(get()).toEqual({ audio: 30, video: null, transcript: 45, meeting: 365 })
  // hand-edited nonsense is no rule
  updateSettings(file, { audioDays: -1, transcriptDays: 0, meetingDays: 1.5 })
  expect(get()).toEqual({ audio: null, video: null, transcript: null, meeting: null })
})
