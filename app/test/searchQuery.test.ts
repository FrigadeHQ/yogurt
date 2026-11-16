import { describe, expect, it } from 'vitest'
import { oneEdit, parseSearchQuery } from '../src/shared/searchQuery'

const now = new Date(2026, 10, 12, 14)
const parse = (query: string, locale = 'en-US') => parseSearchQuery(query, { now, locale })
const at = (month: number, day: number, year = 2026) => new Date(year, month - 1, day).getTime()

describe('search dates', () => {
  it.each(['nov 10', 'november 10', '11/10', 'Nov. 10th', 'nov 10 2026'])('extracts %s from the words', date => {
    expect(parse(`standup ${date}`)).toMatchObject({ text: 'standup', words: ['standup'], date: { start: at(11, 10), end: at(11, 11) } })
  })

  it.each([
    ['jun 8 to jun 9', 10], ['from Jun 8 to Jun 10', 11], ['jun 8 - 10', 11],
    ['June eighth to June tenth', 11],
  ])('includes both endpoints of %s and removes the whole range', (range, end) => {
    const query = `planning ${range} notes`
    const parsed = parse(query)
    expect(parsed.date).toEqual({ start: at(6, 8), end: at(6, end) })
    expect(query.slice(parsed.dateSpan!.start, parsed.dateSpan!.end)).toBe(range)
    expect(parsed.text).toBe('planning notes')
  })

  it('marks only a complete recognized date without changing the typed text', () => {
    for (const query of ['Octob', 'October', 'October roadmap']) expect(parse(query).dateSpan).toBeUndefined()
    const query = 'standup October 28 notes'
    const parsed = parse(query)
    expect(query.slice(parsed.dateSpan!.start, parsed.dateSpan!.end)).toBe('October 28')
    expect(parsed.text).toBe('standup notes')
    expect(parsed.date).toEqual({ start: at(10, 28), end: at(10, 29) })
    const relative = 'review last week'
    const span = parse(relative).dateSpan!
    expect(relative.slice(span.start, span.end)).toBe('last week')
  })

  it('uses the locale for numeric dates while still accepting month-day names', () => {
    expect(parse('standup 10/11', 'en-GB').date).toEqual(parse('standup 11/10').date)
    expect(parse('11/10', 'en-GB').date).toEqual({ start: at(10, 11), end: at(10, 12) })
    expect(parse('11/20', 'en-GB').date).toBeUndefined()
    expect(parse('standup nov 10', 'en-GB')).toMatchObject({ text: 'standup', date: { start: at(11, 10), end: at(11, 11) } })
    expect(parse('November 10', 'en-IN').date).toEqual({ start: at(11, 10), end: at(11, 11) })
    expect(parse('standup 10 nov', 'en-GB')).toMatchObject({ text: 'standup', date: { start: at(11, 10), end: at(11, 11) } })
  })

  it.each([
    ['today', 11, 12, 13], ['yesterday', 11, 11, 12],
    ['tuesday', 11, 10, 11], ['last tuesday', 11, 10, 11],
    ['thursday', 11, 12, 13], ['last thursday', 11, 5, 6],
    ['this week', 11, 8, 15], ['last week', 11, 1, 8],
    ['last friday', 11, 6, 7], ['3 days ago', 11, 9, 10],
    ['this month', 11, 1, 31], ['last month', 10, 1, 32],
    ['past 3 days', 11, 10, 13], ['last 3 days', 11, 10, 13],
    ['past 2 weeks', 10, 30, 44], ['last 2 weeks', 10, 30, 44],
    ['in october', 10, 1, 32],
  ])('parses %s as a local calendar range', (query, month, start, end) => {
    expect(parse(query).date).toEqual({ start: at(month, start), end: at(month, end) })
    expect(parse(query).words).toEqual([])
  })

  it('uses the locale week start and handles year boundaries', () => {
    expect(parse('last week', 'en-GB').date).toEqual({ start: at(11, 2), end: at(11, 9) })
    expect(parse('december 31').date).toEqual({ start: at(12, 31, 2025), end: at(1, 1) })
    expect(parse('in december').date).toEqual({ start: at(12, 1, 2025), end: at(1, 1) })
    expect(parse('nov 10 2025').date?.start).toBe(at(11, 10, 2025))
    expect(parse('dec 30 to jan 2').date).toEqual({ start: at(12, 30, 2025), end: at(1, 3) })
    expect(parse('jun 8 to jun 9 2025').date).toEqual({ start: at(6, 8, 2025), end: at(6, 10, 2025) })
    expect(parseSearchQuery('last month', { now: new Date(2026, 0, 5) }).date).toEqual({ start: at(12, 1, 2025), end: at(1, 1) })
  })

  it('uses Monday when locale week information is unavailable', () => {
    const original = Object.getOwnPropertyDescriptors(Intl.Locale.prototype)
    try {
      Object.defineProperty(Intl.Locale.prototype, 'getWeekInfo', { value: undefined, configurable: true })
      Object.defineProperty(Intl.Locale.prototype, 'weekInfo', { value: undefined, configurable: true })
      expect(parse('this week', 'en-US').date).toEqual({ start: at(11, 9), end: at(11, 16) })
    } finally {
      for (const key of ['getWeekInfo', 'weekInfo']) {
        if (original[key]) Object.defineProperty(Intl.Locale.prototype, key, original[key])
        else Reflect.deleteProperty(Intl.Locale.prototype, key)
      }
    }
  })

  it.each(['may I ask', 'march on', 'sunday standup', 'first week of November'])('keeps %s as ordinary search text', query => {
    expect(parse(query).date).toBeUndefined()
    expect(parse(query).text).toBe(query)
  })

  it('keeps explicit weekday searches while resolving an ambiguous weekday into the past', () => {
    expect(parse('sunday').date).toEqual({ start: at(11, 8), end: at(11, 9) })
    expect(parse('planning on sunday').date).toEqual({ start: at(11, 8), end: at(11, 9) })
  })

  it.each([['fr', 'hier'], ['de', 'gestern'], ['es', 'ayer'], ['ja', '昨日'], ['ru', 'вчера'], ['zh-CN', '昨天'], ['it', 'ieri']])('uses the app language %s independently of the regional locale', (language, query) => {
    expect(parseSearchQuery(query, { now, locale: 'en-US', language }).date).toEqual({ start: at(11, 11), end: at(11, 12) })
  })

  it('falls back to English for unsupported languages and preserves regional numeric dates', () => {
    expect(parseSearchQuery('yesterday', { now, language: 'ko' }).date).toEqual({ start: at(11, 11), end: at(11, 12) })
    expect(parseSearchQuery('10/11', { now, locale: 'en-GB', language: 'en' }).date).toEqual({ start: at(11, 10), end: at(11, 11) })
  })

  it('does not turn invalid dates or ordinary words into filters', () => {
    for (const query of ['nov 31', '2/30', '13/10', 'may we meet', 'october roadmap', 'tuesdays', 'nothing']) {
      expect(parse(query).date).toBeUndefined()
      expect(parse(query).text).toBe(query)
    }
    expect(parse('feb 29 2024').date).toEqual({ start: at(2, 29, 2024), end: at(3, 1, 2024) })
    expect(parse('feb 29 2025').date).toBeUndefined()
  })

  it('uses consecutive local midnights across daylight-saving transitions', () => {
    const saved = process.env.TZ
    try {
      process.env.TZ = 'America/Los_Angeles'
      const spring = parseSearchQuery('today', { now: new Date(2026, 2, 8, 12) }).date!
      const fall = parseSearchQuery('today', { now: new Date(2026, 10, 1, 12) }).date!
      expect(spring.end - spring.start).toBe(23 * 60 * 60 * 1000)
      expect(fall.end - fall.start).toBe(25 * 60 * 60 * 1000)
      const range = parseSearchQuery('mar 7 to mar 9', { now: new Date(2026, 2, 10) }).date!
      expect(range.end - range.start).toBe(71 * 60 * 60 * 1000)
    } finally {
      if (saved === undefined) delete process.env.TZ
      else process.env.TZ = saved
    }
  })

  it('ignores connecting words and leaves the date removable without losing the rest', () => {
    const parsed = parse('meeting with Robin about the launch on nov 10')
    expect(parsed.words).toEqual(['robin', 'launch'])
    expect(parsed.text).toBe('meeting with Robin about the launch on')
    expect(parse(parsed.text).date).toBeUndefined()
  })
})

describe('light typo tolerance', () => {
  it.each(['standap', 'stanup', 'standupp'])('accepts one edit in %s', word => {
    expect(oneEdit(word, 'standup')).toBe(true)
  })
  it('rejects short words and multiple edits', () => {
    expect(oneEdit('plan', 'play')).toBe(false)
    expect(oneEdit('stendap', 'standup')).toBe(false)
    expect(oneEdit('stnadup', 'standup')).toBe(false)
  })
})
