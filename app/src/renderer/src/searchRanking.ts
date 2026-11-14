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

export function orderSearchResults<C extends Command, M>(commands: C[], meetings: M[], query: string) {
  const ranked = commands.map((command) => ({ command, score: scoreCommand(command, query) }))
    .filter(({ score }) => !query.trim() || score > 0)
    .sort((a, b) => b.score - a.score)
  const commandRows = ranked.map(({ command }) => ({ kind: 'command' as const, command }))
  const meetingRows = meetings.map((meeting) => ({ kind: 'meeting' as const, meeting }))
  const leading = ranked[0]?.score >= 3 ? 4 : 0
  return [...commandRows.slice(0, leading), ...meetingRows, ...commandRows.slice(leading)]
}

export function searchPalette<C extends Command, M extends Meeting>(commands: C[], meetings: M[], query: string, askQuery = query, people: SearchPersonMatch[] = [], previous?: string, filtered = false) {
  const matches = orderSearchResults(filtered ? commands.filter(c => c.query !== undefined) : commands, meetings, query)
  const choices = [...people.map(person => ({ kind: 'person' as const, ...person })), ...matches]
  const rows = askQuery.trim() ? [{ kind: 'ask' as const, query: askQuery.trim() }, ...choices] : choices
  // Ask stays pinned, but Enter chooses a strong command or a meeting whose terms all match metadata.
  // Keep the completed query’s strong selection while new results settle; questions still select Ask.
  const question = /\?\s*$/.test(askQuery) || /^(who|what|when|where|why|how|did|does|is|are|can|should)\b/i.test(askQuery.trim())
  const best = askQuery.trim() && query.trim() && !question ? rows.findIndex(row => row.kind === 'command'
    ? scoreCommand(row.command, query) >= 3 : row.kind === 'meeting' && row.meeting.confident) : -1
  let active = best < 0 ? 0 : best
  if (askQuery.trim() && query.trim() && !question && previous) {
    const prior = rows.findIndex(row => searchSelectionKey(row) === previous)
    const strength = (row: SelectionRow) => {
      if (row.kind === 'ask') return 2
      if (row.kind === 'meeting') return row.meeting.confident ? 4 : 0
      if (row.kind !== 'command') return 0
      const score = scoreCommand(row.command, query)
      return score >= 2 ? score + 1 : 0
    }
    // Keep a still-relevant choice across near-ties; a two-point gain, question, or vanished match replaces it.
    if (prior >= 0 && strength(rows[prior]) > 0 && strength(rows[active]) < strength(rows[prior]) + 2) active = prior
  }
  return { rows, active }
}
