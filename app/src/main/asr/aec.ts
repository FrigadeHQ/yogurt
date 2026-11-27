import type { Track } from '../capture'

/**
 * Without headphones the mic hears the other side from the speakers. Their voice is on the computer's own track too,
 * clean, so an echo canceller (asr/aec3.ts) can take it off the mic before whisper reads it: it learns how the room
 * changes their voice on the way to the mic (late, duller, quieter) and takes that copy away, frame by frame, leaving
 * the person's own voice. echo.ts's word check stays behind it for what gets through.
 *
 * This lines the two tracks up on meeting time: their audio goes on at once and is kept as the reference; the mic waits
 * until their track has reached the same time, then each 10 ms mic frame goes in with their frame from the same moment
 * (the canceller finds the room's own delay itself). The saved files stay as recorded; the cancelled mic is also kept
 * beside them for listening back where the meeting had echo (cleanMic.ts).
 */
export const FRAME = 160
const FRAME_MS = 10

/** One echo canceller for one meeting: 10 ms frames at 16 kHz (FRAME samples) */
export interface Canceller {
  /** what the speakers played (their track) */
  analyze(ref: Float32Array): void
  /** the mic's frame with the echo taken out, into out */
  process(mic: Float32Array, out: Float32Array): void
  free(): void
}

/** the mic is held at most this far behind its newest audio for their track to arrive; past it their track is taken as silent */
const MAX_WAIT_MS = 1500
/** their audio is kept this long behind its newest, for a mic that arrives late (with no mic at all it would pile up) */
const KEEP_REF_MS = 5000
/**
 * Their side silent this long (under -70 dB, a call's digital silence): no echo is left in the room, so the mic goes
 * through untouched and the canceller is not run, which saves its work while only the person talks
 */
const SILENT_FRAMES = 100
const SILENT = 1e-7
/**
 * AEC3 finds the room's delay itself, but only out to about half a second. With the mic track a steady way behind
 * theirs (asr/echoDetect.ts offsetMs, #181), their audio is held back by the offset less this much, so what is left for
 * AEC3 to find is short and their audio still arrives before its copy on the mic. Changed only by a real move: AEC3
 * starts its search again each time.
 */
const LEAD_MS = 100
/** as far as the echo detector looks */
const MAX_DELAY_MS = 2000
const MOVE_MS = 50
/** a mic piece starting this far from where the last ended is a new run (a pause, a restart) */
const GAP_MS = 1

export function createEchoCancel(p: {
  /** a canceller, or null while there is none (not loaded): the mic then goes through as it is */
  make: () => Canceller | null
  out: (track: Track, ms: number, samples: Float32Array) => void
  maxWaitMs?: number
  /** how far the mic track sits behind theirs, once the echo detector knows (past the room's own lags) */
  offsetMs?: () => number | undefined
}) {
  const maxWait = p.maxWaitMs ?? MAX_WAIT_MS
  let canceller: Canceller | null = null
  /** closed: anything later goes through as it is */
  let closed = false
  /** their audio not yet used as reference, on meeting time */
  let ref: Array<{ ms: number; samples: Float32Array }> = []
  let themEnd = -Infinity
  /** mic audio waiting: one run, back to back from ms */
  let mic: { ms: number; samples: Float32Array } | null = null
  /** their frames in a row that were silent */
  let silentFor = 0
  /** their audio is taken from this much before the mic's moment */
  let refDelay = 0
  const updateDelay = () => {
    const o = p.offsetMs?.()
    const want = o ? Math.max(0, Math.round((o - LEAD_MS) / FRAME_MS) * FRAME_MS) : 0
    if (Math.abs(want - refDelay) >= MOVE_MS || (want === 0) !== (refDelay === 0)) refDelay = want
  }
  const refFrame = new Float32Array(FRAME)
  const outFrame = new Float32Array(FRAME)

  /** their audio over [ms, ms + 10 ms); silence where there is none */
  const fillRef = (ms: number) => {
    refFrame.fill(0)
    for (const r of ref) {
      const rEnd = r.ms + r.samples.length / 16
      if (rEnd <= ms || r.ms >= ms + FRAME_MS) continue
      const from = Math.round((ms - r.ms) * 16)
      for (let i = Math.max(0, -from); i < FRAME && from + i < r.samples.length; i++) refFrame[i] = r.samples[from + i]
    }
  }

  /** the waiting mic's whole frames up to meeting time `until` go through the canceller; the rest waits (all, when final) */
  const run = (until: number, final = false) => {
    if (!mic) return
    if (!canceller && !closed) canceller = p.make()
    updateDelay()
    const frames = Math.max(0, Math.floor(Math.min(mic.samples.length / FRAME, (until - mic.ms) / FRAME_MS)))
    const n = frames * FRAME
    if (n) {
      const done = new Float32Array(n)
      if (canceller) {
        for (let f = 0; f < frames; f++) {
          const frame = mic.samples.subarray(f * FRAME, (f + 1) * FRAME)
          fillRef(mic.ms + f * FRAME_MS - refDelay)
          let e = 0
          for (let i = 0; i < FRAME; i++) e += refFrame[i] * refFrame[i]
          silentFor = e / FRAME < SILENT ? silentFor + 1 : 0
          if (silentFor >= SILENT_FRAMES) { done.set(frame, f * FRAME); continue }
          canceller.analyze(refFrame)
          canceller.process(frame, outFrame)
          done.set(outFrame, f * FRAME)
        }
      } else done.set(mic.samples.subarray(0, n))
      p.out('me', mic.ms, done)
      mic = { ms: mic.ms + frames * FRAME_MS, samples: mic.samples.subarray(n) }
      // their audio from before the mic's position, less the furthest the tracks can sit apart, is not needed again
      ref = ref.filter((r) => r.ms + r.samples.length / 16 > mic!.ms - Math.max(refDelay, MAX_DELAY_MS))
    }
    if (final && mic.samples.length) { p.out('me', mic.ms, mic.samples.slice()); mic = null }
    if (mic && !mic.samples.length) mic = null
  }

  const drain = () => {
    if (!mic) return
    const micEnd = mic.ms + mic.samples.length / 16
    run(Math.max(themEnd, micEnd - maxWait))
  }

  return {
    push(track: Track, ms: number, samples: Float32Array) {
      if (!samples.length) return
      if (track === 'them') {
        p.out('them', ms, samples)
        ref.push({ ms, samples })
        themEnd = Math.max(themEnd, ms + samples.length / 16)
        while (ref.length && ref[0].ms + ref[0].samples.length / 16 < themEnd - KEEP_REF_MS) ref.shift()
        drain()
        return
      }
      // nothing of theirs heard yet (a mic-only recording, or the first moment), or no canceller (yet): nothing to wait for
      if (!canceller && !closed && themEnd > -Infinity) canceller = p.make()
      if (!canceller) { if (mic) run(Infinity, true); p.out('me', ms, samples); return }
      if (mic && Math.abs(ms - (mic.ms + mic.samples.length / 16)) > GAP_MS) run(Infinity, true)
      if (!mic) mic = { ms, samples: samples.slice() }
      else { const all = new Float32Array(mic.samples.length + samples.length); all.set(mic.samples); all.set(samples, mic.samples.length); mic = { ms: mic.ms, samples: all } }
      drain()
    },
    /** the meeting is over: all the mic audio waiting goes through now */
    flush() { run(Infinity, true) },
    close() { this.flush(); closed = true; canceller?.free(); canceller = null; ref = [] },
  }
}
export type EchoCancel = ReturnType<typeof createEchoCancel>
