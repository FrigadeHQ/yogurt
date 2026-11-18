// Shared helpers for the diarization spike: read RTTM, score DER, small maths.
import { readFileSync } from 'node:fs'

/** RTTM lines -> [{ start, end, spk }] in seconds */
export function readRttm(path) {
  return readFileSync(path, 'utf8').trim().split('\n').map((l) => {
    const f = l.split(/\s+/)
    return { start: Number(f[3]), end: Number(f[3]) + Number(f[4]), spk: f[7] }
  })
}

/**
 * Frame-based DER (10 ms frames, no collar, overlap scored, like pyannote's "full" setting).
 * Hypothesis labels are mapped to reference speakers one-to-one by greedy largest overlap
 * (close to the optimal Hungarian mapping for a handful of speakers; good enough for a spike).
 */
export function der(ref, hyp, { collar = 0 } = {}) {
  const step = 0.01
  const end = Math.max(...ref.map((r) => r.end), ...hyp.map((h) => h.end))
  const n = Math.ceil(end / step)
  const refSpk = [...new Set(ref.map((r) => r.spk))]
  const hypSpk = [...new Set(hyp.map((h) => h.spk))]
  const R = refSpk.map(() => new Uint8Array(n))
  const H = hypSpk.map(() => new Uint8Array(n))
  const skip = new Uint8Array(n)
  for (const r of ref) {
    const a = Math.round(r.start / step), b = Math.round(r.end / step)
    for (let i = a; i < b && i < n; i++) R[refSpk.indexOf(r.spk)][i] = 1
    if (collar > 0) for (const t of [a, b]) for (let i = Math.max(0, t - Math.round(collar / step)); i < Math.min(n, t + Math.round(collar / step)); i++) skip[i] = 1
  }
  for (const h of hyp) {
    const a = Math.round(h.start / step), b = Math.round(h.end / step)
    for (let i = a; i < b && i < n; i++) H[hypSpk.indexOf(h.spk)][i] = 1
  }
  // overlap matrix and greedy mapping
  const pairs = []
  for (let i = 0; i < refSpk.length; i++) for (let j = 0; j < hypSpk.length; j++) {
    let o = 0
    for (let k = 0; k < n; k++) if (!skip[k] && R[i][k] && H[j][k]) o++
    pairs.push([o, i, j])
  }
  pairs.sort((x, y) => y[0] - x[0])
  const mapH = new Map(), usedR = new Set()
  for (const [, i, j] of pairs) if (!mapH.has(j) && !usedR.has(i)) { mapH.set(j, i); usedR.add(i) }
  let total = 0, miss = 0, fa = 0, conf = 0
  for (let k = 0; k < n; k++) {
    if (skip[k]) continue
    const nr = R.reduce((s, r) => s + r[k], 0), nh = H.reduce((s, h) => s + h[k], 0)
    let correct = 0
    for (let j = 0; j < hypSpk.length; j++) if (H[j][k] && mapH.has(j) && R[mapH.get(j)][k]) correct++
    total += nr
    miss += Math.max(0, nr - nh)
    fa += Math.max(0, nh - nr)
    conf += Math.min(nr, nh) - correct
  }
  const pct = (x) => +(100 * x / total).toFixed(1)
  return { der: pct(miss + fa + conf), miss: pct(miss), falseAlarm: pct(fa), confusion: pct(conf), refSpeakers: refSpk.length, hypSpeakers: hypSpk.length, mapping: Object.fromEntries([...mapH].map(([j, i]) => [hypSpk[j], refSpk[i]])) }
}

export const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s }
export const norm = (a) => { const l = Math.sqrt(dot(a, a)) || 1; return Float32Array.from(a, (x) => x / l) }
export const cos = (a, b) => dot(norm(a), norm(b))
/** running mean of unit vectors, kept unit length */
export function addTo(centroid, n, v) {
  const u = norm(v)
  const out = Float32Array.from(centroid, (x, i) => (x * n + u[i]) / (n + 1))
  return norm(out)
}
