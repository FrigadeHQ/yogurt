import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { speedKey, type Catalog, type Hardware } from '@yogurt/picker'
import bundled from '../../catalog/catalog.json'
import { SetupController, type SetupDeps, type SpeedDeps, type SpeedResult } from '../src/main/setup'
import { tooSlow } from '../src/main/localCheck'
import { fakeDownloadDeps } from '../src/main/fake'
import { DiskSpaceError, type DownloadDeps } from '../src/main/downloader'
import type { SetupState } from '../src/shared/types'
import { loadSettings, updateSettings } from '../src/main/settings'
import { notesDownloadVisible, notesUpgradeActive } from '../src/renderer/src/notesSetup'
import { createNotesModel } from '../src/main/notes/model'
import { FakeEngine } from '../src/main/notes/fake'
import { createQueue } from '../src/main/notes/queue'

const catalog = bundled as unknown as Catalog
const m1max: Hardware = { os: 'darwin', arch: 'arm64', cpuModel: 'Apple M1 Max', totalRamGB: 32, freeDiskGB: 500, gpu: { kind: 'unified', name: 'Apple M1 Max', vramGB: 24 } }
const mac8: Hardware = { os: 'darwin', arch: 'arm64', cpuModel: 'Apple M1', totalRamGB: 8.6, freeDiskGB: 500, gpu: { kind: 'unified', name: 'Apple M1', vramGB: 6 } }

const name = (url: string) => decodeURIComponent(new URL(url).pathname.split('/').pop()!)

/** a download that records what was asked for, and can hold chosen files back until released */
function recorder(hold: (url: string) => boolean = () => false) {
  const asked: string[] = []
  const released: (() => void)[] = []
  const inner = fakeDownloadDeps({ stepMs: 0 })
  const download: DownloadDeps['download'] = async (url, dir, file, onProgress, signal) => {
    asked.push(url)
    if (hold(url)) await new Promise<void>((r) => released.push(r))
    return inner.download(url, dir, file, onProgress, signal)
  }
  return { asked, release: () => released.splice(0).forEach((r) => r()), deps: { ...inner, download } as DownloadDeps }
}

function setup(over: Partial<SetupDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'yogurt-setup-'))
  const rec = recorder()
  const deps: SetupDeps = { getHardware: async () => m1max, getCatalog: async () => catalog, modelsDir: root, download: rec.deps, sha256Override: 'FAKE', retryDelaysMs: [0, 0], ...over }
  const c = new SetupController(deps)
  const states: SetupState[] = []
  c.onState((s) => states.push(s))
  return { c, states, root, rec }
}

const starterUrl = catalog.models.find((m) => m.starter)!.builds[0].url
const bigUrl = catalog.models.find((m) => m.id === 'gemma-4-26b-a4b')!.builds[0].url
const embedUrl = catalog.embedding.url
const turboUrl = catalog.asr[0].url
const smallUrl = catalog.asr[1].url

