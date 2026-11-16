import { joinWords } from '../../shared/liveWords'
import type { Word } from '../store'
import type { Turn } from './rttm'

/** a word whose turn is farther than this from anything the diarizer heard stays Them */
export const NEAR_MS = 2000

/** a them row being re-split (as the store maps it) */
export type SplitRow = { id: number; startMs: number; endMs: number; text: string; speaker: string | null; words?: Word[] }
/** one row of the new transcript: a voice's run of words, or the unsplit remainder of a line */
export type SplitRun = { lineIds: number[]; key: string | null; startMs: number; endMs: number; text: string; speaker: string | null; words: Word[] }

const overlap = (a: { startMs: number; endMs: number }, b: { startMs: number; endMs: number }) => Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs))

/** the turn with the greatest overlap (ties to the earlier turn); a zero-length span (a whisper chunk split leaves
 * whole words without times) takes the turn it sits in, the innermost when turns overlap; else a turn that starts
 * within 2 s after it (a span is never pulled back into the turn before it); else null */
function turnFor(span: { startMs: number; endMs: number }, turns: Turn[]): Turn | null {
  let best: Turn | null = null, bestOv = 0
  for (const t of turns) { const ov = overlap(span, t); if (ov > bestOv) { best = t; bestOv = ov } }
  if (best) return best
  if (span.endMs <= span.startMs) {
    let inside: Turn | null = null
    for (const t of turns) if (t.startMs <= span.startMs && span.startMs <= t.endMs && (!inside || t.startMs > inside.startMs)) inside = t
    if (inside) return inside
  }
  let near: Turn | null = null, gap = Infinity
  for (const t of turns) {
    const d = t.startMs >= span.endMs ? t.startMs - span.endMs : Infinity
    if (d < gap) { near = t; gap = d }
  }
  return gap <= NEAR_MS ? near : null
}

/** lines whisper gave no words for: the whole line goes to the turn it overlaps most */
export function lineTurn(line: { startMs: number; endMs: number }, turns: Turn[]): Turn | null { return turnFor(line, turns) }

/** a run's evidence name: the named call-app claim with the most speech (ties to the earliest); Them never claims */
export function evidenceName(claims: Array<{ name: string | null; ms: number }>): string | null {
  let best: string | null = null, bestMs = 0
  for (const c of claims) if (c.name && c.ms > bestMs) { best = c.name; bestMs = c.ms }
  return best
}

/** punctuation whisper splits off joins the word before it without a space, when it does not start after that word ends */
const GLUED = /^[^\p{L}\p{N}]+$/u
const textOf = (words: Word[], spell: (t: string) => string) => spell(joinWords(words.map((w, i) => (i > 0 && GLUED.test(w.text) && w.startMs <= words[i - 1].endMs ? { ...w, glue: true } : w))))

/**
 * The whole ordered word stream of the rows being diarized, split at speaker changes. Whisper's line boundaries
 * are arbitrary and often straddle a speaker change, so words are placed per turn, not per line: a run keeps going
 * across rows while the voice stays the same. A row no word of which the diarizer heard stays as it is; a word no
 * turn claims joins the voice before it when it is alone there and near it (timing scatter, not an utterance) and
 * stays Them when it comes in company or long after.
 */
export function splitPlan(rows: SplitRow[], turns: Turn[], spell: (t: string) => string): { keep: number[]; runs: SplitRun[] } {
  const keep = rows.filter(r => !r.words?.length).map(r => r.id)
  const built: Array<{ run: SplitRun; claims: Map<string | null, number> }> = []
  const speak = (claims: Map<string | null, number>) => evidenceName([...claims].map(([name, ms]) => ({ name, ms })))
  let cur: { key: string | null; words: Word[]; claims: Map<string | null, number>; lineIds: number[] } | null = null
  const flush = () => {
    if (!cur?.words.length) { cur = null; return }
    // one word the diarizer heard nothing for goes to the voice before it, when that voice spoke near it
    if (cur.key === null && cur.words.length === 1 && built.length && cur.words[0].startMs - built[built.length - 1].run.endMs <= NEAR_MS) {
      const prev = built[built.length - 1]
      const w = cur.words[0]
      prev.run.words.push(w)
      prev.run.endMs = w.endMs
      for (const [name, ms] of cur.claims) prev.claims.set(name, (prev.claims.get(name) ?? 0) + ms)
      for (const id of cur.lineIds) if (!prev.run.lineIds.includes(id)) prev.run.lineIds.push(id)
      prev.run.text = textOf(prev.run.words, spell)
      prev.run.speaker = prev.run.key ? speak(prev.claims) : null
    } else {
      built.push({ run: { lineIds: cur.lineIds, key: cur.key, startMs: cur.words[0].startMs, endMs: cur.words[cur.words.length - 1].endMs, text: textOf(cur.words, spell), speaker: cur.key ? speak(cur.claims) : null, words: cur.words }, claims: cur.claims })
    }
    cur = null
  }
  for (const row of rows) {
    const words = row.words ?? []
    if (!words.length) continue
    const placed = words.map(w => turnFor(w, turns))
    // lines with words but no turn at all: kept whole (nothing changes for them)
    if (!placed.some(Boolean)) { keep.push(row.id); continue }
    for (let i = 0; i < words.length; i++) {
      const word = words[i], key = placed[i]?.key ?? null
      if (cur && cur.key === key) {
        cur.words.push(word)
        cur.claims.set(row.speaker, (cur.claims.get(row.speaker) ?? 0) + (word.endMs - word.startMs))
      } else {
        flush()
        cur = { key, words: [word], claims: new Map([[row.speaker, word.endMs - word.startMs]]), lineIds: [] }
      }
      if (!cur.lineIds.includes(row.id)) cur.lineIds.push(row.id)
    }
  }
  flush()
  return { keep, runs: built.map(b => b.run) }
}
