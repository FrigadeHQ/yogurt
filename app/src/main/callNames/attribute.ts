/**
 * Who said a line from the other side, from what the call app showed while it was said. Never a guess: a name only
 * when the app marked that one person as talking for most of the line, or when the call has just one other person.
 * Anything else (nobody marked, several at once, the app not read) is Them.
 */

/** One reading of the call app, at meeting time (capture latency and the app's own lag already taken off) */
export type CallSample = {
  ms: number
  /** who the app marks as talking right now */
  speaking: string[]
  /** everyone the app shows in the call, the person using Yogurt too */
  participants: string[]
  /** the person using Yogurt, when the app says which one they are ("(me)", "You") */
  me: string | null
  /** false: the app could not be read at this moment (no window, no permission) */
  ok?: boolean
  /** the most people the app showed in the last minute: a stage showing two of a bigger call is no call of two */
  most?: number
}

/** a reading stands until the next one, but never longer than this: a stuck app never keeps naming someone */
export const HOLD_MS = 2000
/** a name needs more than this share of the line */
const MOST = 0.5

/** what follows the comma in "Okafor, Jr." is not a given name, so that one is never flipped */
const SUFFIX = /^(jr|sr|ii|iii|iv|phd|md|esq)\.?$/
/**
 * A name for comparing only. Exchange and Outlook calendars write "Okafor, Riley" where the call apps write
 * "Riley Okafor", so a bare "family, given" comma is flipped and the two forms compare equal. Without this the
 * people a call shows are added to the meeting a second time, beside the ones the calendar already gave, and the
 * person using Yogurt is not recognised as themselves when the two sources disagree on the order. Only the bare
 * two-part form is flipped: an email, more than one comma, a name suffix, or a trailing qualifier a directory
 * appends ("Okafor, Riley (Contoso)") is left as it is, and still compares unequal to the call's form.
 */
export const norm = (s: string) => {
  const flat = s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase()
  const m = /^([^,@]+),\s*([^,@]+)$/.exec(flat)
  if (!m) return flat
  // the halves are trimmed, so "Okafor , Riley" gives the same key as "Okafor, Riley": a stray space would
  // otherwise survive the flip, compare unequal to the call's form, and miscount the words below
  const family = m[1].trim(), given = m[2].trim()
  const plain = (x: string) => x.length > 0 && x.split(' ').length <= 3
  return plain(family) && plain(given) && !SUFFIX.test(given) ? `${given} ${family}` : flat
}

type Opts = { /** the person's own name in Settings, and the Mac's: never a name for the other side */ myNames?: string[] }

const isMe = (name: string, s: CallSample, o: Opts) => {
  const n = norm(name)
  return (s.me != null && norm(s.me) === n) || (o.myNames ?? []).some((m) => m && norm(m) === n)
}

// A talking mark that stays on a tile while others come and go is not talking (#112: an 8-person Meet read "2 of 8"
// or "3 of 8" for the whole call and named none of 370 lines). Meet left its mark on two tiles all along (my own, a
// pinned or presenting one) and the third came and went with whoever spoke. Over the readings around a line, a name
// marked in nearly all of them, in a stretch where two or more are marked most of the time, is dropped. One person
// marked alone for minutes is someone giving a talk, and stays.
/** the readings around a line that tell a steady mark: two and a half minutes each side */
const STEADY_SPAN_MS = 150_000
/** fewer readings than this (about 20 s) can't tell a mark that stays from one that hasn't moved yet */
const STEADY_MIN = 40
/** marked in this share of the readings, or more */
const STEADY_SHARE = 0.8
/** and two or more marked at once in this share of them */
const CROWDED_SHARE = 0.5

