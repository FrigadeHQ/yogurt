import type { Segment } from '../store'

/**
 * Transcripts brought in from other notes apps (Granola, Otter, Fireflies, …) through MCP, as text in the shapes
 * they export, or as lines. Plain code: no model reads them on the way in.
 */
export type ImportLine = { startMs: number | null; endMs: number | null; speaker: string | null; text: string }

const TIME = String.raw`(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)`
// a speaker's name: letters, digits and a little punctuation, never a colon, at most six words
const NAME = String.raw`([\p{L}\p{N}][\p{L}\p{M}\p{N} .'’@&_-]{0,79}?)`
const BRACKETED = new RegExp(String.raw`^\[${TIME}\]\s*(.*)$`, 'u')
const NAME_THEN_TIME = new RegExp(String.raw`^${NAME}\s*[([]${TIME}[)\]]\s*:?\s*(.*)$`, 'u')
const HEADER = new RegExp(String.raw`^${NAME}\s+${TIME}$`, 'u')
const TIME_FIRST = new RegExp(String.raw`^${TIME}\s+(.*)$`, 'u')
const NAMED = new RegExp(String.raw`^${NAME}:\s+(.*)$`, 'u')
const NAMED_ONLY = new RegExp(String.raw`^${NAME}:\s*(.*)$`, 'u')

/** "1:02:03", "12:40" or "0:05.5" as ms */
export function clockMs(s: string): number {
  const [whole, frac = ''] = s.split(/[.,]/)
  const parts = whole.split(':').map(Number)
  const secs = parts.reduce((t, p) => t * 60 + p, 0)
  return secs * 1000 + Math.round(Number(`0.${frac || '0'}`) * 1000)
}

const fewWords = (name: string) => name.trim().split(/\s+/).length <= 6
/** no name for words nobody was named for */
const speakerOf = (name: string | undefined): string | null => {
  const n = name?.replace(/\s+/g, ' ').trim()
  return !n || /^unknown( speaker)?$/i.test(n) ? null : n
}
/** a line with a name and a time and nothing else is a heading over the speaker's words: none of its words start small */
const headerName = (name: string) => fewWords(name) && name.trim().split(/\s+/).length <= 4 && !/(^|\s)\p{Ll}/u.test(name)

/** "Name: words" after a time; a name only when it looks like one */
function named(rest: string): { speaker: string | null; text: string } {
  const m = NAMED_ONLY.exec(rest)
  return m && fewWords(m[1]) ? { speaker: speakerOf(m[1]), text: m[2] } : { speaker: null, text: rest }
}

/**
 * Reads the shapes other apps export: "[mm:ss] Name: words", "Name (00:12:34): words", "Name: words", and a
 * "Name  0:05" heading with the words on the lines under it. A line that is none of these carries on the line
 * before it; after a blank line it is a new line by the same speaker.
 */
export function parseTranscript(text: string): ImportLine[] {
  const out: ImportLine[] = []
  let blank = false
  /** a heading waiting for its words */
  let heading: { speaker: string | null; startMs: number } | null = null
  const add = (l: ImportLine) => { out.push(l); heading = null }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) { blank = true; continue }
    let m: RegExpExecArray | null
    if ((m = BRACKETED.exec(line))) {
      add({ startMs: clockMs(m[1]), endMs: null, ...named(m[2]) })
    } else if ((m = NAME_THEN_TIME.exec(line)) && fewWords(m[1])) {
      if (m[3]) add({ startMs: clockMs(m[2]), endMs: null, speaker: speakerOf(m[1]), text: m[3] })
      else heading = { speaker: speakerOf(m[1]), startMs: clockMs(m[2]) }
    } else if ((m = HEADER.exec(line)) && headerName(m[1])) {
      heading = { speaker: speakerOf(m[1]), startMs: clockMs(m[2]) }
    } else if ((m = TIME_FIRST.exec(line))) {
      add({ startMs: clockMs(m[1]), endMs: null, ...named(m[2]) })
    } else if ((m = NAMED.exec(line)) && fewWords(m[1])) {
      add({ startMs: null, endMs: null, speaker: speakerOf(m[1]), text: m[2] })
    } else if (heading) {
      const h: { speaker: string | null; startMs: number } = heading
      add({ startMs: h.startMs, endMs: null, speaker: h.speaker, text: line })
    } else if (out.length && !blank) {
      out[out.length - 1].text += ` ${line}`
    } else {
      add({ startMs: null, endMs: null, speaker: out.at(-1)?.speaker ?? null, text: line })
    }
    blank = false
  }
  return out.filter((l) => l.text.trim()).map((l) => ({ ...l, text: l.text.trim() }))
}

/** about how long the words take to say (150 a minute), a second at least and half a minute at most */
const sayMs = (text: string) => Math.min(30_000, Math.max(1_000, text.split(/\s+/).filter(Boolean).length * 400))

/** Each line gets a start and an end: a missing start follows the line before, a missing end is where the next starts. */
export function timedLines(lines: ImportLine[]): Array<{ startMs: number; endMs: number; speaker: string | null; text: string }> {
  const out: Array<{ startMs: number; endMs: number; speaker: string | null; text: string }> = []
  lines.forEach((l, i) => {
    const startMs = l.startMs ?? out.at(-1)?.endMs ?? 0
    const next = lines.slice(i + 1).find((x) => x.startMs != null)?.startMs
    const endMs = l.endMs != null && l.endMs >= startMs ? l.endMs : next != null && next > startMs ? next : startMs + sayMs(l.text)
    out.push({ startMs, endMs, speaker: l.speaker, text: l.text })
  })
  return out
}

/** The person's own lines go on their side ("me"), by their name, "Me" or "You"; everyone else's on the other side. */
export function toSegments(meetingId: string, lines: Array<{ startMs: number; endMs: number; speaker: string | null; text: string }>, me: string): Omit<Segment, 'id'>[] {
  const mine = new Set(['me', 'you', me.trim().toLowerCase()].filter(Boolean))
  return lines.map((l) => {
    const own = l.speaker != null && mine.has(l.speaker.toLowerCase())
    return { meetingId, track: own ? 'me' as const : 'them' as const, startMs: l.startMs, endMs: l.endMs, speaker: own ? 'me' : l.speaker, text: l.text }
  })
}
