import type { CalEvent, Person } from './types'
import { personEmail } from './people'
import { parseSearchQuery, searchWords, type SearchOptions } from './searchQuery'

const nameKey = (name: string) => name.trim().toLocaleLowerCase().replace(/\s+/g, ' ')
export const searchPersonKey = (person: Person) => person.email?.trim() ? `email:${personEmail(person.email)}` : `name:${nameKey(person.name)}`
export const uniqueSearchPeople = (people: Person[]) => [...new Map(people.map(p => [searchPersonKey(p), p])).values()]
export type SearchPersonMatch = { person: Person; start: number; end: number }
export const removeSearchSpan = (query: string, span: { start: number; end: number }) => (query.slice(0, span.start) + ' ' + query.slice(span.end)).replace(/\s+/g, ' ').trim()
export const completeSearchPerson = (query: string, match: SearchPersonMatch) => query.slice(0, match.start) + (match.person.name.trim() || match.person.email || '') + query.slice(match.end)
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function matchSearchPeople(query: string, people: Person[], chosen: Person[] = [], options: SearchOptions = {}) {
  const candidates = uniqueSearchPeople(people)
  const chosenKeys = new Set(chosen.map(searchPersonKey))
  const exact: SearchPersonMatch[] = []
  for (const person of candidates) {
    const selected = chosenKeys.has(searchPersonKey(person))
    const labels = [person.email?.trim(), ...(selected || person.name.trim().split(/\s+/).length > 1 ? [person.name.trim()] : [])].filter((s): s is string => !!s)
    for (const label of labels) {
      const match = new RegExp(`(?<![\\p{L}\\p{N}@._+-])${escape(label).replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}@._+-])`, 'iu').exec(query)
      if (match) { exact.push({ person, start: match.index, end: match.index + match[0].length }); break }
    }
  }
  const preferred = exact.filter(m => !exact.some(other => other !== m && other.start === m.start && other.end === m.end
    && chosenKeys.has(searchPersonKey(other.person)) && !chosenKeys.has(searchPersonKey(m.person))))
  const longest = preferred.filter(m => !preferred.some(other => other.start <= m.start && other.end >= m.end && other.end - other.start > m.end - m.start))
  // A shared full name is not enough to choose between different email identities.
  const matches = longest.filter(m => !longest.some(other => other !== m && other.start < m.end && other.end > m.start))
  let text = query
  for (const match of matches) text = text.slice(0, match.start) + ' '.repeat(match.end - match.start) + text.slice(match.end)
  const date = parseSearchQuery(text, options).dateSpan
  const tokens = [...text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}@._+'’-]*/gu)]
  const suggestions: SearchPersonMatch[] = []
  for (const person of candidates) {
    if (matches.some(m => searchPersonKey(m.person) === searchPersonKey(person))) continue
    const ambiguous = longest.find(m => searchPersonKey(m.person) === searchPersonKey(person))
    if (ambiguous) { suggestions.push(ambiguous); continue }
    const names = nameKey(person.name).split(/\s+/)
    let best: SearchPersonMatch | undefined
    tokens.forEach((token, i) => {
      if (date && token.index! >= date.start && token.index! < date.end) return
      const word = token[0].toLocaleLowerCase()
      if (!searchWords(word).length || word.length < 3 && word !== names[0]) return
      const offer = (end: number) => {
        if (!best || end - token.index! > best.end - best.start) best = { person, start: token.index!, end }
      }
      if (person.email && personEmail(person.email).startsWith(word)) offer(token.index! + token[0].length)
      names.forEach((_, j) => {
        for (let k = 0; i + k < tokens.length && j + k < names.length; k++) {
          const part = tokens[i + k]
          if (date && part.index! >= date.start && part.index! < date.end) break
          if (k && !/^\s+$/.test(query.slice(tokens[i + k - 1].index! + tokens[i + k - 1][0].length, part.index))) break
          if (!names[j + k].startsWith(part[0].toLocaleLowerCase())) break
          offer(part.index! + part[0].length)
        }
      })
    })
    if (best) suggestions.push(best)
  }
  return { text, matches, suggestions }
}

/** This event's invitees lead, then recently met people, then other invitees that day. */
export function attendeeSuggestions(query: string, known: Person[], attendees: Person[], me: string, events: CalEvent[] = [], eventId?: string | null): Person[] {
  const event = events.find(e => e.id === eventId || e.aliases?.includes(eventId!))
  const people = [...(event?.attendees ?? []), ...known, ...events.filter(e => e !== event).flatMap(e => e.attendees)]
  const namedEmails = new Set(people.filter(p => p.email?.trim()).map(p => nameKey(p.name)))
  const excluded = [...attendees, { name: me, email: null }, ...people.filter(p => nameKey(p.name) === nameKey(me))]
  const candidates = uniqueSearchPeople(people).filter(p => (p.email?.trim() || !namedEmails.has(nameKey(p.name))) && !excluded.some(a =>
    a.email?.trim() && p.email?.trim() ? personEmail(a.email) === personEmail(p.email) : nameKey(a.name) === nameKey(p.name)))
  const { matches, suggestions } = matchSearchPeople(query, candidates)
  const keys = new Set([...matches, ...suggestions].filter(m => !removeSearchSpan(query, m)).map(m => searchPersonKey(m.person)))
  return candidates.filter(p => keys.has(searchPersonKey(p))).slice(0, 5)
}
