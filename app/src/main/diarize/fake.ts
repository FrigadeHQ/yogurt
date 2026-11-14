import { writeWav } from './wav'
import type { Turn } from './rttm'

/**
 * Fake mode: no helpers, no nemo-speech, no onnx. A deterministic two-voice diarization from the fake
 * transcript (YOGURT_FAKE_VOICES=1 puts both fake lines on one voice), a silent wav for decode, and
 * vectors hashed from a voice key so a voice matches its own profile across meetings.
 *   YOGURT_FAKE_VOICE_SIM=none|ambiguous tunes the next meeting's match (match is the default).
 *   YOGURT_FAKE_DIARIZE_FAIL=1 makes the diarizer return no turns at all (a recorded no-op, as in production).
 */

/** the fake transcript's them lines (asr/fake.ts), padded so claims are long enough */
const TURNS: Turn[] = [
  { key: 'f1', startMs: 5000, endMs: 8900 },
  { key: 'f2', startMs: 13_000, endMs: 16_000 },
]

export function fakeTurns(): Turn[] {
  if (process.env.YOGURT_FAKE_DIARIZE_FAIL === '1') return []
  if (process.env.YOGURT_FAKE_VOICES === '1') return [{ key: 'f1', startMs: TURNS[0].startMs, endMs: TURNS[1].endMs }]
  return TURNS
}

export function fakeDecode(_helper: string, _input: string, out: string): Promise<void> {
  // 20 s of silence at 16 kHz: long enough for the fake turns
  writeWav(out, new Float32Array(16 * 20_000))
  return Promise.resolve()
}

/** deterministic, signed, so different keys are near-orthogonal (unit vectors of positive numbers all correlate) */
const hash = (s: string): Float32Array => {
  const v = new Float32Array(8)
  for (let i = 0; i < s.length; i++) {
    const h = (s.charCodeAt(i) * 2654435761) >>> 0
    v[i % 8] += ((h % 200) - 100) / 100
  }
  return v
}
const unit = (v: Float32Array): Float32Array => {
  let sum = 0
  for (const x of v) sum += x * x
  const n = Math.sqrt(sum) || 1
  return Float32Array.from(v, (x) => x / n)
}
export const fakeVector = (key: string): Float32Array => unit(hash(key))

/** similarity knob: the result's cosine against the voice's own vector is exactly the sim (1: itself;
 * 0.62: ambiguous band (0.6..0.72); 0.1: no match). A plain unit(sim*v + (1-sim)*decoy) blend renormalizes
 * upward (0.62 measured 0.80 — the norm shrinks when the decoy isn't collinear), so the decoy is first
 * orthogonalized against v and scaled by sqrt(1-sim²): cos = sim·1 + k·0, ‖out‖ = sim²+k² = 1. */
const SIM: Record<string, number | undefined> = { none: 0.1, ambiguous: 0.62 }
export function fakeVectorFor(key: string): Float32Array {
  const sim = SIM[process.env.YOGURT_FAKE_VOICE_SIM ?? ''] ?? 1
  const v = fakeVector(key)
  if (sim >= 1) return v
  const decoy = fakeVector('decoy'), k = Math.sqrt(1 - sim * sim), out = new Float32Array(v.length)
  let dot = 0, wsum = 0
  for (let i = 0; i < v.length; i++) dot += decoy[i] * v[i]
  for (let i = 0; i < v.length; i++) { out[i] = decoy[i] - dot * v[i]; wsum += out[i] * out[i] }
  const n = Math.sqrt(wsum)
  for (let i = 0; i < v.length; i++) out[i] = sim * v[i] + (n > 0 ? (k * out[i]) / n : 0)
  return out
}