describe('SetupController', () => {
  it('goes checking, downloading, ready; the fraction only goes up and ends at 1', async () => {
    const { c, states } = setup()
    expect(c.state.phase).toBe('checking')
    await c.start()
    await c.idle()
    expect(states[0].phase).toBe('checking')
    expect(states.some((s) => s.phase === 'downloading')).toBe(true)
    expect(states.at(-1)).toMatchObject({ phase: 'ready', fraction: 1 })
    const phases = states.map((s) => s.phase)
    expect(phases.indexOf('checking')).toBeLessThan(phases.indexOf('downloading'))
    expect(phases.indexOf('downloading')).toBeLessThan(phases.indexOf('ready'))
    const fractions = states.map((s) => s.fraction)
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b))
  })

  it('fetches speech first, then the starter notes model, then the recommended one', async () => {
    const { c, rec } = setup()
    await c.start(); await c.idle()
    const files = rec.asked.map(name)
    const at = (u: string) => rec.asked.indexOf(u)
    expect(at(turboUrl)).toBe(0)
    expect(at(starterUrl)).toBeGreaterThan(at(turboUrl))
    expect(at(bigUrl)).toBeGreaterThan(at(starterUrl))
    expect(files).not.toContain(name(smallUrl))
  })

  it('is ready before the recommended notes model finishes, which keeps downloading', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yogurt-setup-'))
    const rec = recorder((u) => u === bigUrl)
    const c = new SetupController({ getHardware: async () => m1max, getCatalog: async () => catalog, modelsDir: root, download: rec.deps, sha256Override: 'FAKE', retryDelaysMs: [0] })
    await c.start()
    expect(c.state).toMatchObject({ phase: 'ready', fraction: 1 })
    await vi.waitFor(() => expect(rec.asked).toContain(bigUrl))
    expect(c.installed()?.recommendedLlm).toBeUndefined()
    rec.release()
    await c.idle()
    expect(c.installed()?.recommendedLlm).toMatch(/gemma-4-26B/)
  })

  it('is ready as soon as speech and the speaker models are in: the first notes model arrives after, and says so', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yogurt-setup-'))
    const rec = recorder((u) => u === starterUrl)
    const c = new SetupController({ getHardware: async () => m1max, getCatalog: async () => catalog, modelsDir: root, download: rec.deps, sha256Override: 'FAKE', retryDelaysMs: [0] })
    const arrived: string[] = []
    c.onNotesModel(() => arrived.push(c.installed()!.llm!))
    await c.start()
    expect(c.state).toMatchObject({ phase: 'ready', fraction: 1 })
    expect(c.installed()?.asr).toBeTruthy()
    expect(c.installed()?.llm).toBeUndefined()
    await vi.waitFor(() => expect(rec.asked).toContain(starterUrl))
    rec.release()
    await vi.waitFor(() => expect(arrived).toHaveLength(1))
    expect(c.installed()?.llm).toMatch(/E4B/)
    await c.idle()
  })

  it('a first notes model that fails to download keeps being tried in the background; ready stays', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yogurt-setup-'))
    const inner = fakeDownloadDeps({ stepMs: 0 })
    let fails = 3
    const download: DownloadDeps['download'] = async (u, ...rest) => { if (u === starterUrl && fails-- > 0) throw new Error('fetch failed'); return inner.download(u, ...rest) }
    const c = new SetupController({ getHardware: async () => m1max, getCatalog: async () => catalog, modelsDir: root, download: { ...inner, download }, sha256Override: 'FAKE', retryDelaysMs: [0], notesRetryMs: [0] })
    await c.start()
    expect(c.state.phase).toBe('ready')
    await c.idle()
    expect(c.state.phase).toBe('ready')
    expect(c.installed()?.llm).toMatch(/E4B/)
  })

  it('the embedding model (meaning search) comes after the first notes model and before the bigger one; ready never waits for it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yogurt-setup-'))
    const rec = recorder((u) => u === embedUrl)
    const c = new SetupController({ getHardware: async () => m1max, getCatalog: async () => catalog, modelsDir: root, download: rec.deps, sha256Override: 'FAKE', retryDelaysMs: [0] })
    const arrived: string[] = []
    c.onEmbedModel(() => arrived.push(c.installed()!.embed!))
    await c.start()
    expect(c.state.phase).toBe('ready')
    await vi.waitFor(() => expect(rec.asked).toContain(embedUrl))
    expect(rec.asked.indexOf(embedUrl)).toBeGreaterThan(rec.asked.indexOf(starterUrl))
    expect(c.installed()?.embed).toBeUndefined()
    rec.release()
    await c.idle()
    expect(rec.asked.indexOf(bigUrl)).toBeGreaterThan(rec.asked.indexOf(embedUrl))
    expect(c.installed()?.embed).toMatch(/embed[\\/]embeddinggemma-300M-Q8_0\.gguf$/)
    expect(arrived).toEqual([c.installed()!.embed])
  })

  it('an embedding model that fails keeps being tried, and the bigger notes model does not wait for it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yogurt-setup-'))
    const inner = fakeDownloadDeps({ stepMs: 0 })
    let fails = 5
    const asked: string[] = []
    const download: DownloadDeps['download'] = async (u, ...rest) => { asked.push(u); if (u === embedUrl && fails-- > 0) throw new Error('fetch failed'); return inner.download(u, ...rest) }
    const c = new SetupController({ getHardware: async () => m1max, getCatalog: async () => catalog, modelsDir: root, download: { ...inner, download }, sha256Override: 'FAKE', retryDelaysMs: [0], notesRetryMs: [0] })
    await c.start(); await c.idle()
    expect(c.state.phase).toBe('ready')
    expect(c.installed()?.recommendedLlm).toMatch(/gemma-4-26B/)
    expect(c.installed()?.embed).toMatch(/embeddinggemma/)
    expect(asked.filter((u) => u === embedUrl).length).toBe(6)
  })

  it('the bigger notes model says in the log when it starts downloading and when it is in, and logs nothing when it is already there', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      const { c, root } = setup()
      await c.start(); await c.idle()
      const lines = () => info.mock.calls.map((a) => a.join(' ')).filter((l) => /bigger notes model/.test(l))
      expect(lines()).toEqual([expect.stringMatching(/downloading the bigger notes model gemma-4-26B.*14\.\d GB/), expect.stringMatching(/the bigger notes model is in/)])
      info.mockClear()
      const again = new SetupController({ getHardware: async () => m1max, getCatalog: async () => catalog, modelsDir: root, download: recorder().deps, sha256Override: 'FAKE', retryDelaysMs: [0] })
      await again.start(); await again.idle()
      expect(lines()).toEqual([])
    } finally { info.mockRestore() }
  })

  it.each([240, 0, -1, NaN, Infinity])('reports separate upgrade progress and a valid ETA (%s), then clears it', async (etaSec) => {
    const inner = fakeDownloadDeps({ stepMs: 0 })
    const download: DownloadDeps['download'] = (url, dir, file, onProgress, signal) =>
      inner.download(url, dir, file, p => onProgress({ ...p, etaSec }), signal)
    const { c, states } = setup({ download: { ...inner, download } })
    await c.start(); await c.idle()
    const upgrade = states.filter(s => s.notesUpgradeDownloading)
    const bytes = catalog.models.flatMap(m => m.builds).find(b => b.url === bigUrl)!.sizeGB * 1e9
    expect(upgrade.map(s => s.notesUpgradeFraction)).toEqual([0, .25, .5, .75, 1])
    expect(upgrade[0]).toMatchObject({ notesUpgradeTotalBytes: bytes, notesUpgradeEtaSec: undefined })
    expect(upgrade.find(s => s.notesUpgradeFraction === .5)).toMatchObject({ notesUpgradeTotalBytes: bytes, notesUpgradeEtaSec: etaSec > 0 && Number.isFinite(etaSec) ? etaSec : undefined })
    expect(upgrade.every(s => s.phase === 'ready' && !s.notesDownloading && !s.notesError && s.notesFraction === undefined)).toBe(true)
    expect(states.filter(s => s.notesDownloading).every(s => !s.notesUpgradeDownloading && s.notesUpgradeFraction === undefined)).toBe(true)
    expect(c.installed()?.recommendedLlm).toBeTruthy()
    expect(c.state).toMatchObject({ notesUpgradeDownloading: undefined, notesUpgradeFraction: undefined, notesUpgradeTotalBytes: undefined, notesUpgradeEtaSec: undefined, notesUpgradeError: undefined })
  })

  it('keeps the first model usable after an upgrade failure, then retries only the upgrade once', async () => {
    const inner = fakeDownloadDeps({ stepMs: 0 })
    let blocked = true, attempts = 0
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const asked: string[] = []
    const download: DownloadDeps['download'] = async (url, dir, file, onProgress, signal) => {
      asked.push(url)
      if (url === bigUrl) {
        attempts++
        onProgress({ fraction: .42, etaSec: 240 })
        if (blocked) throw new DiskSpaceError(4)
        await held
      }
      return inner.download(url, dir, file, onProgress, signal)
    }
    const { c } = setup({ download: { ...inner, download }, retryDelaysMs: [] })
    try {
      await c.start(); await c.idle()
      const first = c.installed()?.llm
      expect(first).toBeTruthy()
      expect(c.installed()?.recommendedLlm).toBeUndefined()
      expect(c.state).toMatchObject({ phase: 'ready', notesUpgradeError: 'Not enough disk space. Free up 4 GB and try again.', notesUpgradeDownloading: undefined, notesUpgradeFraction: .42, notesUpgradeTotalBytes: expect.any(Number), notesUpgradeEtaSec: undefined })
      expect(c.state.notesError).toBeUndefined()
      blocked = false
      await Promise.all(Array.from({ length: 10 }, () => c.retry()))
      await vi.waitFor(() => expect(c.state.notesUpgradeFraction).toBe(.42))
      expect(c.state).toMatchObject({ notesUpgradeDownloading: true, notesUpgradeEtaSec: 240, notesUpgradeError: undefined })
      expect(c.state.notesUpgradeTotalBytes).toBeGreaterThan(0)
      await Promise.all(Array.from({ length: 10 }, () => c.retry()))
      expect(attempts).toBe(2)
      expect(asked.filter(url => url === starterUrl)).toHaveLength(1)
      expect(c.installed()?.llm).toBe(first)
      release()
      await c.idle()
      expect(c.installed()?.recommendedLlm).toBeTruthy()
      expect(c.state).toMatchObject({ phase: 'ready', notesUpgradeDownloading: undefined, notesUpgradeFraction: undefined, notesUpgradeTotalBytes: undefined, notesUpgradeEtaSec: undefined, notesUpgradeError: undefined })
    } finally { release(); await c.idle() }
  })

  it('shows the first notes-model failure while recording stays ready, and retry wakes only the existing download loop', async () => {
    vi.useFakeTimers()
    let blocked = true, attempts = 0, active = 0, peak = 0
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const download: DownloadDeps = {
      freeDiskGB: async () => 500,
      hashFile: async () => 'FAKE',
      download: async (url, dir, file, onProgress) => {
        if (url === starterUrl) { attempts++; active++; peak = Math.max(peak, active) }
        try {
          if (url === starterUrl) {
            onProgress({ fraction: 0.42, etaSec: 240 })
            if (blocked) throw new DiskSpaceError(4)
            await held
          }
          mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, file), 'fake')
        } finally { if (url === starterUrl) active-- }
      },
    }
    const { c, states } = setup({ download, retryDelaysMs: [], notesRetryMs: [60_000] })
    const arrived = vi.fn()
    c.onNotesModel(arrived)
    try {
      await c.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(c.state).toMatchObject({ phase: 'ready', notesError: 'Not enough disk space. Free up 4 GB and try again.' })
      expect(c.state.notesTotalBytes).toBeGreaterThan(0)
      expect(c.state.notesFraction).toBe(.42)
      expect(c.state.notesEtaSec).toBeUndefined()
      expect(c.installed()?.asr).toBeTruthy()
      expect(c.installed()?.llm).toBeUndefined()
      expect(attempts).toBe(1)
      blocked = false
      await Promise.all(Array.from({ length: 10 }, () => c.retry()))
      await vi.advanceTimersByTimeAsync(0)
      expect(attempts).toBe(2)
      expect(c.state).not.toHaveProperty('notesError', expect.any(String))
      expect(c.state.notesTotalBytes).toBeGreaterThan(0)
      // A resumed download can report the same percentage as before the failure.
      expect(c.state).toMatchObject({ notesFraction: 0.42, notesEtaSec: 240 })
      await Promise.all(Array.from({ length: 10 }, () => c.retry()))
      // The old automatic retry must not start another download while this one is active.
      await vi.advanceTimersByTimeAsync(60_000)
      expect(attempts).toBe(2)
      expect(peak).toBe(1)
      release()
      await c.idle()
      expect(c.installed()?.llm).toMatch(/E4B/)
      expect(arrived).toHaveBeenCalledOnce()
      expect(states.every((s) => s.phase !== 'error')).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      blocked = false; release()
      await vi.advanceTimersByTimeAsync(60_000)
      await c.idle()
      vi.useRealTimers()
    }
  })

  it('an 8 GB Mac gets turbo speech and one notes model (the pick is smaller than the starter)', async () => {
    const { c, rec, states } = setup({ getHardware: async () => mac8 })
    await c.start(); await c.idle()
    expect(rec.asked[0]).toBe(turboUrl)
    expect(rec.asked).not.toContain(starterUrl)
    // the one notes model, then the embedding model
    expect(rec.asked.slice(1)).toEqual([expect.stringContaining('E4B-it-Q3_K_S'), embedUrl])
    expect(c.state.phase).toBe('ready')
    expect(states.some(s => s.notesUpgradeDownloading || s.notesUpgradeError)).toBe(false)
  })

  it('a Mac with under 8 GB gets the small speech model', async () => {
    const { c, rec } = setup({ getHardware: async () => ({ ...mac8, totalRamGB: 6 }) })
    await c.start(); await c.idle()
    expect(rec.asked).toContain(smallUrl)
    expect(rec.asked).not.toContain(turboUrl)
  })

  it('a Mac too small for any notes model says so, as it always did', async () => {
    const { c, rec } = setup({ getHardware: async () => ({ ...mac8, totalRamGB: 4 }) })
    await c.start(); await c.idle()
    expect(c.state).toMatchObject({ phase: 'error', message: 'Yogurt needs a Mac with at least 8 GB of memory.' })
    expect(rec.asked).toEqual([])
  })

  it('a Windows or Linux computer too small says everything runs on it, with no cloud to fall back on', async () => {
    for (const os of ['win32', 'linux'] as const) {
      const pc: Hardware = { os, arch: 'x64', cpuModel: 'Intel Core i3', totalRamGB: 4, freeDiskGB: 500, gpu: { kind: 'none', name: '', vramGB: 0 } }
      const { c, rec } = setup({ getHardware: async () => pc })
      await c.start(); await c.idle()
      expect(c.state).toMatchObject({ phase: 'error', message: "Yogurt runs entirely on your computer, and this one isn't strong enough. It needs at least 8 GB of memory." })
      expect(rec.asked).toEqual([])
    }
  })

  it('falls back to small when turbo fails its checksum', async () => {
    const inner = fakeDownloadDeps({ stepMs: 0 })
    const hashFile = async (p: string) => (p.includes('large-v3-turbo') ? 'WRONG' : 'FAKE')
    const { c, rec } = setup({ download: { ...inner, hashFile } })
    void rec
    await c.start(); await c.idle()
    expect(c.state.phase).toBe('ready')
    expect(c.installed()?.asr).toContain('ggml-small-q5_1.bin')
  })

  it('downloads nothing for the bundled whisper-server: ready does not wait on it', async () => {
    expect(catalog.whisperServer.bundled).toBe(true)
    const { c, rec } = setup()
    await c.start(); await c.idle()
    expect(c.state.phase).toBe('ready')
    expect(rec.asked.filter((u) => /whisper-server/.test(u))).toEqual([])
  })

  it('finds everything already in place on the next start and downloads nothing', async () => {
    const first = setup()
    await first.c.start(); await first.c.idle()
    const again = setup({ modelsDir: first.root })
    await again.c.start(); await again.c.idle()
    expect(again.rec.asked).toEqual([])
    expect(again.c.state).toMatchObject({ phase: 'ready', fraction: 1 })
    expect(again.states.some(s => s.notesUpgradeDownloading || s.notesUpgradeError)).toBe(false)
  })

  it('says so plainly when the disk is too full, and a retry works once there is room', async () => {
    let free = 5
    const inner = fakeDownloadDeps({ stepMs: 0 })
    const { c } = setup({ download: { ...inner, freeDiskGB: async () => free } })
    await c.start()
    expect(c.state.phase).toBe('error')
    expect(c.state.message).toMatch(/Not enough disk space/)
    free = 500
    await c.retry(); await c.idle()
    expect(c.state.phase).toBe('ready')
  })

  it('shows a plain message when the network drops', async () => {
    const inner = fakeDownloadDeps({ stepMs: 0 })
    const { c } = setup({ download: { ...inner, download: async () => { throw new Error('fetch failed') } } })
    await c.start()
    expect(c.state).toMatchObject({ phase: 'error' })
    expect(c.state.message).toMatch(/connection/)
  })

  it('errors when there is no notes model this Mac can run', async () => {
    const { c } = setup({ getHardware: async () => ({ ...mac8, totalRamGB: 2 }) })
    await c.start()
    expect(c.state.phase).toBe('error')
  })

  it('ignores a second start while one is running', async () => {
    const { c, rec } = setup()
    await Promise.all([c.start(), c.start()])
    await c.idle()
    expect(rec.asked.filter((u) => u === turboUrl)).toHaveLength(1)
  })

  it('a finished install is ready at once and never shows downloading', async () => {
    const first = setup()
    await first.c.start(); await first.c.idle()
    const again = setup({ modelsDir: first.root })
    await again.c.start()
    expect(again.c.state).toMatchObject({ phase: 'ready', fraction: 1 })
    expect(again.states.some((s) => s.phase === 'downloading')).toBe(false)
  })
})

