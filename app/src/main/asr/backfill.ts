import { spawn } from 'node:child_process'
import type { Track } from '../capture'
import { readWav } from '../fakeCapture'

/**
 * A meeting recorded before the speech model was in keeps its audio; once the model arrives the saved recording is
 * transcribed (#30). The recorder decodes its own file to 16 kHz mono, and the audio goes through the same pipeline as
 * a live meeting: 100 ms pieces on meeting time (the files are on meeting time), both tracks side by side so the echo
 * check lines them up, never faster than whisper keeps up (the pipeline drops what waits past its limit).
 */
const PIECE = 1600
const MAX_BACKLOG_MS = 60_000

/** 100 ms pieces of a 16 kHz stream that comes in pieces of any size */
async function* pieces(src: AsyncIterable<Float32Array>): AsyncGenerator<Float32Array> {
  let rest = new Float32Array(0)
  for await (const x of src) {
    const all = new Float32Array(rest.length + x.length)
    all.set(rest); all.set(x, rest.length)
    let i = 0
    for (; i + PIECE <= all.length; i += PIECE) yield all.slice(i, i + PIECE)
    rest = all.slice(i)
  }
  if (rest.length) yield rest
}

/** Feeds the tracks to the pipeline; resolves with the ms of meeting time fed (the longer track) */
export async function feedRecording(p: {
  fromMs?: Partial<Record<Track, number>>
  tracks: Partial<Record<Track, AsyncIterable<Float32Array>>>
  push: (track: Track, ms: number, samples: Float32Array) => void
  backlogMs: () => number
  maxBacklogMs?: number
  wait?: (ms: number) => Promise<void>
  /** a recording started: the rest waits for the next time */
  stopped?: () => boolean
}): Promise<number> {
  const max = p.maxBacklogMs ?? MAX_BACKLOG_MS
  const wait = p.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const feeds = (Object.entries(p.tracks) as Array<[Track, AsyncIterable<Float32Array>]>).map(([track, src]) => ({ track, it: pieces(src), ms: 0, done: false }))
  while (feeds.some((f) => !f.done)) {
    if (p.stopped?.()) break
    // the track that is furthest behind goes next
    const f = feeds.filter((x) => !x.done).reduce((a, b) => (b.ms < a.ms ? b : a))
    const r = await f.it.next()
    if (r.done) { f.done = true; continue }
    while (p.backlogMs() > max && !p.stopped?.()) await wait(250)
    if (p.stopped?.()) break
    const skip = Math.min(r.value.length, Math.max(0, Math.ceil(((p.fromMs?.[f.track] ?? 0) - f.ms) * 16)))
    if (skip < r.value.length) p.push(f.track, f.ms + skip / 16, r.value.subarray(skip))
    f.ms += r.value.length / 16
  }
  for (const f of feeds) await f.it.return(undefined)
  return Math.max(0, ...feeds.map((f) => f.ms))
}

/** The recorder's own decoder (decode FILE): 16 kHz mono float32 on its stdout */
export async function* helperDecode(binary: string, file: string): AsyncGenerator<Float32Array> {
  const child = spawn(binary, ['decode', file], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let err = ''
  child.stderr.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-500) })
  const closed = new Promise<number | null>((r) => child.on('close', (code) => r(code)))
  let rest: Buffer = Buffer.alloc(0)
  let finished = false
  try {
    for await (const d of child.stdout as AsyncIterable<Buffer>) {
      const b = rest.length ? Buffer.concat([rest, d]) : d
      const n = b.length - (b.length % 4)
      // copied into its own buffer: a Float32Array needs 4-byte alignment
      if (n) yield new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + n))
      rest = b.subarray(n)
    }
    const code = await closed
    finished = true
    if (code !== 0) throw new Error(`decoding ${file} failed (${code}): ${err.trim()}`)
  } finally { if (!finished) child.kill() }
}

/** Fake mode records wav: read as it is */
export async function* wavDecode(file: string): AsyncGenerator<Float32Array> { yield readWav(file) }
