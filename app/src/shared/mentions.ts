/**
 * Mentions: someone on the other side of the call says the person's name, and Yogurt lets them know with what was said
 * just before. The names are the one in Settings (or the Mac's) and the other names people call them (Settings → General).
 */

/** a nickname is a word or two */
export const MAX_NICKNAME = 40
/** a handful: every one is listened for in every line */
export const MAX_NICKNAMES = 10

const clean = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, MAX_NICKNAME).trim()

/** the list with one more name, or the same list: blank, already there (whatever its case) or full */
export function addNickname(list: string[], name: string): string[] {
  const n = clean(name)
  if (!n || list.length >= MAX_NICKNAMES || list.some((x) => x.toLowerCase() === n.toLowerCase())) return list
  return [...list, n]
}

/** what was saved or sent, made safe: strings only, each once, at most MAX_NICKNAMES */
export function cleanNicknames(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.reduce<string[]>((list, x) => (typeof x === 'string' ? addNickname(list, x) : list), [])
}

/** lowercase, without accents, so "José" is heard in "jose" and the other way round */
const fold = (s: string) => s.normalize('NFKD').replace(/\p{M}+/gu, '').toLocaleLowerCase()

/** one letter is too easily part of something else ("A", "J") */
const MIN_NAME = 2

/**
 * The names to listen for: the full name, its first word (what people say in a call), and each nickname.
 * A first name that is only an initial ("J. Smith") is left out.
 */
export function mentionNames(myName: string, nicknames: string[] = []): string[] {
  const full = myName.replace(/\s+/g, ' ').trim()
  const first = full.split(' ')[0]?.replace(/[.,]+$/, '') ?? ''
  const seen = new Set<string>()
  return [full, first, ...nicknames.map(clean)].filter((n) => {
    const k = fold(n)
    if ([...k.replace(/[^\p{L}\p{N}]/gu, '')].length < MIN_NAME || seen.has(k)) return false
    seen.add(k)
    return true
  })
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The name heard in the text, or null. Whole words only, so "Vince" is heard in "Vince's" and "vince," but not in
 * "convince"; spaces in a name match any run of spaces. The longest name is tried first, so the full name wins.
 */
export function mentionIn(text: string, names: string[]): string | null {
  const t = fold(text)
  for (const n of [...names].sort((a, b) => b.length - a.length)) {
    const pattern = fold(n).split(/\s+/).map(escape).join('\\s+')
    if (new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, 'u').test(t)) return n
  }
  return null
}

/** a line of the transcript, as the notification shows it */
export type ContextLine = { who: string; text: string }

/** about what a notification shows before it cuts the text off */
export const CONTEXT_CHARS = 280

/** words said before the name that are kept when a long line is cut down to it */
const LEAD_CHARS = 60

/** a long line cut to `room` characters around the name: some of what led up to it, the name, what came after */
function around(text: string, name: string | undefined, room: number): string {
  if (text.length <= room) return text
  const folded = fold(text)
  // folding can change the length (ligatures): then there is no telling where the name is, and the end is kept
  const at = name && folded.length === text.length ? folded.indexOf(fold(name)) : -1
  let from = at < 0 ? text.length - room : Math.max(0, at - LEAD_CHARS)
  from = Math.min(from, text.length - room)
  // start and end on a word
  const space = text.indexOf(' ', from)
  if (from > 0 && space >= 0 && space < (at < 0 ? text.length : at)) from = space + 1
  const cut = text.slice(from, from + room - 2).trim()
  return `${from > 0 ? '…' : ''}${cut}${from + room - 2 < text.length ? '…' : ''}`
}

/**
 * What the notification says. A banner shows only its first two lines or so, so the mention's own line comes first (the title
 * says who said it), cut down around the name when it alone is too long. Then the lines leading up to it, in the order they
 * were said, as "Who: what they said"; the oldest go when there is too much.
 */
export function contextBody(lines: ContextLine[], name?: string, max = CONTEXT_CHARS): string {
  if (!lines.length) return ''
  const tidy = (s: string) => s.replace(/\s+/g, ' ').trim()
  const said = around(tidy(lines.at(-1)!.text), name, Math.max(20, max))
  const before: string[] = []
  let used = said.length
  for (let i = lines.length - 2; i >= 0; i--) {
    const s = `${lines[i].who}: ${tidy(lines[i].text)}`
    if (used + s.length + 1 > max) break
    before.unshift(s)
    used += s.length + 1
  }
  return [said, ...before].join('\n')
}
