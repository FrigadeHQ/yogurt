import { describe, expect, it } from 'vitest'
import { completeSearchPerson, matchSearchPeople, removeSearchSpan, searchPersonKey, uniqueSearchPeople } from '../src/shared/searchPeople'
import { parseSearchQuery } from '../src/shared/searchQuery'

const person = { name: 'Riley Example', email: 'riley@example.test' }
const other = { name: 'Riley Sample', email: null }
const people = [person, other]

describe('people in search', () => {
  it('completes a suggestion in place and removes only its text when cleared', () => {
    const query = 'notes with Ril today'
    const choice = matchSearchPeople(query, people).suggestions[0]
    const completed = completeSearchPerson(query, choice)
    expect(completed).toBe('notes with Riley Example today')
    const recognized = matchSearchPeople(completed, people)
    expect(recognized.matches[0].person).toEqual(person)
    expect(removeSearchSpan(completed, recognized.matches[0])).toBe('notes today')
  })

  it('recognizes a unique first name after with and leaves the date in place', () => {
    const ana = { name: 'Ana López', email: 'ana@example.test' }
    const q = 'planning with Ana last week'
    const { matches, text } = matchSearchPeople(q, [ana])
    expect(matches.map(m => m.person)).toEqual([ana])
    expect(q.slice(matches[0].start, matches[0].end)).toBe('with Ana')
    expect(removeSearchSpan(q, matches[0])).toBe('planning last week')
    const date = parseSearchQuery(text).dateSpan!
    expect(q.slice(date.start, date.end)).toBe('last week')
    const weekday = 'planning with Ana on Tuesday'
    const parsed = parseSearchQuery(matchSearchPeople(weekday, [ana]).text)
    expect(parsed.words).toEqual(['planning'])
    expect(weekday.slice(parsed.dateSpan!.start, parsed.dateSpan!.end)).toBe('on Tuesday')
    expect(matchSearchPeople('with Anabel', [ana]).matches).toEqual([])
    const ambiguous = matchSearchPeople('with Ana', [ana, { name: 'Ana Gray', email: null }])
    expect(ambiguous.matches).toEqual([])
    expect(ambiguous.suggestions).toHaveLength(2)
  })

  it('keeps chosen single-word names in the text, and stops filtering when edited away', () => {
    const single = { name: 'Casey', email: null }
    const choice = matchSearchPeople('Cas today', [single]).suggestions[0]
    const completed = completeSearchPerson('Cas today', choice)
    expect(completed).toBe('Casey today')
    expect(matchSearchPeople(completed, [single], [single]).matches.map(m => m.person)).toEqual([single])
    expect(matchSearchPeople('Cas today', [single], [single]).matches).toEqual([])
    expect(matchSearchPeople('today', [single], [single]).matches).toEqual([])
  })

  it('remembers an explicit identity for a shared full name without removing the name', () => {
    const sameName = { ...person, email: 'another@example.test' }
    const choices = [person, sameName]
    const suggestion = matchSearchPeople('Ril', choices).suggestions[1]
    const completed = completeSearchPerson('Ril', suggestion)
    expect(completed).toBe(person.name)
    expect(matchSearchPeople(completed, choices, [sameName]).matches.map(m => m.person)).toEqual([sameName])
  })

  it.each(['Riley Example', 'RILEY@EXAMPLE.TEST'])('recognizes the exact identity %s', query => {
    const result = matchSearchPeople(query, people)
    expect(result.matches.map(m => m.person)).toEqual([person])
    expect(result.text.trim()).toBe('')
    expect(result.suggestions).toEqual([])
  })

  it.each(['Riley', 'Ril'])('suggests %s without turning a partial name into a filter', query => {
    const result = matchSearchPeople(query, people)
    expect(result.matches).toEqual([])
    expect(result.text).toBe(query)
    expect(result.suggestions.map(m => m.person)).toEqual(people)
    expect(removeSearchSpan(query, result.suggestions[0])).toBe('')
  })

  it('does not suggest short prefixes or auto-filter a single-word name', () => {
    expect(matchSearchPeople('Ri', people).suggestions).toEqual([])
    expect(matchSearchPeople('Riley', [{ name: 'Riley', email: null }]).matches).toEqual([])
    expect(matchSearchPeople('Riley', [{ name: 'Riley', email: null }]).suggestions).toHaveLength(1)
  })

  it('keeps the rest of the query and the date span when extracting a person', () => {
    const query = 'Riley Example nov 10'
    const result = matchSearchPeople(query, people)
    const date = parseSearchQuery(result.text, { now: new Date(2026, 10, 12) })
    expect(date.words).toEqual([])
    expect(date.date?.start).toBe(new Date(2026, 10, 10).getTime())
    expect(query.slice(date.dateSpan!.start, date.dateSpan!.end)).toBe('nov 10')
    expect(removeSearchSpan(query, result.matches[0])).toBe('nov 10')
    expect(removeSearchSpan(query, date.dateSpan!)).toBe('Riley Example')
    const fullPrefix = matchSearchPeople('Riley Exa nov 10', people)
    expect(removeSearchSpan('Riley Exa nov 10', fullPrefix.suggestions[0])).toBe('nov 10')
    const partial = matchSearchPeople('standup Ril nov 10', people)
    expect(removeSearchSpan('standup Ril nov 10', partial.suggestions[0])).toBe('standup nov 10')
  })

  it('keeps a date intact when part of a suggested name is also a month', () => {
    const result = matchSearchPeople('Ril nov 10', [{ name: 'Riley November', email: null }])
    expect(removeSearchSpan('Ril nov 10', result.suggestions[0])).toBe('nov 10')
  })

  it('recognizes the longer full name when another name is its prefix', () => {
    const longer = { name: 'Riley Example Sample', email: 'longer@example.test' }
    const result = matchSearchPeople(longer.name, [person, longer])
    expect(result.matches.map(m => m.person)).toEqual([longer])
    expect(result.suggestions).toEqual([])
  })

  it('requires whole names and emails, without interpreting punctuation as patterns', () => {
    for (const query of ['Riley Examples', 'riley@example.test.invalid', 'other-riley@example.test']) {
      expect(matchSearchPeople(query, people).matches).toEqual([])
    }
    const literal = { name: 'Riley (Example)', email: 'riley+notes@example.test' }
    expect(matchSearchPeople(literal.email, [literal]).matches[0].person).toEqual(literal)
    expect(matchSearchPeople(literal.name, [literal]).matches[0].person).toEqual(literal)
  })

  it('deduplicates by normalized email, falling back to normalized name', () => {
    const duplicate = { name: 'Different display', email: ' RILEY@EXAMPLE.TEST ' }
    expect(searchPersonKey(person)).toBe(searchPersonKey(duplicate))
    expect(uniqueSearchPeople([person, duplicate, other, { name: ' riley  sample ', email: null }])).toHaveLength(2)
    expect(uniqueSearchPeople([person, { ...person, email: 'another@example.test' }])).toHaveLength(2)
  })

  it('asks for a choice when a full name identifies more than one email', () => {
    const sameName = { ...person, email: 'another@example.test' }
    const result = matchSearchPeople(person.name, [person, sameName])
    expect(result.matches).toEqual([])
    expect(result.suggestions.map(m => m.person)).toEqual([person, sameName])
    expect(removeSearchSpan(person.name, result.suggestions[0])).toBe('')
    expect(matchSearchPeople(person.email, [person, sameName]).matches.map(m => m.person)).toEqual([person])
  })
})
