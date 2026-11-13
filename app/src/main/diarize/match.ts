/** profile naming only fills clusters that are still Speaker N, and only when the match is sure */
export const AUTO_NAME_MIN = 0.72
export const AMBIGUOUS_MIN = 0.6
export const BEST_MARGIN = 0.08

export type ProfileVec = { id: string; name: string; centroid: Float32Array; meetings: number }
export type Match = { id: string; score: number } | { id: null; score: number } | null

export function normalize(v: Float32Array): Float32Array {
  let sum = 0
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i]
  const n = Math.sqrt(sum) || 1
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n
  return out
}

/** both inputs are unit vectors (centroids are stored normalized; embeddings are normalized before use) */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) dot += a[i] * b[i]
  return dot
}

/** the stored voiceprint drifts toward what was heard: 0.7 old + 0.3 fresh, renormalized */
export function blend(oldV: Float32Array, fresh: Float32Array): Float32Array {
  const out = new Float32Array(Math.max(oldV.length, freshVLength(fresh)))
  for (let i = 0; i < out.length; i++) out[i] = 0.7 * (oldV[i] ?? 0) + 0.3 * (fresh[i] ?? 0)
  return normalize(out)
}
const freshVLength = (v: Float32Array) => v.length

export function bestMatch(vec: Float32Array, profiles: readonly ProfileVec[]): Match {
  const scored = profiles.map(p => ({ id: p.id, score: cosine(vec, normalize(p.centroid)) })).sort((a, b) => b.score - a.score)
  const top = scored[0]
  if (!top || top.score < AMBIGUOUS_MIN) return null
  const margin = top.score - (scored[1]?.score ?? -1)
  if (top.score >= AUTO_NAME_MIN && margin >= BEST_MARGIN) return { id: top.id, score: top.score }
  return { id: null, score: top.score }
}
