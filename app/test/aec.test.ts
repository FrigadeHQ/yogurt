import { beforeAll, describe, expect, it } from 'vitest'
import { createEchoCancel, FRAME, type Canceller } from '../src/main/asr/aec'
import { aec3, loadAec3 } from '../src/main/asr/aec3'
import { createPipeline } from '../src/main/asr/pipeline'
import type { Chunk } from '../src/main/asr/chunker'
import type { Track } from '../src/main/capture'

const RATE = 16000

/** a stand-in canceller: says which reference frame each mic frame was given, and takes away the reference */
function fakeCanceller() {
  const log: Array<{ ref: number; mic: number }> = []
  let lastRef = new Float32Array(FRAME)
  let freed = false
  const c: Canceller = {
    analyze: (ref) => { lastRef = ref.slice() },
    process: (mic, out) => { log.push({ ref: lastRef[0], mic: mic[0] }); for (let i = 0; i < FRAME; i++) out[i] = mic[i] - lastRef[i] },
    free: () => { freed = true },
  }
  return { c, log, freed: () => freed }
}

/** samples whose value is their meeting time in ms, so a frame says where it came from */
const timed = (ms: number, n: number) => Float32Array.from({ length: n }, (_, i) => ms + Math.floor(i / 16))

function rig(make: () => Canceller | null, maxWaitMs?: number) {
  const out: Array<{ track: Track; ms: number; samples: Float32Array }> = []
  const aec = createEchoCancel({ make, out: (track, ms, samples) => out.push({ track, ms, samples }), maxWaitMs })
  return { aec, out, mic: () => out.filter((o) => o.track === 'me'), them: () => out.filter((o) => o.track === 'them') }
}

