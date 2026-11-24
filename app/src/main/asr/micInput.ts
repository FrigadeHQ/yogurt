import type { Chunk } from './chunker'

/** Confirmed silent intervals on the capture clock. The helper stops sending mic PCM while muted. */
export class MicInput {
  private mutes: { start: number; end: number }[] = []
  private sentUntil = 0
  private wallStart = 0

  boundary(muted: boolean, ms: number, silence: (ms: number, samples: Float32Array) => void) {
    const last = this.mutes.at(-1)
    if (last?.end === Infinity) {
      if (muted) return
      this.advance(ms, silence)
      last.end = ms
    } else if (muted) {
      this.mutes.push({ start: ms, end: Infinity })
      this.sentUntil = ms
      this.wallStart = performance.now()
    }
  }

  tick(silence: (ms: number, samples: Float32Array) => void) {
    const last = this.mutes.at(-1)
    if (last?.end === Infinity) this.advance(last.start + Math.floor(performance.now() - this.wallStart), silence)
  }

  private advance(ms: number, silence: (ms: number, samples: Float32Array) => void) {
    // One second of quiet ends the utterance, plus the echo canceller's reference wait and a chunker window.
    const until = Math.min(ms, this.mutes.at(-1)!.start + 3000)
    const count = Math.floor((until - this.sentUntil) * 16)
    if (count <= 0) return
    silence(this.sentUntil, new Float32Array(count))
    this.sentUntil += count / 16
  }

  /** A rapid unmute can fall within one speech chunk. Whisper reads each audible stretch on its original clock. */
  audible(chunk: Chunk): Chunk[] {
    if ((this.mutes.at(-1)?.end ?? -Infinity) <= chunk.startMs) return [chunk]
    const end = chunk.startMs + chunk.samples.length / 16
    let from = chunk.startMs
    const pieces: Chunk[] = []
    const add = (a: number, b: number) => {
      if (b <= a) return
      const samples = chunk.samples.subarray(Math.round((a - chunk.startMs) * 16), Math.round((b - chunk.startMs) * 16))
      const clearMs = chunk.clearMs === undefined ? undefined : Math.min(b - a, chunk.clearMs)
      pieces.push({ ...chunk, startMs: a, samples, clearMs })
    }
    for (const mute of this.mutes) {
      if (mute.end <= from) continue
      if (mute.start >= end) break
      add(from, mute.start)
      from = Math.max(from, mute.end)
    }
    if (from === chunk.startMs && !pieces.length) return [chunk]
    add(from, end)
    return pieces
  }
}
