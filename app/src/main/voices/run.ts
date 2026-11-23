import { clusterVoices } from './cluster'

/**
 * Telling the voices of a recording apart, on its own audio: what each stretch of speech sounds like (NVIDIA TitaNet,
 * 1.5 s windows), then who is who (cluster.ts). The stretches are the transcript's own lines of the other side: they
 * are already cut where people pause, and a name goes on a line anyway. (A separate segmentation pass found the same
 * speakers at several times the cost: on a 57-minute call it ran at about the length of the call.)
 * Plain functions over the audio, so the utility process (worker.ts) and a check on a real meeting run the same steps.
 */

export const RATE = 16000
/** how often progress is told, in seconds of audio read (the note shows it as a bar) */
export const PROGRESS_S = 15
const WIN_S = 1.5, HOP_S = 0.75
/** a line shorter than this gives no voice to go by */
const MIN_SPAN_S = 0.5
/** lines this long or longer carry a clear enough voice to build the groups from (cluster.ts anchors) */
const ANCHOR_S = 2

export type Span = { startMs: number; endMs: number }
export type VoiceTurn = Span & { voice: number }
export type Engine = { embed(samples: Float32Array): Float32Array }

/** where the windows of a stretch start, in seconds */
function windowsOf(a: number, b: number): number[] {
  if (b - a <= WIN_S) return [a]
  const starts: number[] = []
  for (let t = a; t + WIN_S <= b + 1e-6; t += HOP_S) starts.push(t)
  if (b - (starts.at(-1)! + WIN_S) > 0.25) starts.push(b - WIN_S)
  return starts
}

/**
 * A voice for each stretch of speech, from a whole recording read piece by piece (16 kHz mono float32, on meeting
 * time). Stretches too short to hear a voice in get none.
 */
export async function voiceTurns(audio: AsyncIterable<Float32Array>, spans: Span[], engine: Engine, onProgress?: (seconds: number) => void, onGrouping?: () => void): Promise<{ turns: VoiceTurn[]; voices: number }> {
  const sorted = spans.filter(s => s.endMs - s.startMs >= MIN_SPAN_S * 1000).sort((a, b) => a.startMs - b.startMs)
  // every window to take, in time order: [span, start s, end s]
  const wanted = sorted.flatMap((s, i) => windowsOf(s.startMs / 1000, s.endMs / 1000).map(a => [i, a, Math.min(s.endMs / 1000, a + WIN_S)] as const))
  const windows: Array<{ span: number; emb: Float32Array }> = []

  // the audio kept: from where the next window starts; a window waits until the audio reaches its end
  let kept = new Float32Array(0), keptFrom = 0, next = 0, read = 0
  const take = (upTo: number) => {
    while (next < wanted.length && wanted[next][2] <= upTo) {
      const [span, a, b] = wanted[next++]
      const from = Math.max(0, Math.floor(a * RATE) - keptFrom), to = Math.floor(b * RATE) - keptFrom
      if (to > from) windows.push({ span, emb: engine.embed(kept.slice(from, to)) })
    }
    // what no window still needs is let go
    const need = next < wanted.length ? Math.floor(wanted[next][1] * RATE) : keptFrom + kept.length
    const drop = Math.min(kept.length, Math.max(0, need - keptFrom))
    if (drop) { kept = kept.slice(drop); keptFrom += drop }
  }
  let sinceProgress = 0
  for await (const part of audio) {
    const grown = new Float32Array(kept.length + part.length)
    grown.set(kept); grown.set(part, kept.length)
    kept = grown
    read += part.length / RATE
    take(read)
    if ((sinceProgress += part.length / RATE) >= PROGRESS_S) { sinceProgress = 0; onProgress?.(read) }
  }
  take(Infinity)
  onProgress?.(read)
  if (!windows.length) return { turns: [], voices: 0 }
  onGrouping?.()

  const anchors = windows.flatMap((w, i) => (sorted[w.span].endMs - sorted[w.span].startMs >= ANCHOR_S * 1000 ? [i] : []))
  const { count, labels } = clusterVoices(windows.map(w => w.emb), anchors)
  // each stretch takes the voice most of its windows have
  const votes = new Map<number, number[]>()
  windows.forEach((w, i) => { const v = votes.get(w.span) ?? new Array(count).fill(0); v[labels[i]]++; votes.set(w.span, v) })
  const turns: VoiceTurn[] = [...votes].map(([span, v]) => ({ ...sorted[span], voice: v.indexOf(Math.max(...v)) }))
  return { turns: turns.sort((a, b) => a.startMs - b.startMs), voices: count }
}
