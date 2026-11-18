import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => any>())
vi.mock('electron', () => ({ app: { getPreferredSystemLanguages: () => ['en-US'] }, ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn) }, BrowserWindow: {}, nativeTheme: {} }))
import { hookPreferences } from '../src/main/preferences'
import { loadSettings } from '../src/main/settings'

const dirs: string[] = []
afterEach(() => { dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })); handlers.clear(); vi.restoreAllMocks() })

it('transcription only defaults off, persists on across reloads, rejects non-booleans and notifies the lifecycle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-transcription-pref-')); dirs.push(dir)
  const file = join(dir, 'settings.json')
  const onTranscriptionOnly = vi.fn()
  const deps = { file, permissions: {} as Parameters<typeof hookPreferences>[0]['permissions'], ask: false, setLogin: vi.fn(), loginOn: () => false, macName: () => 'Dana', relaunch: () => false, setTrayVisible: vi.fn(), setDockVisible: vi.fn(), onTranscriptionOnly }
  hookPreferences(deps)
  const get = () => handlers.get('settings:get')!()
  const set = (value: unknown) => handlers.get('settings:transcription-only')!(null, value)
  expect(get().transcriptionOnly).toBe(false)
  set(true)
  expect(loadSettings(file)).toMatchObject({ transcriptionOnly: true })
  expect(onTranscriptionOnly).toHaveBeenLastCalledWith(true)
  hookPreferences(deps)
  expect(get().transcriptionOnly).toBe(true)
  for (const value of [null, 'true', 1, undefined]) set(value)
  expect(onTranscriptionOnly).toHaveBeenCalledTimes(1)
  set(false)
  expect(get().transcriptionOnly).toBe(false)
  expect(loadSettings(file).transcriptionOnly).toBeUndefined()
  expect(onTranscriptionOnly).toHaveBeenLastCalledWith(false)
})

it('a corrupt transcription value falls back to normal mode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-transcription-pref-')); dirs.push(dir)
  const file = join(dir, 'settings.json')
  const deps = { file, permissions: {} as Parameters<typeof hookPreferences>[0]['permissions'], ask: false, setLogin: vi.fn(), loginOn: () => false, macName: () => 'Dana', relaunch: () => false, setTrayVisible: vi.fn(), setDockVisible: vi.fn() }
  hookPreferences(deps)
  const get = () => handlers.get('settings:get')!()
  writeFileSync(file, JSON.stringify({ transcriptionOnly: 'yes' }))
  expect(get().transcriptionOnly).toBe(false)
})
