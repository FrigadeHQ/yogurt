import { searchPersonKey, type SearchPersonMatch } from '../../shared/searchPeople'
type Command = { id?: string; label: string; group: string; synonyms?: string[]; query?: string }
type Meeting = { meetingId?: string; confident?: boolean }
type SelectionRow = { kind: 'ask' } | { kind: 'command'; command: Command } | { kind: 'meeting'; meeting: Meeting } | ({ kind: 'person' } & SearchPersonMatch)

export function searchSelectionKey(row: SelectionRow): string {
  if (row.kind === 'command') return `command:${row.command.id ?? row.command.label}`
  if (row.kind === 'meeting') return `meeting:${row.meeting.meetingId}`
  if (row.kind === 'person') return `person:${searchPersonKey(row.person)}`
  return 'ask'
}

const normalize = (text: string) => text.trim().toLocaleLowerCase().replace(/\s+/g, ' ')
const words = (text: string) => text.split(/[^\p{L}\p{N}]+/u)

/** Exact label > label prefix > word start > group/synonym > substring. */
export function scoreCommand(command: Command, query: string): number {
  const q = normalize(query), label = normalize(command.label)
  // A parsed date matches its original query, even when its formatted label uses different words.
  if (command.query !== undefined) return q && normalize(command.query) === q ? 5 : 0
  if (!q) return 0
  if (label === q) return 5
  if (label.startsWith(q)) return 4
  const aliases = [command.group, ...(command.synonyms ?? [])].map(normalize)
  return Math.min(...q.split(' ').map((word) => {
    if (words(label).some((part) => part.startsWith(word))) return 3
    if (aliases.some((alias) => alias.startsWith(word) || words(alias).some((part) => part.startsWith(word)))) return 2
    return [label, ...aliases].some((text) => text.includes(word)) ? 1 : 0
  }))
}

export function isSearchQuestion(query: string): boolean {
  const text = query.trim()
  return /[?？؟]$/.test(text) || /^(who|what|when|where|why|how|did|do|does|is|are|can|could|would|should|was|were|will|have|has)\b/i.test(text)
}

export function searchPalette<C extends Command, M extends Meeting>(commands: C[], meetings: M[], query: string, askQuery = query, people: SearchPersonMatch[] = [], previous?: string, filtered = false) {
  const groups = [...new Set(commands.map(c => c.group))]
  const ranked = query.trim() ? commands.filter(c => !filtered || c.query !== undefined)
    .map(command => ({ kind: 'command' as const, command, score: scoreCommand(command, query) }))
    .filter(c => c.score > 0)
    .sort((a, b) => groups.indexOf(a.command.group) - groups.indexOf(b.command.group) || b.score - a.score) : []
  const question = isSearchQuestion(askQuery)
  const rows = [
    ...(question ? [{ kind: 'ask' as const, query: askQuery.trim() }] : []),
    ...(query.trim() ? meetings : meetings.slice(0, 3)).map(meeting => ({ kind: 'meeting' as const, meeting })),
    ...people.map(person => ({ kind: 'person' as const, ...person })),
    ...ranked.map(({ command }) => ({ kind: 'command' as const, command })),
  ]
  let active = 0
  if (!question && query.trim() && askQuery.trim()) {
    const meeting = rows.findIndex(row => row.kind === 'meeting' && row.meeting.confident)
    let best = ranked[0]
    for (const candidate of ranked) if (candidate.score > best.score) best = candidate
    if (best && (best.score >= 3 || meeting < 0 && best.score >= 2)) active = rows.findIndex(row => row.kind === 'command' && row.command === best.command)
    else if (meeting >= 0) active = meeting

    // Keep a strong default across near-tied queries without rearranging the groups.
    const prior = previous ? rows.findIndex(row => searchSelectionKey(row) === previous) : -1
    if (prior >= 0) {
      const strength = (row: SelectionRow) => {
        if (row.kind === 'meeting') return row.meeting.confident ? 4 : 0
        if (row.kind !== 'command') return 0
        const score = scoreCommand(row.command, query)
        return score >= 2 ? score + 1 : 0
      }
      if (strength(rows[prior]) && strength(rows[active]) < strength(rows[prior]) + 2) active = prior
    }
  }
  return { rows, active }
}
