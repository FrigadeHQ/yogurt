// Transcript lab. Several speech models' readings of one stretch of speech, combined.

/** One model's reading of a window. weight: how much its word counts in a vote (its measured accuracy, else 1) */
export type Reading = { model: string; text: string; weight?: number }

import type { LabChoice } from './lab'

/** A place where the readings differ: each option is what some of the models heard there (empty: nothing) */
export type Choice = LabChoice

export type Combined = {
  text: string
  /** the places the models did not all agree, in order; `at` is the index of the choice's words in `words` */
  choices: Choice[]
  /** the combined words, a choice's picked option taking one place (possibly empty) */
  words: string[]
  /** share of the vote, over all places, that went to what was picked (1: every model heard the same) */
  agreement: number
}

/** a word as it is compared: lower case, no punctuation around it (Qu'est-ce, qu'est-ce, "qu'est-ce" are one word) */
export const keyOf = (w: string): string => w.normalize('NFKC').toLowerCase().replace(/’/g, "'").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')

/** words to compare: punctuation on its own (– …) goes with the word before it */
export function words(text: string): string[] {
  const out: string[] = []
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (!keyOf(w) && out.length) out[out.length - 1] += ` ${w}`
    else if (keyOf(w)) out.push(w)
  }
  return out
}

type Pair = [number | null, number | null]

/** Levenshtein alignment of two word lists by key: index pairs, null where one side has no word */
export function align(a: string[], b: string[]): Pair[] {
  const ka = a.map(keyOf), kb = b.map(keyOf)
  const n = a.length, m = b.length
  const d: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = 0; i <= n; i++) d[i][0] = i
  for (let j = 0; j <= m; j++) d[0][j] = j
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (ka[i - 1] === kb[j - 1] ? 0 : 1))
  const out: Pair[] = []
  let i = n, j = m
  while (i || j) {
    if (i && j && d[i][j] === d[i - 1][j - 1] + (ka[i - 1] === kb[j - 1] ? 0 : 1)) { out.push([i - 1, j - 1]); i--; j-- }
    else if (i && d[i][j] === d[i - 1][j] + 1) { out.push([i - 1, null]); i-- }
    else { out.push([null, j - 1]); j-- }
  }
  return out.reverse()
}

/** words that differ between two lists (substitutions, insertions and deletions) */
export const distance = (a: string[], b: string[]): number => align(a, b).filter(([x, y]) => x === null || y === null || keyOf(a[x]) !== keyOf(b[y])).length

type Tally = Map<string, { text: string; models: string[]; weight: number; best: number }>
const vote = (t: Tally, key: string, text: string, model: string, w: number) => {
  const have = t.get(key)
  if (!have) { t.set(key, { text, models: [model], weight: w, best: w }); return }
  have.models.push(model); have.weight += w
  // the words are written as the most trusted model that heard them wrote them
  if (w > have.best) { have.text = text; have.best = w }
}

/**
 * Pivot ROVER: every reading is aligned to the one closest to all the others, then each place is a weighted vote.
 * Place 2k+1 is the pivot's word k; place 2k is what readings put before it (and 2n after the last word), mostly nothing.
 * A tie goes to the pivot's own word, then to the reading listed first.
 */
export function combine(readings: Reading[], o: { terms?: string[] } = {}): Combined {
  // a word that is one of the meeting's names or terms gets one more model's vote: the models that know it outvote one that
  // heard an everyday word instead
  const terms = new Set((o.terms ?? []).map(keyOf).filter(Boolean))
  const rs = readings.map((r) => ({ ...r, w: words(r.text), weight: r.weight ?? 1 }))
  if (!rs.length) return { text: '', choices: [], words: [], agreement: 1 }
  let pivot = 0, best = Infinity
  rs.forEach((r, i) => { const d = rs.reduce((s, o) => s + distance(r.w, o.w), 0); if (d < best) { best = d; pivot = i } })
  const piv = rs[pivot].w
  const places: Tally[] = Array.from({ length: 2 * piv.length + 1 }, () => new Map())
  for (const r of rs) {
    let pos = 0, pending: string[] = []
    for (const [x, y] of align(piv, r.w)) {
      if (x === null) { pending.push(r.w[y!]); continue }
      vote(places[2 * pos], pending.map(keyOf).join(' '), pending.join(' '), r.model, r.weight); pending = []
      vote(places[2 * pos + 1], y === null ? '' : keyOf(r.w[y]), y === null ? '' : r.w[y], r.model, r.weight)
      pos++
    }
    vote(places[2 * pos], pending.map(keyOf).join(' '), pending.join(' '), r.model, r.weight)
  }
  const total = rs.reduce((s, r) => s + r.weight, 0)
  const out: string[] = [], choices: Choice[] = []
  let kept = 0
  const bonus = total / rs.length
  if (terms.size) for (const t of places) for (const [k, v] of t) if (k && k.split(' ').some((x) => terms.has(x))) v.weight += bonus
  places.forEach((t, p) => {
    const own = p % 2 ? keyOf(piv[(p - 1) / 2]) : ''
    const opts = [...t.entries()].sort((a, b) => b[1].weight - a[1].weight || Number(b[0] === own) - Number(a[0] === own))
    kept += Math.min(opts[0][1].weight, total)
    if (opts.length > 1) choices.push({ at: out.length, options: opts.map(([, o]) => ({ text: o.text, models: o.models, weight: o.weight })), picked: 0 })
    if (opts.length > 1 || opts[0][1].text) out.push(opts[0][1].text)
  })
  return { text: out.filter(Boolean).join(' '), choices, words: out, agreement: kept / (total * places.length) }
}

/**
 * Minimum Bayes risk: the one whole reading that differs least from the others (each other's difference counted by
 * that model's weight, per word it has). No stitching: whatever is picked was said that way by one model.
 */
export function pickBest(readings: Reading[]): number {
  const ws = readings.map((r) => words(r.text))
  let best = 0, score = Infinity
  ws.forEach((a, i) => {
    const s = ws.reduce((sum, b, j) => (j === i ? sum : sum + (readings[j].weight ?? 1) * distance(a, b) / Math.max(1, b.length)), 0)
    if (s < score) { score = s; best = i }
  })
  return best
}

/** The combined text once some choices were settled otherwise (by the notes model, or the person): picks[i] for choices[i] */
export function withPicks(c: Combined, picks: Map<number, number>): string {
  const ws = [...c.words]
  c.choices.forEach((ch, i) => { const p = picks.get(i); if (p !== undefined && ch.options[p]) ws[ch.at] = ch.options[p].text })
  return ws.filter(Boolean).join(' ')
}
