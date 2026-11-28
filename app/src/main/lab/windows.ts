// Transcript lab. What the extra models read: the meeting in stretches of one speaker.
import type { Segment } from '../store'
import { align, words } from '../../shared/labCombine'

/**
 * A stretch of one speaker on one track, made of consecutive saved lines: every model reads the same stretches, so their
 * readings line up, and long enough (up to 30 s) that a model hears whole sentences. key: stable across runs.
 */
export type Window = { key: string; track: Segment['track']; speaker: string | null; startMs: number; endMs: number; segmentIds: number[]; texts: string[] }

export const MAX_WINDOW_MS = 30_000
/** a pause this long between two lines starts a new stretch */
export const GAP_MS = 2_000

/** The stretches of a meeting's shown lines (hidden echo lines are left as they are) */
export function windowsOf(segs: Segment[], o: { maxMs?: number; gapMs?: number } = {}): Window[] {
  const maxMs = o.maxMs ?? MAX_WINDOW_MS, gapMs = o.gapMs ?? GAP_MS
  const out: Window[] = []
  for (const track of ['me', 'them'] as const) {
    let cur: Window | undefined
    for (const s of segs.filter((x) => x.track === track && !x.hidden).sort((a, b) => a.startMs - b.startMs || a.id - b.id)) {
      const fits = cur && cur.speaker === s.speaker && s.startMs - cur.endMs <= gapMs && Math.max(s.endMs, cur.endMs) - cur.startMs <= maxMs
      if (!fits) {
        if (cur) out.push(cur)
        cur = { key: `${track}:${s.startMs}`, track, speaker: s.speaker, startMs: s.startMs, endMs: s.endMs, segmentIds: [], texts: [] }
      }
      cur!.segmentIds.push(s.id); cur!.texts.push(s.text); cur!.endMs = Math.max(cur!.endMs, s.endMs)
    }
    if (cur) out.push(cur)
  }
  return out.sort((a, b) => a.startMs - b.startMs)
}

/**
 * A stretch's new text, shared out over its lines as the live text was: each new word goes to the line its live
 * counterpart was in, a word the live reading did not have to the line of the word before it. A line can end up empty.
 */
export function splitBack(text: string, liveTexts: string[]): string[] {
  const live: string[] = [], lineOf: number[] = []
  liveTexts.forEach((t, i) => { for (const w of words(t)) { live.push(w); lineOf.push(i) } })
  const next = words(text)
  const out: string[][] = liveTexts.map(() => [])
  if (!live.length) { out[0]?.push(...next); return out.map((l) => l.join(' ')) }
  let line = 0
  for (const [x, y] of align(live, next)) {
    if (x !== null) line = lineOf[x]
    if (y !== null) out[line].push(next[y])
  }
  return out.map((l) => l.join(' '))
}
