/**
 * A transcript from a call app's live captions, for a meeting the call's audio never reached (joined without computer
 * audio): the captions are then the only record of what the other side said. Zoom writes each person's words into a
 * row that grows as they talk (1 to 258 characters on a real call, a change every 0.62 s at the median), opens a new
 * row now and then even mid-sentence, and scrolls old rows away. So a reading's rows are lined up against the lines
 * assembled so far: a row that is a line grown replaces its words, a row that is none of them starts a line.
 */
export type CaptionRow = { who: string; text: string }
/** firstAt, lastAt: wall clock when the row was first seen and when it last changed */
export type CaptionLine = { who: string; text: string; firstAt: number; lastAt: number }

/** how many of the latest lines a reading's rows are lined up against: more than Zoom shows at once */
const RECENT = 30
/** a row is a line grown when they open the same way: Zoom may correct a word later on, rarely the first ones */
const OPENING = 24

const clean = (t: string) => t.normalize('NFKC').replace(/\s+/g, ' ').trim()
const opening = (t: string, n: number) => t.slice(0, n).toLocaleLowerCase()
const sameRow = (line: CaptionLine, row: CaptionRow) => {
  if (line.who !== row.who) return false
  const n = Math.min(OPENING, line.text.length, row.text.length)
  return n > 0 && opening(line.text, n) === opening(row.text, n)
}

/** Folds one reading's rows (oldest first) into the lines so far, in place. */
export function foldCaptions(lines: CaptionLine[], raw: CaptionRow[], at: number): void {
  const rows = raw.map((r) => ({ who: r.who, text: clean(r.text) })).filter((r) => r.text)
  if (!rows.length) return
  const from = Math.max(0, lines.length - RECENT)
  // where the rows on screen begin among the lines: the place where most of them, in order, are those lines grown
  // (the latest such place when two fit as well, since the rows on screen are the latest)
  let best = -1, bestRow = 0, bestRun = 0
  for (let i = 0; i < rows.length && bestRun === 0; i++) {
    for (let j = lines.length - 1; j >= from; j--) {
      let run = 0
      while (i + run < rows.length && j + run < lines.length && sameRow(lines[j + run], rows[i + run])) run++
      if (run > bestRun) { best = j; bestRow = i; bestRun = run }
    }
  }
  if (best < 0) {
    for (const r of rows) lines.push({ ...r, firstAt: at, lastAt: at })
    return
  }
  // rows above the first that fits are older than anything kept that still matches (words corrected since): left out
  for (let k = 0; bestRow + k < rows.length; k++) {
    const r = rows[bestRow + k], line = k < bestRun ? lines[best + k] : undefined
    if (line) { if (line.text !== r.text) { line.text = r.text; line.lastAt = at } }
    else lines.push({ ...r, firstAt: at, lastAt: at })
  }
}

/** a line a later one of the same person has grown past, within this long, is that line seen before it was lined up */
const PARTIAL_WITHIN_MS = 30_000

/** The lines to keep: a stale copy of a line that a later one carries whole is dropped. */
export function finishCaptions(lines: CaptionLine[]): CaptionLine[] {
  return lines.filter((a, i) => !lines.some((b, j) => j > i && b.who === a.who && b.firstAt - a.lastAt <= PARTIAL_WITHIN_MS
    && b.text.length > a.text.length && b.text.toLocaleLowerCase().startsWith(a.text.toLocaleLowerCase())))
}