function steadyMarks(sorted: CallSample[], atMs: number, o: Opts): Set<string> {
  const seen = sorted.filter((s) => s.ok !== false && s.participants.length && Math.abs(s.ms - atMs) <= STEADY_SPAN_MS)
  if (seen.length < STEADY_MIN) return new Set()
  const marked = new Map<string, number>()
  let crowded = 0
  for (const s of seen) {
    const others = new Set(s.speaking.filter((p) => !isMe(p, s, o)).map(norm))
    if (others.size >= 2) crowded++
    for (const p of others) marked.set(p, (marked.get(p) ?? 0) + 1)
  }
  if (crowded < CROWDED_SHARE * seen.length) return new Set()
  return new Set([...marked].filter(([, n]) => n >= STEADY_SHARE * seen.length).map(([p]) => p))
}

/** who the other side was at one reading, or null when it can't be told */
function whoAt(s: CallSample, o: Opts, steady: Set<string> = new Set()): string | null {
  if (s.ok === false) return null
  // the first written form of each person wins, as in othersIn: now that norm() collapses "family, given" with
  // "given family", the two must agree on which form they keep or a speaker is named a form the People list lacks
  const people = s.participants.filter((p, i) => s.participants.findIndex((q) => norm(q) === norm(p)) === i)
  const roster = new Set(people.map(norm))
  // A floating speaker tile can name someone before (or after) the roster refreshes. In that case this is not
  // evidence of a two-person call, so do not assign their speech to the one other roster entry.
  const speakerOutsideRoster = s.speaking.some((p) => !isMe(p, s, o) && !roster.has(norm(p)))
  // one other person in the call: the call's sound can only be them, whoever the app marks
  if (people.length === 2 && (s.most ?? 2) <= 2 && !speakerOutsideRoster) {
    const mine = people.filter((p) => isMe(p, s, o))
    if (mine.length === 1) return people.find((p) => !isMe(p, s, o))!
  }
  const others = [...new Set(s.speaking.filter((p) => !isMe(p, s, o) && !steady.has(norm(p))))]
  return others.length === 1 ? others[0] : null
}

/** The name for a line of the other side spoken over [startMs, endMs], or null for Them */
export function nameFor(span: { startMs: number; endMs: number }, samples: CallSample[], o: Opts = {}): string | null {
  if (!samples.length) return null
  const sorted = [...samples].sort((a, b) => a.ms - b.ms)
  const at = (i: number) => [sorted[i].ms, Math.min(sorted[i + 1]?.ms ?? Infinity, sorted[i].ms + HOLD_MS)] as const
  const steady = steadyMarks(sorted, (span.startMs + span.endMs) / 2, o)
  // a line too short to measure: whoever it was the moment it started
  if (span.endMs <= span.startMs) {
    for (let i = sorted.length - 1; i >= 0; i--) { const [a, b] = at(i); if (a <= span.startMs) return span.startMs < b ? whoAt(sorted[i], o, steady) : null }
    return null
  }
  const time = new Map<string, number>()
  for (let i = 0; i < sorted.length; i++) {
    const [a, b] = at(i)
    const overlap = Math.min(b, span.endMs) - Math.max(a, span.startMs)
    if (overlap <= 0) continue
    const who = whoAt(sorted[i], o, steady)
    if (who) time.set(who, (time.get(who) ?? 0) + overlap)
  }
  const [best] = [...time].sort((x, y) => y[1] - x[1])
  return best && best[1] > MOST * (span.endMs - span.startMs) ? best[0] : null
}

/** Everyone seen in the call but the person using Yogurt, each once, in the order first seen */
export function othersIn(samples: CallSample[], o: Opts = {}): string[] {
  const out = new Map<string, string>()
  for (const s of samples) for (const p of s.participants) if (!isMe(p, s, o) && !out.has(norm(p))) out.set(norm(p), p)
  // someone marked "me" in a later reading is never one of the others
  const me = new Set(samples.flatMap((s) => (s.me ? [norm(s.me)] : [])))
  return [...out].filter(([k]) => !me.has(k)).map(([, v]) => v)
}
