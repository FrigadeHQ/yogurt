import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => any>())
vi.mock('electron', () => ({ app: { getPreferredSystemLanguages: () => ['en-US'] }, ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn) }, BrowserWindow: {}, nativeTheme: {} }))
import { hookPreferences } from '../src/main/preferences'
import { loadSettings, updateSettings, visibilityOf } from '../src/main/settings'

const dirs: string[] = []
afterEach(() => { dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })); handlers.clear(); vi.restoreAllMocks() })

const hook = (file: string, setDockVisible: (...args: any[]) => any, setTrayVisible: (...args: any[]) => any, os = 'darwin') => {
  const deps = { setShowNextMeeting: vi.fn(), file, os, permissions: {} as Parameters<typeof hookPreferences>[0]['permissions'], ask: false, setLogin: vi.fn(), loginOn: () => false, macName: () => '', relaunch: () => false, setTrayVisible, setDockVisible }
  hookPreferences(deps)
  return deps
}

it('defaults to both and persists each choice as the existing two booleans', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-dock-pref-')); dirs.push(dir)
  const file = join(dir, 'settings.json')
  hook(file, vi.fn(), vi.fn())
  const get = () => handlers.get('settings:get')!()
  const set = (value: unknown) => handlers.get('settings:visibility')!(null, value)
  expect(get().appVisibility).toBe('both')
  updateSettings(file, { openAtLogin: true })
  set('menu-bar')
  expect(loadSettings(file)).toEqual({ showInDock: false, openAtLogin: true })
  hook(file, vi.fn(), vi.fn())
  expect(get().appVisibility).toBe('menu-bar')
  set('dock')
  expect(loadSettings(file)).toEqual({ showInMenuBar: false, openAtLogin: true })
  expect(get().appVisibility).toBe('dock')
  set('both')
  expect(loadSettings(file)).toEqual({ openAtLogin: true })
  expect(get().appVisibility).toBe('both')
})

it('rejects invalid choices without persisting or touching either icon', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-dock-invalid-')); dirs.push(dir)
  const file = join(dir, 'settings.json')
  updateSettings(file, { showInDock: false })
  const dock = vi.fn(), tray = vi.fn()
  hook(file, dock, tray)
  for (const value of [null, undefined, true, false, 1, '', 'neither', 'BOTH', [], {}]) handlers.get('settings:visibility')!(null, value)
  expect(loadSettings(file)).toEqual({ showInDock: false })
  expect(dock).not.toHaveBeenCalled()
  expect(tray).not.toHaveBeenCalled()
})

it('shows the kept icon before hiding the other in all nine choice transitions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-dock-transitions-')); dirs.push(dir)
  const file = join(dir, 'settings.json')
  for (const initial of [[true, true], [true, false], [false, true]]) {
    for (const [choice, expected, calls] of [
      ['both', [true, true], ['tray:true', 'dock:true']],
      ['menu-bar', [true, false], ['tray:true', 'dock:false']],
      ['dock', [false, true], ['dock:true', 'tray:false']],
    ] as const) {
      let [menuBar, dock] = initial
      const order: string[] = []
      updateSettings(file, { showInMenuBar: menuBar, showInDock: dock, openAtLogin: true })
      const changed = (kind: string, on: boolean) => {
        order.push(`${kind}:${on}`)
        expect(menuBar || dock).toBe(true)
        if (!on) expect(handlers.get('settings:get')!().appVisibility).toBe(choice)
      }
      hook(file, (on) => { dock = on; changed('dock', on) }, (on) => { menuBar = on; changed('tray', on) })
      handlers.get('settings:visibility')!(null, choice)
      expect(order).toEqual(calls)
      expect([menuBar, dock]).toEqual(expected)
      expect(handlers.get('settings:get')!().appVisibility).toBe(choice)
      expect(visibilityOf(loadSettings(file))).toEqual({ showInMenuBar: expected[0], showInDock: expected[1], showRecordingPill: true })
      expect(loadSettings(file).openAtLogin).toBe(true)
    }
  }
})

it('keeps the existing entry point and saved choice if showing its replacement fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-dock-failure-')); dirs.push(dir)
  const file = join(dir, 'settings.json')
  updateSettings(file, { showInMenuBar: false })
  const dock = vi.fn()
  hook(file, dock, () => { throw new Error('unavailable') })
  expect(() => handlers.get('settings:visibility')!(null, 'menu-bar')).toThrow('unavailable')
  expect(dock).not.toHaveBeenCalled()
  expect(loadSettings(file)).toEqual({ showInMenuBar: false })
})

