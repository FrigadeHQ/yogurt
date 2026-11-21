import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadSettings, saveSettings, updateSettings } from '../src/main/settings'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('settings persistence', () => {
  it('creates missing parent directories when saving settings', () => {
    const root = mkdtempSync(join(tmpdir(), 'yogurt-settings-'))
    dirs.push(root)
    const file = join(root, 'nested', 'profile', 'settings.json')
    saveSettings(file, { theme: 'dark' })
    expect(loadSettings(file)).toEqual({ theme: 'dark' })
  })

  it('ignores non-object JSON roots when loading and updating settings', () => {
    const root = mkdtempSync(join(tmpdir(), 'yogurt-settings-'))
    dirs.push(root)
    const file = join(root, 'settings.json')
    for (const raw of ['null', '[]', '"hello"', '42']) {
      writeFileSync(file, raw)
      expect(loadSettings(file)).toEqual({})
    }
    writeFileSync(file, '["stale"]')
    expect(updateSettings(file, { myName: 'Alex' })).toEqual({ myName: 'Alex' })
    expect(loadSettings(file)).toEqual({ myName: 'Alex' })
  })
})
