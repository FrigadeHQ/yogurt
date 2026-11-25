import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLEAN_MIC, createCleanMic, wavHeader } from '../src/main/asr/cleanMic'
import { createPipeline } from '../src/main/asr/pipeline'
import { FRAME, type Canceller } from '../src/main/asr/aec'

const RATE = 16000
const dirs: string[] = []
afterEach(() => { dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })) })
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'yogurt-clean-')); dirs.push(d); return d }
const tone = (n: number, level = 0.5) => Float32Array.from({ length: n }, (_, i) => level * Math.sin(i / 7))
/** the samples of a 16-bit mono WAV, as -1..1 */
function samplesOf(file: string): number[] {
  const b = readFileSync(file)
  const n = b.readUInt32LE(40) / 2
  return Array.from({ length: n }, (_, i) => b.readInt16LE(44 + i * 2) / 32767)
}

describe('wavHeader', () => {
  it('describes 16 kHz mono 16-bit audio of the given length', () => {
    const h = wavHeader(1000)
    expect(h.length).toBe(44)
    expect(h.toString('ascii', 0, 4)).toBe('RIFF')
    expect(h.readUInt32LE(4)).toBe(36 + 2000)
    expect(h.toString('ascii', 8, 16)).toBe('WAVEfmt ')
    expect(h.readUInt16LE(20)).toBe(1)
    expect(h.readUInt16LE(22)).toBe(1)
    expect(h.readUInt32LE(24)).toBe(RATE)
    expect(h.readUInt32LE(28)).toBe(RATE * 2)
    expect(h.readUInt16LE(34)).toBe(16)
    expect(h.toString('ascii', 36, 40)).toBe('data')
    expect(h.readUInt32LE(40)).toBe(2000)
  })
})

describe('the cleaned mic copy', () => {
  it('is kept for a meeting with echo, on meeting time: gaps are silence, overlaps are not written twice, the end reaches their track', () => {
    const dir = temp(), c = createCleanMic(dir)
    c.push(0, tone(1600))
    // a pause: 100 ms of nothing, then a piece that starts 5 ms before the last one ended
    c.push(200, tone(1600, 0.25))
    c.push(295, tone(1600, 0.1))
    c.finish({ echo: true, firstMs: 0, endMs: 500 })
    expect(readdirSync(dir)).toEqual([CLEAN_MIC])
    const s = samplesOf(join(dir, CLEAN_MIC))
    expect(s.length).toBe(500 * 16)
    expect(s[100]).toBeCloseTo(0.5 * Math.sin(100 / 7), 3)
    expect(s.slice(1600, 3200).every((x) => x === 0)).toBe(true)
    expect(s[3200 + 100]).toBeCloseTo(0.25 * Math.sin(100 / 7), 3)
    // the overlapping 5 ms (80 samples) of the third piece are dropped
    expect(s[4800]).toBeCloseTo(0.1 * Math.sin(80 / 7), 3)
    expect(s.slice(6320).every((x) => x === 0)).toBe(true)
  })

  it('clips instead of wrapping around', () => {
    const dir = temp(), c = createCleanMic(dir)
    c.push(0, Float32Array.from([2, -2, 0.5]))
    c.finish({ echo: true, firstMs: 0, endMs: 0 })
    const s = samplesOf(join(dir, CLEAN_MIC))
    expect(s[0]).toBeCloseTo(1, 3)
    expect(s[1]).toBeCloseTo(-1, 3)
  })

  it('is not kept when there was no echo (headphones), and an older copy goes', () => {
    const dir = temp()
    writeFileSync(join(dir, CLEAN_MIC), 'old')
    const c = createCleanMic(dir)
    c.push(0, tone(1600))
    c.finish({ echo: false, firstMs: 0, endMs: 100 })
    expect(readdirSync(dir)).toEqual([])
  })

  it('is not kept for a recording that continues an earlier one: the old copy no longer matches the mic', () => {
    const dir = temp()
    writeFileSync(join(dir, CLEAN_MIC), 'old')
    const c = createCleanMic(dir)
    c.push(60_000, tone(1600))
    c.finish({ echo: true, firstMs: 60_000, endMs: 60_100 })
    expect(readdirSync(dir)).toEqual([])
  })

  it('leaves the copy it had when a reading of the saved recording stops partway', () => {
    const dir = temp()
    writeFileSync(join(dir, CLEAN_MIC), 'old')
    const c = createCleanMic(dir)
    c.push(0, tone(1600))
    c.finish({ echo: true, firstMs: 0, endMs: 100, failed: true })
    expect(readdirSync(dir)).toEqual([CLEAN_MIC])
    expect(readFileSync(join(dir, CLEAN_MIC), 'utf8')).toBe('old')
  })

  it('writes nothing for a meeting without a mic', () => {
    const dir = temp(), c = createCleanMic(dir)
    c.finish({ echo: true, firstMs: 0, endMs: 100 })
    expect(existsSync(join(dir, CLEAN_MIC))).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })
})

describe('the pipeline gives out the cleaned mic', () => {
  it('passes the mic after the echo canceller, and says the span of audio it got', async () => {
    const halve: Canceller = { analyze: () => {}, process: (mic, out) => { for (let i = 0; i < FRAME; i++) out[i] = mic[i] / 2 }, free: () => {} }
    const got: Array<{ ms: number; samples: Float32Array }> = []
    const p = createPipeline({ meetingId: 'm1', holdMs: 10, transcribe: async () => [], save: () => {}, emit: () => {}, cancelEcho: () => halve,
      cleanMic: (ms, samples) => got.push({ ms, samples: samples.slice() }) })
    const x = tone(RATE)
    for (let i = 0; i < x.length; i += 1600) { p.push('them', 40 + i / 16, x.subarray(i, i + 1600)); p.push('me', 40 + i / 16, x.subarray(i, i + 1600)) }
    await p.finish()
    expect(got[0].ms).toBe(40)
    const all = got.flatMap((g) => [...g.samples])
    expect(all.length).toBe(RATE)
    expect(Math.max(...all)).toBeCloseTo(0.25, 2)
    expect(p.span()).toEqual({ firstMs: 40, endMs: 1040 })
  })
})