it('keeps platform-specific IPCs separate, so the tray setter cannot bypass the Mac choice', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-dock-platform-')); dirs.push(dir)
  const file = join(dir, 'settings.json')
  updateSettings(file, { showInDock: false })
  const dock = vi.fn(), tray = vi.fn()
  hook(file, dock, tray)
  handlers.get('settings:menu-bar')!(null, false)
  for (const os of ['win32', 'linux']) {
    hook(file, dock, tray, os)
    handlers.get('settings:visibility')!(null, 'dock')
  }
  expect(loadSettings(file)).toEqual({ showInDock: false })
  expect(dock).not.toHaveBeenCalled()
  expect(tray).not.toHaveBeenCalled()
})

it('reads legacy booleans without a migration and retains the both-off startup heal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-dock-legacy-')); dirs.push(dir)
  const file = join(dir, 'settings.json')
  hook(file, vi.fn(), vi.fn())
  for (const [menuBar, dock, choice] of [
    [undefined, undefined, 'both'], [true, true, 'both'],
    [undefined, false, 'menu-bar'], [false, undefined, 'dock'], [false, false, 'dock'],
  ] as const) {
    updateSettings(file, { showInMenuBar: menuBar, showInDock: dock })
    expect(handlers.get('settings:get')!().appVisibility).toBe(choice)
    expect(loadSettings(file).showInMenuBar).toBe(menuBar)
    expect(loadSettings(file).showInDock).toBe(dock)
  }
  expect(visibilityOf({ showInMenuBar: false, showInDock: false })).toEqual({ showInMenuBar: false, showInDock: true, showRecordingPill: true })
})

it('restores the pill before removing the recording indicator, and guards Dock only at the IPC', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recording-indicators-')); dirs.push(dir)
  const file = join(dir, 'settings.json')
  const changes: string[] = []
  const dock = vi.fn()
  const deps = hook(file, dock, on => changes.push(`tray:${on}`))
  const prefs = hookPreferences({ ...deps, recordingPillChanged: on => changes.push(`pill:${on}`) })
  const get = () => handlers.get('settings:get')!().showRecordingPill
  const pill = (on: unknown) => handlers.get('settings:recording-pill')!(null, on)
  expect(get()).toBe(true)
  pill(false)
  expect(loadSettings(file)).toEqual({ showRecordingPill: false })
  expect(get()).toBe(false)
  handlers.get('settings:next-meeting')!(null, false)
  expect(get()).toBe(false)
  for (const bad of [null, 0, 'false']) pill(bad)
  expect(changes).toEqual(['pill:false'])
  handlers.get('settings:visibility')!(null, 'dock')
  expect(changes.slice(-2)).toEqual(['pill:true', 'tray:false'])
  expect(loadSettings(file)).toEqual({ showInMenuBar: false, showNextMeeting: false })
  pill(false)
  prefs.setRecordingPill(false) // an imported preference also respects Dock only
  expect(get()).toBe(true)
  handlers.get('settings:visibility')!(null, 'both')
  expect(get()).toBe(true)
  prefs.setRecordingPill(false)
  expect(loadSettings(file)).toEqual({ showRecordingPill: false, showNextMeeting: false })
  handlers.get('settings:next-meeting')!(null, true)
  expect(get()).toBe(false)
  pill(true)
  expect(get()).toBe(true)
})

it.each(['win32', 'linux'])('keeps the pill on for imported and hand-edited settings on %s', os => {
  const dir = mkdtempSync(join(tmpdir(), 'recording-pill-platform-')); dirs.push(dir)
  const file = join(dir, 'settings.json')
  updateSettings(file, { showRecordingPill: false })
  const deps = hook(file, vi.fn(), vi.fn(), os)
  const prefs = hookPreferences(deps)
  handlers.get('settings:recording-pill')!(null, false)
  expect(handlers.get('settings:get')!().showRecordingPill).toBe(true)
  prefs.setRecordingPill(false)
  expect(loadSettings(file).showRecordingPill).toBeUndefined()
  expect(visibilityOf({ showInMenuBar: false, showRecordingPill: false }, 'darwin').showRecordingPill).toBe(true)
})
