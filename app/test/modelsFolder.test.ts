import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ default: { app: { getPath: () => '/nowhere' } } }))
import { modelsFolder } from '../src/main/paths'

const dirs: string[] = []
afterEach(() => { dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })); delete process.env.YOGURT_USER_DATA; delete process.env.YOGURT_MODELS_DIR })
const profile = () => { const d = mkdtempSync(join(tmpdir(), 'yogurt-models-')); dirs.push(d); process.env.YOGURT_USER_DATA = d; return d }

// Windows: the installer asks where the models go and leaves the answer in models-dir.txt (build/installer.nsh)
describe('where the models are kept', () => {
  it('in the profile by default', () => {
    const d = profile()
    expect(modelsFolder()).toBe(join(d, 'models'))
  })
  it("the folder the installer saved, written by NSIS as UTF-16 with a byte-order mark (any drive, any name)", () => {
    const d = profile()
    const chosen = join(d, 'Données IA', 'Yogurt models')
    writeFileSync(join(d, 'models-dir.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${chosen}\r\n`, 'utf16le')]))
    expect(modelsFolder()).toBe(chosen)
  })
  it('plain UTF-8 works too, and a relative or empty answer is ignored', () => {
    const d = profile()
    writeFileSync(join(d, 'models-dir.txt'), 'relative\\path')
    expect(modelsFolder()).toBe(join(d, 'models'))
    writeFileSync(join(d, 'models-dir.txt'), join(d, 'm2'))
    expect(modelsFolder()).toBe(join(d, 'm2'))
  })
  it('YOGURT_MODELS_DIR wins', () => {
    const d = profile()
    process.env.YOGURT_MODELS_DIR = join(d, 'env')
    expect(modelsFolder()).toBe(join(d, 'env'))
  })
})
