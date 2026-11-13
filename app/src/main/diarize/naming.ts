import type { Turn } from './rttm'

export const CLAIM_MIN_MS = 2000
export const CLAIM_SHARE = 0.5

/** a resumed meeting's new turn that overlaps an old cluster by more than half its duration joins it (keeps its name) */
export function reuseKeys(turns: Turn[], existing: Array<{ key: string; startMs: number; endMs: number }>): Map<string, string> {
  const map = new Map<string, string>()
  for (const t of turns) {
    const dur = t.endMs - t.startMs
    for (const e of existing) {
      const ov = Math.max(0, Math.min(t.endMs, e.endMs) - Math.max(t.startMs, e.startMs))
      if (dur > 0 && ov > dur / 2) { map.set(t.key, e.key); break }
    }
  }
  return map
}

/** numbering continues after the highest Speaker N already shown; numbers are stable, never compacted */
export function nextSpeakerNumber(names: readonly string[]): number {
  let max = 0
  for (const n of names) { const m = /^Speaker (\d+)$/.exec(n); if (m) max = Math.max(max, Number(m[1])) }
  return max + 1
}

export type Cluster = { key: string; claims: Array<{ name: string | null; ms: number }>; total: number }

/**
 * One name per voice. A call-app name wins when it claims ≥ 2 s and more than half the cluster's speech; when
 * two clusters claim the same person, the stronger keeps it and the other falls back to Speaker N. A named
 * claim that fails that evidence bar leaves the speaker unnamed (null). Unnamed clusters number in
 * first-appearance order (the order the array comes in), named clusters consume no numbers.
 */
export function resolveNames(clusters: Cluster[], opts: { taken: readonly string[]; startNumber: number }): Array<{ key: string; speaker: string | null }> {
  const candidates = new Map<string, { name: string; ms: number }>()
  for (const c of clusters) {
    let best: { name: string; ms: number } | undefined
    for (const claim of c.claims) {
      if (!claim.name) continue
      if (!best || claim.ms > best.ms) best = { name: claim.name, ms: claim.ms }
    }
    if (best && best.ms >= CLAIM_MIN_MS && best.ms > CLAIM_SHARE * c.total) candidates.set(c.key, best)
  }
  // strongest claim keeps the person's name
  const winners = [...candidates.entries()].sort((a, b) => b[1].ms - a[1].ms)
  const assigned = new Map<string, string>()
  const usedNames = new Set<string>(opts.taken)
  for (const [key, { name }] of winners) if (!usedNames.has(name)) { assigned.set(key, name); usedNames.add(name) }
  let n = opts.startNumber
  const out: Array<{ key: string; speaker: string | null }> = []
  for (const c of clusters) {
    const name = assigned.get(c.key)
    if (name) { out.push({ key: c.key, speaker: name }); continue }
    // a call-app name that failed the evidence bar is not enough to name OR number the voice: leave it unnamed
    const rejected = !candidates.has(c.key) && c.claims.some((claim) => claim.name)
    if (rejected) out.push({ key: c.key, speaker: null })
    else { out.push({ key: c.key, speaker: `Speaker ${n}` }); n++ }
  }
  return out
}
