import { closeSync, existsSync, openSync, renameSync, rmSync, writeSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The mic without the other side's echo, for listening back (#166). Without headphones the mic hears them from the
 * speakers, and the player plays both tracks at once, so their voice came out twice, a little apart. The echo canceller
 * already cleans the mic's 16 kHz copy for whisper (aec.ts); that copy is written here too, on meeting time, and kept
 * only for a meeting where echo was heard. The recording itself stays as it was: transcribing again, AI apps and backups
 * read it, and deleting this file brings the player back to it.
 *
 * 16-bit WAV, because every player plays it (Chromium, the iPhone, any app): 1.9 MB a minute, only for meetings with echo.
 */
export const CLEAN_MIC = 'me-clean.wav'
const RATE = 16000
/** a recording that starts later than this continues an earlier one: its copy would be silent where the mic was not */
const WHOLE_FROM_MS = 1000
/** a jump forward past this is not a pause: nothing is written rather than hours of silence */
const MAX_GAP_MS = 4 * 3600_000
const FLUSH = RATE

export function wavHeader(samples: number, rate = RATE): Buffer {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(36 + samples * 2, 4); h.write('WAVEfmt ', 8, 'ascii')
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36, 'ascii'); h.writeUInt32LE(samples * 2, 40)
  return h
}

export type CleanMicEnd = {
  /** echo was heard in this meeting */
  echo: boolean
  /** where the meeting's audio, either track, started and ended */
  firstMs: number
  endMs: number
  /** the reading stopped partway (a saved recording): what was there stays */
  failed?: boolean
}

/** One meeting's copy, written as it comes to `<file>.part` and put in place (or thrown away) at the end */
export function createCleanMic(dir: string) {
  const file = join(dir, CLEAN_MIC), part = `${file}.part`
  let fd: number | null = null
  let written = 0
  let broken = false
  let buf = Buffer.alloc(FLUSH * 2), used = 0

  const flush = () => {
    if (fd === null || !used) return
    writeSync(fd, buf, 0, used)
    used = 0
  }
  const put = (x: number) => {
    const v = Math.max(-1, Math.min(1, x))
    buf.writeInt16LE(Math.round(v * 32767), used)
    used += 2
    written++
    if (used === buf.length) flush()
  }
  const padTo = (ms: number) => {
    const to = Math.round(ms * 16)
    while (written < to) put(0)
  }
  const guard = (f: () => void) => {
    if (broken) return
    try { f() } catch (e) { broken = true; console.error('writing the mic without echo failed: the player keeps the recording as it is', e) }
  }

  return {
    push(ms: number, samples: Float32Array) {
      guard(() => {
        if (fd === null) { fd = openSync(part, 'w'); writeSync(fd, wavHeader(0)) }
        if (ms - written / 16 > MAX_GAP_MS) throw new Error(`a jump of ${Math.round(ms - written / 16)} ms`)
        padTo(ms)
        const skip = Math.max(0, written - Math.round(ms * 16))
        for (let i = skip; i < samples.length; i++) put(samples[i])
      })
    },
    finish(end: CleanMicEnd) {
      const keep = !end.failed && end.echo && end.firstMs < WHOLE_FROM_MS && !broken && fd !== null
      guard(() => {
        if (keep) { padTo(end.endMs); flush(); writeSync(fd!, wavHeader(written), 0, 44, 0) }
      })
      try { if (fd !== null) closeSync(fd) } catch { /* closed */ }
      fd = null
      buf = Buffer.alloc(0)
      try {
        if (keep && !broken) { renameSync(part, file); return }
        rmSync(part, { force: true })
        // the recording changed (continued) or had no echo after all: an older copy would not match it
        if (!end.failed && existsSync(file)) rmSync(file, { force: true })
      } catch (e) { console.error('putting the mic without echo in place failed', e) }
    },
  }
}
export type CleanMic = ReturnType<typeof createCleanMic>