describe('the speed check (Windows and Linux): speech models timed on this computer', () => {
  const cpuPc: Hardware = { os: 'win32', arch: 'x64', cpuModel: 'Intel Core i5-1135G7', totalRamGB: 16, freeDiskGB: 500, gpu: { kind: 'none', name: '', vramGB: 0 }, cores: 8 }
  const gpuPc: Hardware = { os: 'linux', arch: 'x64', cpuModel: 'AMD Ryzen 5 5600X', totalRamGB: 16, freeDiskGB: 500, gpu: { kind: 'discrete', name: 'NVIDIA GeForce RTX 3060', vramGB: 12 }, cores: 12 }
  const url = (id: string) => catalog.asr.find((a) => a.id === id)!.url
  /** fake timings per model file, and a store kept in memory */
  function speed(rtf: Record<string, number | null>, saved?: SpeedResult) {
    const timed: string[] = []
    let stored = saved
    const deps: SpeedDeps = {
      measure: async (path) => { const id = Object.keys(rtf).find((k) => path.includes(catalog.asr.find((a) => a.id === k)!.url.split('/').pop()!))!; timed.push(id); return { rtf: rtf[id] } },
      load: () => stored, save: (r) => { stored = r },
    }
    return { deps, timed, stored: () => stored }
  }

  it('the first notes model shows progress on Windows, then clears it when installed', async () => {
    const s = speed({ 'whisper-small-q5_1': 0.3 })
    const { c, states } = setup({ getHardware: async () => cpuPc, speed: s.deps })
    await c.start(); await c.idle()
    const shown = states.filter((x) => x.phase === 'ready' && x.notesFraction !== undefined).map((x) => x.notesFraction)
    expect(shown).toEqual([0, 0.25, 0.5, 0.75, 1])
    expect(c.state.notesFraction).toBeUndefined()
    expect(c.installed()?.llm).toBeTruthy()
  })

  it('a Mac reports the same notes download progress', async () => {
    const { c, states } = setup()
    await c.start(); await c.idle()
    expect(states.filter(x => x.notesFraction !== undefined).map(x => x.notesFraction)).toEqual([0, 0.25, 0.5, 0.75, 1])
    expect(c.state.notesFraction).toBeUndefined()
  })

  it('every system says the first notes model is still downloading, until it is in', async () => {
    for (const hw of [m1max, cpuPc, gpuPc]) {
      const { c, states } = setup({ getHardware: async () => hw })
      await c.start(); await c.idle()
      expect(states.some((x) => x.phase === 'ready' && x.notesDownloading && x.notesFraction === 0)).toBe(true)
      expect(states.some((x) => (x.notesFraction ?? 0) > 0)).toBe(true)
      expect(c.state.notesFraction).toBeUndefined()
      expect(c.state.notesDownloading).toBeUndefined()
    }
  })

  it.each([m1max, cpuPc, gpuPc])('passes the model size and downloader ETA through on $os, and clears both on completion', async hw => {
    const inner = fakeDownloadDeps({ stepMs: 0 }), requested: string[] = []
    const { c, states } = setup({ getHardware: async () => hw, download: {
      ...inner,
      download: (url, dir, file, onProgress, signal) => {
        requested.push(url)
        return inner.download(url, dir, file, p => onProgress({ ...p, etaSec: 240 }), signal)
      },
    } })
    await c.start(); await c.idle()
    const first = catalog.models.flatMap(m => m.builds).find(b => b.url === requested[1])!
    expect(states.find(s => s.notesFraction === 0)).toMatchObject({ notesTotalBytes: first.sizeGB * 1e9, notesEtaSec: undefined })
    expect(states.find(s => s.notesFraction === .5)).toMatchObject({ notesTotalBytes: first.sizeGB * 1e9, notesEtaSec: 240 })
    expect(c.state.notesTotalBytes).toBeUndefined()
    expect(c.state.notesEtaSec).toBeUndefined()
  })

  it('a Mac never runs it, even when it is offered: turbo as always, nothing timed or stored', async () => {
    const s = speed({ 'whisper-large-v3-turbo-q5_0': 9 })
    const { c, rec } = setup({ speed: s.deps })
    await c.start(); await c.idle()
    expect(c.state.phase).toBe('ready')
    expect(rec.asked[0]).toBe(turboUrl)
    expect(s.timed).toEqual([])
    expect(s.stored()).toBeUndefined()
  })

  it('on the processor alone: small first (never turbo), then smaller until one keeps up; the result is stored', async () => {
    const s = speed({ 'whisper-small-q5_1': 0.88, 'whisper-base-q5_1': 0.42, 'whisper-tiny-q5_1': 0.19 })
    const { c, rec } = setup({ getHardware: async () => cpuPc, speed: s.deps })
    await c.start(); await c.idle()
    expect(c.state.phase).toBe('ready')
    expect(s.timed).toEqual(['whisper-small-q5_1', 'whisper-base-q5_1'])
    expect(rec.asked).not.toContain(turboUrl)
    expect(rec.asked).not.toContain(url('whisper-tiny-q5_1'))
    expect(c.installed()?.asr).toContain('ggml-base-q5_1.bin')
    expect(s.stored()).toMatchObject({ key: speedKey(cpuPc), model: 'whisper-base-q5_1', rtf: { 'whisper-small-q5_1': 0.88, 'whisper-base-q5_1': 0.42 } })
  })

  it('with graphics turbo is timed first and kept when it keeps up', async () => {
    const s = speed({ 'whisper-large-v3-turbo-q5_0': 0.1 })
    const { c } = setup({ getHardware: async () => gpuPc, speed: s.deps })
    await c.start(); await c.idle()
    expect(s.timed).toEqual(['whisper-large-v3-turbo-q5_0'])
    expect(c.installed()?.asr).toContain('large-v3-turbo')
  })

  it('a stored result on the same computer is used as it is: nothing is timed again', async () => {
    const s = speed({}, { key: speedKey(cpuPc), model: 'whisper-tiny-q5_1', rtf: { 'whisper-tiny-q5_1': 0.2 }, at: 1 })
    const { c, rec } = setup({ getHardware: async () => cpuPc, speed: s.deps })
    await c.start(); await c.idle()
    expect(s.timed).toEqual([])
    expect(rec.asked[0]).toBe(url('whisper-tiny-q5_1'))
    expect(c.installed()?.asr).toContain('ggml-tiny-q5_1.bin')
  })

  it('new graphics (or none any more) mean timing again', async () => {
    const s = speed({ 'whisper-small-q5_1': 0.3 }, { key: speedKey(gpuPc), model: 'whisper-large-v3-turbo-q5_0', rtf: {}, at: 1 })
    const { c } = setup({ getHardware: async () => ({ ...gpuPc, gpu: { kind: 'none', name: '', vramGB: 0 } }), speed: s.deps })
    await c.start(); await c.idle()
    expect(s.timed).toEqual(['whisper-small-q5_1'])
    expect(s.stored()?.model).toBe('whisper-small-q5_1')
  })

  it("none keeps up: setup stops with the plain words, stores that, and says it again next time without timing; Try again times again", async () => {
    for (const os of ['win32', 'linux'] as const) {
      const pc = { ...cpuPc, os }
      const s = speed({ 'whisper-small-q5_1': 2, 'whisper-base-q5_1': 1.1, 'whisper-tiny-q5_1': null })
      const first = setup({ getHardware: async () => pc, speed: s.deps })
      await first.c.start()
      expect(first.c.state).toMatchObject({ phase: 'error', message: tooSlow(os) })
      expect(first.c.installed()).toBeUndefined()
      expect(s.stored()).toMatchObject({ model: null, rtf: { 'whisper-small-q5_1': 2, 'whisper-base-q5_1': 1.1, 'whisper-tiny-q5_1': null } })
      expect(s.timed).toHaveLength(3)

      const again = setup({ getHardware: async () => pc, speed: s.deps, modelsDir: first.root })
      await again.c.start()
      expect(again.c.state).toMatchObject({ phase: 'error', message: tooSlow(os) })
      expect(s.timed).toHaveLength(3)
      expect(again.rec.asked).toEqual([])

      await again.c.retry()
      expect(s.timed).toHaveLength(6)
    }
  })

  it('a model that keeps failing its checksum is skipped for the next one', async () => {
    const s = speed({ 'whisper-small-q5_1': 0.1, 'whisper-base-q5_1': 0.2 })
    const inner = fakeDownloadDeps({ stepMs: 0 })
    const hashFile = async (p: string) => (p.includes('small-q5_1') ? 'WRONG' : 'FAKE')
    const { c } = setup({ getHardware: async () => cpuPc, speed: s.deps, download: { ...inner, hashFile } })
    await c.start(); await c.idle()
    expect(c.state.phase).toBe('ready')
    expect(s.timed).toEqual(['whisper-base-q5_1'])
  })

  it('the quick core count still stops a 2-core computer without graphics before anything downloads or is timed', async () => {
    const s = speed({ 'whisper-small-q5_1': 0.1 })
    const { c, rec } = setup({ getHardware: async () => ({ ...cpuPc, cores: 2 }), speed: s.deps })
    await c.start()
    expect(c.state.phase).toBe('error')
    expect(rec.asked).toEqual([])
    expect(s.timed).toEqual([])
  })
})

