import { afterEach, describe, expect, it } from 'vitest'
import { searchDateCommand, searchDateLabel, searchFilterEmptyMessage, searchFilterHighlights } from '../src/renderer/src/searchFilters'
import { setLanguage } from '../src/shared/i18n'
import { matchSearchPeople, removeSearchSpan } from '../src/shared/searchPeople'
import { parseSearchQuery } from '../src/shared/searchQuery'
import { searchPalette } from '../src/renderer/src/searchRanking'

const person = { name: 'Riley Example', email: 'riley@example.test' }
const commands = [{ label: 'Settings', group: 'Go to' }]
afterEach(() => setLanguage('en'))

describe('agenda date command', () => {
  const options = { now: new Date(2026, 10, 14, 12), locale: 'en-US', language: 'en' }
  it.each(['November 11th, 2028', '11/11/2028', '2028-11-11', 'today', 'tomorrow', 'planning on November 11, 2028'])('offers a single-day jump for %s and keeps meeting results', query => {
    const parsed = parseSearchQuery(query, options)
    const command = searchDateCommand(parsed.date, query)!
    expect(command).toMatchObject({ id: 'agenda-date', group: 'Go to', at: parsed.date!.start })
    const meeting = { meetingId: 'example', confident: true }
    const palette = searchPalette([...commands, command], [meeting], query, query, [], undefined, true)
    expect(palette.rows.map(row => row.kind)).toEqual(['ask', 'command', 'meeting'])
    expect(palette.rows[palette.active]).toEqual({ kind: 'command', command })
  })
  it.each(['', 'planning', 'November', 'in November', 'last week', 'past 7 days', 'November 11 to November 13, 2028', '02/30/2028'])('omits the jump for %s', query => {
    expect(searchDateCommand(parseSearchQuery(query, options).date, query)).toBeUndefined()
  })
  it('formats the label in the app language, including the year', () => {
    const date = parseSearchQuery('November 11, 2028', options).date
    expect(searchDateCommand(date, 'November 11, 2028')?.label).toBe('Go to Nov 11, 2028')
    setLanguage('fr')
    expect(searchDateCommand(date, '11/11/2028')).toMatchObject({ group: 'Aller à', label: 'Aller au 11 nov. 2028' })
  })
  it('matches localized and relative input even when it differs from the label', () => {
    setLanguage('de')
    const query = '11. November 2028'
    const command = searchDateCommand(parseSearchQuery(query, { ...options, language: 'de' }).date, query)!
    expect(command.label).toBe('Zum 11. Nov. 2028 springen')
    const palette = searchPalette([command], [], query, query, [], undefined, true)
    expect(palette.rows[palette.active]).toEqual({ kind: 'command', command })
    expect(searchPalette([command], [], 'last week', 'last week', [], undefined, true).rows.map(r => r.kind)).toEqual(['ask'])
  })
  it('recognizes single days on both daylight-saving transitions', () => {
    const saved = process.env.TZ
    try {
      process.env.TZ = 'America/Los_Angeles'
      for (const query of ['March 8, 2026', 'November 1, 2026']) {
        const date = parseSearchQuery(query, options).date!
        expect(date.end - date.start).not.toBe(24 * 60 * 60 * 1000)
        expect(searchDateCommand(date, query)?.at).toBe(date.start)
      }
    } finally {
      if (saved === undefined) delete process.env.TZ
      else process.env.TZ = saved
    }
  })
})

describe('search filters', () => {
  it('shows a compact range pill and highlights and removes the complete range', () => {
    const query = 'planning from Jun 8 to Jun 10'
    const parsed = parseSearchQuery(query, { now: new Date(2026, 6, 1), locale: 'en-US' })
    expect(searchDateLabel(parsed.date!, 'en-US')).toBe(new Intl.DateTimeFormat('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    }).formatRange(new Date(2026, 5, 8), new Date(2026, 5, 10)))
    expect(searchFilterHighlights(query, [], parsed.dateSpan)).toEqual([
      { text: 'planning ' }, { text: 'from Jun 8 to Jun 10', kind: 'date' },
    ])
    expect(removeSearchSpan(query, parsed.dateSpan!)).toBe('planning')
  })

  it('highlights people and dates in place without changing the original input', () => {
    const query = 'notes with Riley Example today'
    const people = matchSearchPeople(query, [person])
    const date = parseSearchQuery(people.text)
    const parts = searchFilterHighlights(query, people.matches, date.dateSpan)
    expect(parts).toEqual([
      { text: 'notes with ' }, { text: person.name, kind: 'person' },
      { text: ' ' }, { text: 'today', kind: 'date' },
    ])
    expect(parts.map(p => p.text).join('')).toBe(query)
    expect(removeSearchSpan(query, people.matches[0])).toBe('notes with today')
    expect(removeSearchSpan(query, date.dateSpan!)).toBe('notes with Riley Example')
  })

  it.each([person.name, person.email, 'today', `${person.name} today`, `${person.name} settings`])('hides commands for the filter %s, even without remaining words', query => {
    const people = matchSearchPeople(query, [person])
    const date = parseSearchQuery(people.text)
    const filtered = !!date.date || people.matches.length > 0
    const palette = searchPalette(commands, [{ confident: true }], query, query, [], undefined, filtered)
    expect(palette.rows.map(r => r.kind)).toEqual(['ask', 'meeting'])
    expect(palette.rows[palette.active].kind).toBe('meeting')
  })

  it('names the filters with no matches while keeping Ask available and selected', () => {
    expect(searchFilterEmptyMessage([person])).toBe('No matching meetings with Riley Example.')
    expect(searchFilterEmptyMessage([], 'Monday')).toBe('No matching meetings on Monday.')
    expect(searchFilterEmptyMessage([person], 'Monday')).toBe('No matching meetings with Riley Example on Monday.')
    expect(searchFilterEmptyMessage([])).toBeUndefined()
    const palette = searchPalette(commands, [], person.name, person.name, [], undefined, true)
    expect(palette.rows).toEqual([{ kind: 'ask', query: person.name }])
    expect(palette.active).toBe(0)
  })

  it('restores ordinary commands after filter text is deleted', () => {
    const query = removeSearchSpan(person.name, matchSearchPeople(person.name, [person]).matches[0])
    expect(searchFilterHighlights(query, [])).toEqual([])
    expect(searchPalette(commands, [], query).rows.map(r => r.kind)).toEqual(['command'])
  })
})
