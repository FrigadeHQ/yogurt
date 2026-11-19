import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAiApps, TOKEN_SHAPE } from '../src/main/mcp/tokens'
import { firstKeysSetting, requiresAppKeys } from '../src/main/settings'

const dirs: string[] = []
afterEach(() => { dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })) })
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-keys-')); dirs.push(dir)
  const file = join(dir, 'settings.json')
  // a stand-in keychain: reversible, and never the key as written
  const apps = createAiApps({ file, seal: (p) => `s:${Buffer.from(p).toString('hex')}`, open: (s) => Buffer.from(s.slice(2), 'hex').toString() })
  return { apps, file }
}

describe('AI app keys', () => {
  it('gives each added app its own key, kept sealed in settings, and knows the app by it', () => {
    const { apps, file } = setup()
    const claude = apps.add('  Claude  ')!
    const hermes = apps.add('Hermes')!
    expect(claude.app.name).toBe('Claude')
    expect(claude.token).toMatch(TOKEN_SHAPE)
    expect(claude.token).not.toBe(hermes.token)
    expect(apps.list()).toEqual([claude.app, hermes.app])
    expect(apps.check(hermes.token)).toEqual(hermes.app)
    expect(apps.token(claude.app.id)).toBe(claude.token)
    const saved = readFileSync(file, 'utf8')
    expect(saved).not.toContain(claude.token)
    expect(saved).not.toContain(hermes.token)
  })
  it('knows no app by a wrong, malformed or removed key, and adds none without a name', () => {
    const { apps } = setup()
    const a = apps.add('Cursor')!
    expect(apps.check(a.token.slice(0, -1) + (a.token.endsWith('A') ? 'B' : 'A'))).toBeUndefined()
    expect(apps.check('not a key')).toBeUndefined()
    expect(apps.check('')).toBeUndefined()
    expect(apps.add('   ')).toBeNull()
    expect(apps.remove(a.app.id)).toBe(true)
    expect(apps.check(a.token)).toBeUndefined()
    expect(apps.token(a.app.id)).toBeNull()
    expect(apps.list()).toEqual([])
    expect(apps.remove(a.app.id)).toBe(false)
  })
  it('a key the keychain can no longer open matches nothing, and the other apps keep working', () => {
    const { apps } = setup()
    const a = apps.add('One')!
    const broken = createAiApps({ file: setup().file, seal: (p) => p, open: () => { throw new Error('locked') } })
    expect(broken.check(a.token)).toBeUndefined()
    expect(apps.check(a.token)).toEqual(a.app)
  })
})

describe('whether AI apps need a key', () => {
  it('they do on a new profile, and when the person turns it on', () => {
    expect(requiresAppKeys({})).toBe(true)
    expect(requiresAppKeys({ aiApps: true })).toBe(true)
    expect(requiresAppKeys({ aiApps: true, aiAppsRequireToken: false })).toBe(false)
  })
  it('the first launch with keys writes the choice once: off where AI apps were already on, on everywhere else', () => {
    expect(firstKeysSetting({})).toEqual({ aiAppsRequireToken: true })
    expect(firstKeysSetting({ aiApps: false })).toEqual({ aiAppsRequireToken: true })
    expect(firstKeysSetting({ aiApps: true })).toEqual({ aiAppsRequireToken: false })
    // written: later launches leave it, whatever AI apps is set to now
    expect(firstKeysSetting({ aiApps: true, aiAppsRequireToken: true })).toBeNull()
    expect(firstKeysSetting({ aiApps: true, aiAppsRequireToken: false })).toBeNull()
  })
})