const preference = (root: string): NonNullable<SetupDeps['upgradePreference']> => ({
  load: () => loadSettings(join(root, 'settings.json')).notesUpgradeSkipped === true,
  save: skipped => { updateSettings(join(root, 'settings.json'), { notesUpgradeSkipped: skipped }) },
})

describe('optional better notes model', () => {
  it('keeps the chip visible across the embedding stage and into the upgrade', async () => {
    const rec = recorder(u => u === embedUrl)
    const { c, states } = setup({ download: rec.deps })
    await c.start()
    await vi.waitFor(() => expect(rec.asked).toContain(embedUrl))
    expect(c.state.notesUpgradePending).toBe(true)
    expect(notesUpgradeActive(c.state)).toBe(true)
    expect(c.installed()?.llm).toBeTruthy()
    rec.release(); await c.idle()
    const first = states.findIndex(s => s.notesDownloading)
    const end = states.findIndex(s => s.notesUpgradeInstalled)
    expect(states.slice(first, end).every(notesDownloadVisible)).toBe(true)
    expect(notesDownloadVisible(c.state)).toBe(false)
  })

  it('plans a second download only on hardware that has a bigger model', async () => {
    const big = setup(), small = setup({ getHardware: async () => mac8 })
    for (const { c } of [big, small]) { await c.start(); await c.idle() }
    expect(big.states.find(s => s.notesDownloading)?.notesUpgradeBytes).toBeGreaterThan(14e9)
    expect(small.states.every(s => s.notesUpgradeBytes === undefined)).toBe(true)
    expect(small.rec.asked).not.toContain(bigUrl)
  })

  it('skips in the gap, persists across launches, and Settings can download it again once', async () => {
    const rec = recorder(u => u === embedUrl)
    const root = mkdtempSync(join(tmpdir(), 'yogurt-upgrade-'))
    const prefs = preference(root)
    const { c } = setup({ modelsDir: root, download: rec.deps, upgradePreference: prefs })
    await c.start()
    await vi.waitFor(() => expect(rec.asked).toContain(embedUrl))
    await c.skipUpgrade()
    rec.release(); await c.idle()
    expect(rec.asked).not.toContain(bigUrl)
    expect(prefs.load()).toBe(true)
    const next = setup({ modelsDir: root, upgradePreference: preference(root) })
    await next.c.start(); await next.c.idle()
    expect(next.rec.asked).not.toContain(bigUrl)
    expect(notesDownloadVisible(next.c.state)).toBe(false)
    next.c.downloadUpgrade(); next.c.downloadUpgrade()
    expect(notesDownloadVisible(next.c.state)).toBe(true)
    await next.c.idle()
    expect(next.rec.asked.filter(u => u === bigUrl)).toHaveLength(1)
    expect(next.c.state.notesUpgradeInstalled).toBe(true)
    expect(prefs.load()).toBe(false)
  })

  it('stops the active transfer before removing partial files and never retries it', async () => {
    const inner = fakeDownloadDeps({ stepMs: 0 })
    let attempts = 0, stopped = false
    const { c, root } = setup({ download: { ...inner, download: async (url, dir, file, progress, signal) => {
      if (url !== bigUrl) return inner.download(url, dir, file, progress, signal)
      attempts++
      writeFileSync(join(dir, file + '.part'), 'partial')
      progress({ fraction: .2, etaSec: 30 })
      await new Promise<void>((_, reject) => signal!.addEventListener('abort', () => {
        expect(existsSync(join(dir, file + '.part'))).toBe(true)
        stopped = true; reject(signal!.reason)
      }, { once: true }))
    } } })
    await c.start()
    await vi.waitFor(() => expect(c.state.notesUpgradeFraction).toBe(.2))
    await c.skipUpgrade(); await c.idle()
    expect(stopped).toBe(true)
    expect(attempts).toBe(1)
    for (const suffix of ['', '.ok', '.part']) expect(existsSync(join(root, 'llm', name(bigUrl) + suffix))).toBe(false)
    expect(c.state).toMatchObject({ notesUpgradeSkipped: true, notesUpgradeError: undefined })
    expect(notesDownloadVisible(c.state)).toBe(false)
    expect(c.installed()?.llm).toBeTruthy()
  })

  it('handles Skip during verification without installing or leaving the completed file', async () => {
    const inner = fakeDownloadDeps({ stepMs: 0 })
    let release!: () => void
    let verifying = false
    const held = new Promise<void>(resolve => { release = resolve })
    const { c, root } = setup({ download: { ...inner, hashFile: async path => {
      if (path.endsWith(name(bigUrl))) { verifying = true; await held }
      return 'FAKE'
    } } })
    await c.start()
    await vi.waitFor(() => expect(verifying).toBe(true))
    const skipped = c.skipUpgrade()
    await vi.waitFor(() => expect(c.state.notesUpgradeSkipped).toBe(true))
    expect(existsSync(join(root, 'llm', name(bigUrl)))).toBe(true)
    release(); await skipped; await c.idle()
    expect(c.installed()?.recommendedLlm).toBeUndefined()
    expect(existsSync(join(root, 'llm', name(bigUrl)))).toBe(false)
    expect(existsSync(join(root, 'llm', name(bigUrl) + '.ok'))).toBe(false)
  })

  it('keeps the small model through a failed bigger load and deletes it only after success', async () => {
    const rec = recorder(u => u === bigUrl)
    const { c, root } = setup({ download: rec.deps })
    const engine = new FakeEngine()
    const load = vi.spyOn(engine, 'load')
    const model = createNotesModel({ engine, modelPath: () => c.notesPath(), onLoaded: path => c.notesModelLoaded(path) })
    await c.start()
    await vi.waitFor(() => expect(rec.asked).toContain(bigUrl))
    const first = c.installed()!.llm!
    await model.llm()
    rec.release(); await c.idle()
    expect(model.loaded()).toBe(first)
    expect(existsSync(first)).toBe(true)
    load.mockRejectedValueOnce(new Error('not enough memory'))
    await expect(model.llm()).rejects.toThrow('not enough memory')
    expect(existsSync(first)).toBe(true)
    expect(existsSync(first + '.ok')).toBe(true)
    await model.llm()
    expect(model.loaded()).toBe(c.installed()?.recommendedLlm)
    expect(existsSync(first)).toBe(false)
    expect(existsSync(first + '.ok')).toBe(false)
    expect(c.installed()?.llm).toBeUndefined()
    const next = setup({ modelsDir: root })
    await next.c.start(); await next.c.idle()
    expect(next.rec.asked).not.toContain(starterUrl)
    expect(next.c.notesPath()).toBe(c.notesPath())
  })

  it.each([false, true])('publishes separate restore progress and clears it when the download fails: %s', async fail => {
    const inner = fakeDownloadDeps({ stepMs: 0 })
    let restoring = false, finish!: () => void
    const held = new Promise<void>(resolve => { finish = resolve })
    const { c, states } = setup({ download: { ...inner, download: async (url, dir, file, progress, signal) => {
      if (restoring && url === starterUrl) {
        progress({ fraction: .42, etaSec: 240 })
        await held
        if (fail) throw new DiskSpaceError(5)
      }
      return inner.download(url, dir, file, progress, signal)
    } } })
    await c.start(); await c.idle()
    const bigger = c.notesPath()!
    c.notesModelLoaded(bigger)
    restoring = true
    states.length = 0
    const retire = vi.fn(async (remove: () => void) => {
      expect(c.state.notesRestoreFraction).toBeUndefined()
      expect(c.state.notesRestoreTotalBytes).toBeUndefined()
      expect(c.state.notesRestoreEtaSec).toBeUndefined()
      remove()
    })
    const removed = c.removeUpgrade(retire)
    await vi.waitFor(() => expect(c.state.notesRestoreFraction).toBe(.42))
    const bytes = catalog.models.flatMap(m => m.builds).find(b => b.url === starterUrl)!.sizeGB * 1e9
    const initial = states.find(s => s.notesRestoreFraction === 0)
    expect(initial).toMatchObject({ notesRestoreTotalBytes: bytes })
    expect(initial?.notesRestoreEtaSec).toBeUndefined()
    expect(c.state).toMatchObject({ phase: 'ready', notesRestoreTotalBytes: bytes, notesRestoreEtaSec: 240, notesUpgradeChanging: true, notesUpgradeInstalled: true })
    expect(states.every(s => !s.notesDownloading && s.notesFraction === undefined && !notesDownloadVisible(s))).toBe(true)
    expect(c.notesPath()).toBe(bigger)
    expect(retire).not.toHaveBeenCalled()
    finish()
    if (fail) await expect(removed).rejects.toThrow(DiskSpaceError)
    else await removed
    expect(c.state.notesRestoreFraction).toBeUndefined()
    expect(c.state.notesRestoreTotalBytes).toBeUndefined()
    expect(c.state.notesRestoreEtaSec).toBeUndefined()
    expect(c.state.notesUpgradeChanging).toBeUndefined()
    expect(retire).toHaveBeenCalledTimes(fail ? 0 : 1)
    expect(existsSync(bigger)).toBe(fail)
    if (fail) expect(c.notesPath()).toBe(bigger)
  })

  it('does not publish restore progress when the smaller model is still on disk', async () => {
    const { c, states, rec } = setup()
    await c.start(); await c.idle()
    const first = c.installed()!.llm!
    const downloads = rec.asked.length
    states.length = 0
    await c.removeUpgrade(async remove => { remove() })
    expect(rec.asked).toHaveLength(downloads)
    expect(states.every(s => s.notesRestoreFraction === undefined && s.notesRestoreTotalBytes === undefined && s.notesRestoreEtaSec === undefined)).toBe(true)
    expect(c.notesPath()).toBe(first)
  })

  it('Settings removal restores the small model, waits for work and unload, then stays removed after restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yogurt-upgrade-'))
    const prefs = preference(root)
    const { c } = setup({ modelsDir: root, upgradePreference: prefs })
    const engine = new FakeEngine()
    const model = createNotesModel({ engine, modelPath: () => c.notesPath(), onLoaded: path => c.notesModelLoaded(path) })
    const queue = createQueue({ recording: () => false, smallMac: false, modelReady: () => !!c.notesPath() })
    await c.start(); await c.idle(); await model.llm()
    const bigger = c.notesPath()!
    let release!: () => void
    const working = queue.enqueue(() => new Promise<void>(resolve => { release = resolve }), 'enhance')
    let releaseUnload!: () => void
    vi.spyOn(engine, 'unload').mockImplementation(() => new Promise(resolve => { releaseUnload = resolve }))
    const removed = c.removeUpgrade(remove => queue.enqueue(async () => { await model.unload(); remove() }, 'enhance'))
    await vi.waitFor(() => expect(c.installed()?.llm).toBeTruthy())
    // A concurrent successful load must not clean up the fallback being restored for removal.
    c.notesModelLoaded(bigger)
    expect(existsSync(c.installed()!.llm!)).toBe(true)
    expect(existsSync(bigger)).toBe(true)
    release(); await working
    await vi.waitFor(() => expect(releaseUnload).toBeTypeOf('function'))
    expect(existsSync(bigger)).toBe(true)
    releaseUnload(); await removed
    expect(existsSync(bigger)).toBe(false)
    expect(c.notesPath()).toBe(c.installed()?.llm)
    await model.llm()
    expect(model.loaded()).toBe(c.installed()?.llm)
    expect(c.state.notesUpgradeInstalled).toBe(false)
    expect(prefs.load()).toBe(true)
    const next = setup({ modelsDir: root, upgradePreference: prefs })
    await next.c.start(); await next.c.idle()
    expect(next.rec.asked).not.toContain(bigUrl)
    expect(next.c.installed()?.llm).toBeTruthy()
  })

  it.each(['download', 'unload'])('keeps the bigger model if fallback %s fails', async failure => {
    const inner = fakeDownloadDeps({ stepMs: 0 })
    let block = false
    const { c } = setup({ download: { ...inner, download: async (url, ...rest) => {
      if (block && url === starterUrl) throw new DiskSpaceError(5)
      return inner.download(url, ...rest)
    } } })
    await c.start(); await c.idle()
    const engine = new FakeEngine()
    const model = createNotesModel({ engine, modelPath: () => c.notesPath(), onLoaded: path => c.notesModelLoaded(path) })
    await model.llm()
    vi.spyOn(engine, 'unload').mockRejectedValue(new Error('unload failed'))
    const bigger = c.notesPath()!
    block = failure === 'download'
    await expect(c.removeUpgrade(async remove => { await model.unload(); remove() })).rejects.toThrow()
    expect(c.notesPath()).toBe(bigger)
    expect(existsSync(bigger)).toBe(true)
    expect(c.state.notesUpgradeInstalled).toBe(true)
    expect(c.state.notesUpgradeChanging).toBeUndefined()
  })
})
