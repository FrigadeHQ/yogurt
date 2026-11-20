import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => any>())
vi.mock('electron', () => ({ app: { getPreferredSystemLanguages: () => ['en-US'] }, ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn) }, BrowserWindow: {}, nativeTheme: {} }))
import { hookPreferences } from '../src/main/preferences'
import { loadSettings, summaryLanguageSetting, updateSettings } from '../src/main/settings'
import { LOCALES } from '../src/shared/i18n'

const dirs: string[] = []
afterEach(() => { dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })); handlers.clear() })

it('defaults to the meeting, validates IPC, persists every offered language and resets without changing other preferences', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-summary-language-')); dirs.push(dir)
  const file = join(dir, 'settings.json')
  const deps = { setShowNextMeeting: vi.fn(), file, permissions: {} as Parameters<typeof hookPreferences>[0]['permissions'], ask: false, setLogin() {}, loginOn: () => false, macName: () => '', relaunch: () => false, setTrayVisible() {}, setDockVisible() {} }
  hookPreferences(deps)
  const get = () => handlers.get('settings:get')!()
  const set = (value: unknown) => handlers.get('settings:summary-language')!(null, value)
  expect(get().summaryLanguage).toBe('')
  updateSettings(file, { language: 'ja', spoken: 'multi', theme: 'dark' })
  for (const { id } of LOCALES) {
    set(id)
    hookPreferences(deps)
    expect(get().summaryLanguage).toBe(id)
    expect(summaryLanguageSetting(loadSettings(file))).toBe(id)
  }
  set('fr')
  for (const value of [null, undefined, true, 1, {}, [], 'auto', 'xx', 'FR', 'fr-FR', ' French ']) set(value)
  expect(get().summaryLanguage).toBe('fr')
  set('')
  expect(get()).toMatchObject({ summaryLanguage: '', language: 'ja', locale: 'ja', spoken: 'multi', theme: 'dark' })
  expect(loadSettings(file)).toEqual({ language: 'ja', spoken: 'multi', theme: 'dark' })
  updateSettings(file, { summaryLanguage: 'unavailable' })
  expect(get().summaryLanguage).toBe('')
  expect(summaryLanguageSetting(loadSettings(file))).toBe('')
})
