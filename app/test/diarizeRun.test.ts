import { chmodSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { diarizeTimeoutMs, probeBackend, runDecode, runDiarize } from '../src/main/diarize/run'
import { writeWav } from '../src/main/diarize/wav'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'yogurt-diarize-run-')); dirs.push(d); return d }
/** a stand-in helper: node script that mimics yogurt-audio decode */
const fakeDecode = (dir: string, fail = false) => {
  const f = join(dir, 'decode.mjs')
  // a shebang + exec bit: Linux can't spawn a bare script (EACCES), same stand-in trick as helperRunner.test.ts
  writeFileSync(f, '#!/usr/bin/env node\n' + (fail ? "process.stderr.write('unsupported-input'); process.exit(1)" : `
    import { writeFileSync, readFileSync } from 'node:fs'
    const a = process.argv
    const input = a[a.indexOf('--in') + 1]
    writeFileSync(a[a.indexOf('--out') + 1], readFileSync(input))
  `))
  chmodSync(f, 0o755)
  return f
}
const fakeNemo = (dir: string, o: { failFirst?: boolean } = {}) => {
  const f = join(dir, 'nemo.mjs')
  writeFileSync(f, `#!/usr/bin/env node
    import { appendFileSync, writeFileSync, existsSync } from 'node:fs'
    const a = process.argv
    const device = a[a.indexOf('--device') + 1]
    appendFileSync(${JSON.stringify(join(dir, 'devices.txt'))}, device + '\\n')
    if (${o.failFirst ? 'true' : 'false'} && !existsSync(${JSON.stringify(join(dir, 'first-run'))})) { writeFileSync(${JSON.stringify(join(dir, 'first-run'))}, '1'); process.exit(1) }
    writeFileSync(a[a.indexOf('--output') + 1], 'SPEAKER them 1 0.000 1.000 <NA> <NA> 0 <NA> <NA>\\n')
  `)
  chmodSync(f, 0o755)
  return f
}

describe('probeBackend', () => {
  it('follows YOGURT_DIARIZE_BACKEND, else metal on a mac and vulkan elsewhere', () => {
    expect(probeBackend('linux', { YOGURT_DIARIZE_BACKEND: 'cpu' })).toBe('cpu')
    expect(probeBackend('darwin', {})).toBe('metal')
    expect(probeBackend('win32', {})).toBe('vulkan')
  })
})

describe('diarizeTimeoutMs', () => {
  it('is generous but bounded', () => {
    expect(diarizeTimeoutMs(60_000)).toBe(600_000)
    expect(diarizeTimeoutMs(1000)).toBe(180_000)
  })
})

describe('runDecode', () => {
  // the stand-ins are shebang scripts, which Windows can't start (same skip as helperRunner.test.ts)
  it.skipIf(process.platform === 'win32')('copies through the helper and leaves the wav there', async () => {
    const dir = tmp(), wav = join(dir, 'in.wav')
    writeWav(wav, new Float32Array([0, 1, -1]))
    const out = join(dir, 'out.wav')
    await runDecode(fakeDecode(dir), wav, out)
    expect(existsSync(out)).toBe(true)
  })
  it.skipIf(process.platform === 'win32')('rejects with the helper\'s reason on failure', async () => {
    const dir = tmp()
    await expect(runDecode(fakeDecode(dir, true), join(dir, 'x.m4a'), join(dir, 'out.wav'))).rejects.toThrow(/unsupported-input/)
  })
})

describe('runDiarize', () => {
  it.skipIf(process.platform === 'win32')('writes the rttm file and reports the gpu backend', async () => {
    const dir = tmp(), rttm = join(dir, 'them.rttm')
    const where = await runDiarize(fakeNemo(dir), join(dir, 'them.wav'), 'm.gguf', rttm, 'vulkan')
    expect(where).toBe('gpu')
    expect(readFileSync(rttm, 'utf8')).toContain('SPEAKER them')
    expect(readFileSync(join(dir, 'devices.txt'), 'utf8')).toBe('vulkan\n')
  })
  it.skipIf(process.platform === 'win32')('falls back to cpu once when the accelerator fails', async () => {
    const dir = tmp(), rttm = join(dir, 'them.rttm')
    const where = await runDiarize(fakeNemo(dir, { failFirst: true }), join(dir, 'them.wav'), 'm.gguf', rttm, 'vulkan')
    expect(where).toBe('cpu')
    expect(readFileSync(join(dir, 'devices.txt'), 'utf8')).toBe('vulkan\ncpu\n')
  })
  it.skipIf(process.platform === 'win32')('does not fall back when cpu was already asked for', async () => {
    const dir = tmp()
    await expect(runDiarize(fakeNemo(dir, { failFirst: true }), join(dir, 'them.wav'), 'm.gguf', join(dir, 'r.rttm'), 'cpu', 200)).rejects.toThrow()
    expect(readFileSync(join(dir, 'devices.txt'), 'utf8')).toBe('cpu\n')
  })
  it.skipIf(process.platform === 'win32')('keeps the fallback log to backend names only', async () => {
    const dir = tmp()
    const logs: string[] = []
    const { info, warn } = console
    console.info = (...a: unknown[]) => logs.push(a.join(' '))
    console.warn = (...a: unknown[]) => logs.push(a.join(' '))
    try {
      const where = await runDiarize(fakeNemo(dir, { failFirst: true }), join(dir, 'them.wav'), 'm.gguf', join(dir, 'r.rttm'), 'vulkan')
      expect(where).toBe('cpu')
    } finally {
      console.info = info
      console.warn = warn
    }
    const text = logs.join('\n')
    expect(text).toContain('DIARIZE vulkan failed, trying the cpu')
    expect(text).toContain('DIARIZE backend: cpu')
    expect(text).not.toContain(dir) // no temp paths
    expect(text).not.toMatch(/failed \(/) // no exit-code detail
  })
  it.skipIf(process.platform === 'win32')('times out a stuck child', async () => {
    const dir = tmp()
    const f = join(dir, 'stuck.mjs')
    writeFileSync(f, "#!/usr/bin/env node\nsetInterval(() => {}, 1000)")
    chmodSync(f, 0o755)
    await expect(runDiarize(f, join(dir, 'them.wav'), 'm.gguf', join(dir, 'r.rttm'), 'cpu', 100)).rejects.toThrow(/timed out/)
  })
})