describe('echo cancel: lining the tracks up', () => {
  it('passes their track on at once and holds the mic until their track has reached the same time', () => {
    const f = fakeCanceller()
    const r = rig(() => f.c)
    r.aec.push('them', 0, timed(0, 1600))
    expect(r.them()).toHaveLength(1)
    r.aec.push('me', 0, timed(0, 1600)); r.aec.push('me', 100, timed(100, 1600))
    expect(r.mic()).toHaveLength(1)
    r.aec.push('them', 100, timed(100, 1600))
    expect(r.mic()).toHaveLength(2)
    expect(r.mic()[1].ms).toBe(100)
    expect(r.mic()[1].samples).toHaveLength(1600)
  })

  it('lets the mic straight through while nothing of theirs has been heard (a mic-only recording)', () => {
    const f = fakeCanceller()
    const r = rig(() => f.c)
    r.aec.push('me', 0, timed(0, 1600))
    expect(r.mic()).toHaveLength(1)
    expect(f.log).toHaveLength(0)
  })

  it('gives each 10 ms mic frame the reference from the same meeting time', () => {
    const f = fakeCanceller()
    const r = rig(() => f.c)
    r.aec.push('them', 0, timed(0, 1600)); r.aec.push('them', 100, timed(100, 1600))
    r.aec.push('me', 0, timed(0, 1600)); r.aec.push('me', 100, timed(100, 1600))
    expect(f.log).toHaveLength(20)
    expect(f.log.every((x) => x.ref === x.mic)).toBe(true)
    // the stand-in takes the reference away: the same audio on both tracks comes out as silence
    expect(r.mic().every((o) => o.samples.every((v) => v === 0))).toBe(true)
  })

  it('reads the reference as silence where their track has a hole', () => {
    const f = fakeCanceller()
    const r = rig(() => f.c)
    r.aec.push('them', 0, timed(0, 1600)); r.aec.push('them', 300, timed(300, 1600))
    r.aec.push('me', 100, timed(100, 1600))
    expect(f.log.every((x) => x.ref === 0)).toBe(true)
    expect(r.mic()[0].samples[0]).toBe(100)
  })

  it('keeps only the last few seconds of their track when no mic comes', () => {
    const f = fakeCanceller()
    const r = rig(() => f.c)
    for (let ms = 0; ms < 10_000; ms += 100) r.aec.push('them', ms, timed(ms, 1600))
    r.aec.push('me', 9000, timed(9000, 1600))
    expect(f.log.every((x) => x.ref === x.mic)).toBe(true)
    r.aec.push('me', 0, timed(0, 1600))
    r.aec.flush()
    expect(f.log.slice(10).every((x) => x.ref === 0)).toBe(true)
  })

  it('lets the mic go on alone when their track stops coming', () => {
    const f = fakeCanceller()
    const r = rig(() => f.c, 1000)
    r.aec.push('them', -100, timed(-100, 1600))
    for (let ms = 0; ms <= 1500; ms += 100) r.aec.push('me', ms, timed(ms, 1600))
    // held no more than about a second behind the newest mic audio
    expect(r.mic().length).toBeGreaterThanOrEqual(5)
    expect(r.mic()[0].ms).toBe(0)
  })

  it('leaves the mic untouched, without running the canceller, once their side has been silent for a second', () => {
    const f = fakeCanceller()
    const r = rig(() => f.c)
    for (let ms = 0; ms < 3000; ms += 100) { r.aec.push('them', ms, new Float32Array(1600)); r.aec.push('me', ms, timed(ms, 1600)) }
    // the first second still goes through it (the room's echo dies away), the rest does not
    expect(f.log).toHaveLength(99)
    expect(r.mic().at(-1)!.samples).toEqual(timed(2900, 1600))
    r.aec.push('them', 3000, timed(3000, 1600)); r.aec.push('me', 3000, timed(3000, 1600))
    expect(f.log).toHaveLength(109)
  })

  it('keeps pieces that are not whole frames, and gives out what is left at the end', () => {
    const f = fakeCanceller()
    const r = rig(() => f.c)
    r.aec.push('them', 0, timed(0, 1000)); r.aec.push('me', 0, timed(0, 1000))
    r.aec.push('them', 62.5, timed(62.5, 1000)); r.aec.push('me', 62.5, timed(62.5, 1000))
    r.aec.flush()
    const n = r.mic().reduce((s, o) => s + o.samples.length, 0)
    expect(n).toBe(2000)
    // pieces come out in order and back to back
    let at = 0
    for (const o of r.mic()) { expect(o.ms).toBeCloseTo(at, 5); at += o.samples.length / 16 }
  })

  it('starts a fresh run after a pause in the mic', () => {
    const f = fakeCanceller()
    const r = rig(() => f.c)
    r.aec.push('them', 0, timed(0, 1000)); r.aec.push('me', 0, timed(0, 1000))
    r.aec.push('them', 5000, timed(5000, 1600)); r.aec.push('me', 5000, timed(5000, 1600))
    r.aec.flush()
    expect(r.mic().map((o) => o.ms)).toEqual([0, 960 / 16, 5000])
  })

  it('without a canceller the mic goes straight through, not held', () => {
    const r = rig(() => null)
    r.aec.push('me', 0, timed(0, 1600))
    expect(r.mic()).toHaveLength(1)
    expect(r.mic()[0].samples).toEqual(timed(0, 1600))
  })

  it('without a canceller yet, the mic goes through until one is there', () => {
    const f = fakeCanceller()
    let ready = false
    const r = rig(() => (ready ? f.c : null))
    r.aec.push('me', 0, timed(0, 1600))
    expect(r.mic()).toHaveLength(1)
    ready = true
    r.aec.push('them', 100, timed(100, 1600))
    r.aec.push('me', 100, timed(100, 1600))
    expect(r.mic()).toHaveLength(2)
    expect(f.log).toHaveLength(10)
  })

  it('frees the canceller when it closes', () => {
    const f = fakeCanceller()
    const r = rig(() => f.c)
    r.aec.push('them', 0, timed(0, 1600)); r.aec.push('me', 0, timed(0, 1600))
    r.aec.close()
    expect(f.freed()).toBe(true)
  })
})

/** a voice-like noise: bursts of syllables */
function talk(sec: number, seed: number, gain: number) {
  let s = seed
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1
  return Float32Array.from({ length: sec * RATE }, (_, i) => gain * rnd() * Math.max(0, Math.sin((2 * Math.PI * 3 * i) / RATE)))
}
const db = (x: Float32Array, from: number, to: number) => { let e = 0; for (let i = from * RATE; i < to * RATE; i++) e += x[i] * x[i]; return 10 * Math.log10(e / ((to - from) * RATE) + 1e-12) }

describe('echo cancel: WebRTC AEC3', () => {
  beforeAll(async () => { await loadAec3() })

  it('loads', () => { expect(aec3()).not.toBeNull() })

  it('takes their voice off the mic by at least 20 dB and keeps the person speaking', () => {
    const SEC = 24
    const ref = talk(SEC, 7, 0.3)
    // the person: alone from 14 s to 17 s (their side quiet), and over them from 19 s to 22 s
    const near = new Float32Array(SEC * RATE)
    const voice = talk(3, 99, 0.08)
    near.set(voice, 14 * RATE); near.set(voice, 19 * RATE)
    for (let i = 14 * RATE; i < 17 * RATE; i++) ref[i] = 0
    // the room: 60 ms late, duller and quieter, plus a second, weaker path
    const mic = new Float32Array(SEC * RATE)
    let lp = 0
    for (let i = 0; i < mic.length; i++) {
      const x = i >= 960 ? ref[i - 960] : 0
      lp = 0.7 * lp + 0.3 * x
      mic[i] = 0.4 * lp + (i >= 1500 ? 0.1 * ref[i - 1500] : 0) + near[i]
    }
    const got = new Float32Array(mic.length)
    let at = 0
    const aec = createEchoCancel({ make: aec3, out: (track, ms, samples) => { if (track === 'me') { got.set(samples, at); at += samples.length } } })
    for (let i = 0; i < mic.length; i += 1600) { aec.push('them', i / 16, ref.subarray(i, i + 1600)); aec.push('me', i / 16, mic.subarray(i, i + 1600)) }
    aec.flush(); aec.close()
    expect(at).toBe(mic.length)
    // once it has learned the room (a few seconds), their voice alone is 20 dB quieter
    expect(db(mic, 6, 13) - db(got, 6, 13)).toBeGreaterThanOrEqual(20)
    // the person alone is untouched, and over them comes through nearly at full level
    expect(Math.abs(db(got, 14, 17) - db(near, 14, 17))).toBeLessThan(1.5)
    expect(Math.abs(db(got, 19, 22) - db(near, 19, 22))).toBeLessThan(3)
  })
})

describe('echo cancel in the pipeline', () => {
  it('transcribes the cancelled mic, their track as it is, and gives out held mic audio when the meeting ends', async () => {
    const heard: Chunk[] = []
    // a canceller that turns the mic to a quiet copy of itself
    const halve: Canceller = { analyze: () => {}, process: (mic, out) => { for (let i = 0; i < FRAME; i++) out[i] = mic[i] / 2 }, free: () => {} }
    const p = createPipeline({ meetingId: 'm1', holdMs: 10, transcribe: async (c) => { heard.push(c); return [] }, save: () => {}, emit: () => {}, cancelEcho: () => halve })
    const tone = Float32Array.from({ length: RATE }, (_, i) => 0.3 * Math.sin(i / 10))
    const all = Float32Array.from([...tone, ...new Float32Array(RATE * 1.5)])
    for (let i = 0; i < all.length; i += 1600) { p.push('them', i / 16, all.subarray(i, i + 1600)); p.push('me', i / 16, all.subarray(i, i + 1600)) }
    // the mic's last piece is held until their track catches up; the end of the meeting lets it go
    p.push('me', all.length / 16, tone.subarray(0, 1600))
    await p.finish()
    const peak = (t: Track) => Math.max(...heard.filter((c) => c.track === t).flatMap((c) => [...c.samples]))
    expect(peak('them')).toBeCloseTo(0.3, 2)
    expect(peak('me')).toBeCloseTo(0.15, 2)
  })
})
