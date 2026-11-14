import { describe, expect, it } from 'vitest'
import { isAppRoute } from '../src/shared/routes'
import { shiftDay, stepAgendaDay, weekDates, eventPhase } from '../src/renderer/src/agenda'

describe('workspace routes', () => {
  it('accepts only local destinations and meeting IDs', () => {
    for (const route of ['', '/meetings', '/chat', '/trash', '/settings', '/settings/recordings', '/settings/notes-model', '/note/a-123', '/chat/c-123', '/folder/b-456']) expect(isAppRoute(route)).toBe(true)
    for (const route of [null, 1, '/note/', '/note/../secrets', '/note/a?x=1', '/folder/', '/folder/../x', '/folders', '/settings/unknown', 'https://example.com', '/other']) expect(isAppRoute(route)).toBe(false)
  })
})
describe('agenda dates', () => {
  it.each([
    ['forward inside the week', [2026, 10, 18], 1, [2026, 10, 19], false],
    ['backward inside the week', [2026, 10, 18], -1, [2026, 10, 17], false],
    ['off the first day', [2026, 10, 15], -1, [2026, 10, 14], true],
    ['off the last day', [2026, 10, 21], 1, [2026, 10, 22], true],
    ['across a month', [2026, 10, 30], 1, [2026, 11, 1], false],
    ['across a year', [2026, 11, 31], 1, [2027, 0, 1], false],
    ['across a year and week', [2022, 11, 31], 1, [2023, 0, 1], true],
  ] as const)('steps %s', (_name, from, offset, to, movesWeek) => {
    const selected = new Date(from[0], from[1], from[2], 12).getTime()
    const weekAnchor = weekDates(selected)[0]
    const next = new Date(to[0], to[1], to[2], 12).getTime()
    expect(stepAgendaDay(selected, weekAnchor, offset)).toEqual({ selected: next, weekAnchor: movesWeek ? next : weekAnchor })
  })
  it('steps through both daylight-saving changes at local noon', () => {
    const saved = process.env.TZ
    try {
      process.env.TZ = 'America/Los_Angeles'
      for (const [month, day] of [[2, 7], [9, 31]]) {
        const selected = new Date(2026, month, day, 12).getTime()
        const next = new Date(2026, month, day + 1, 12).getTime()
        expect(stepAgendaDay(selected, selected, 1)).toEqual({ selected: next, weekAnchor: next })
        expect(stepAgendaDay(next, next, -1)).toEqual({ selected, weekAnchor: selected })
      }
    } finally {
      if (saved === undefined) delete process.env.TZ
      else process.env.TZ = saved
    }
  })
  it('keeps local dates and noon across the daylight-saving boundary', () => {
    const start = new Date(2026, 9, 31, 12).getTime()
    const next = new Date(shiftDay(start, 1))
    expect([next.getMonth(), next.getDate(), next.getHours()]).toEqual([10, 1, 12])
    expect(new Date(shiftDay(start, 2)).getDate()).toBe(2)
    const week = weekDates(next.getTime()).map((at) => new Date(at))
    expect(week.map((d) => d.getDay())).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(week.every((d) => d.getHours() === 12)).toBe(true)
    expect(new Date(shiftDay(new Date(2026, 11, 31, 12).getTime(), 1)).getFullYear()).toBe(2027)
  })
  it('uses the actual start and end to label meetings, including exact boundaries', () => {
    const event = { start: 100, end: 200 }
    expect(eventPhase(event, 99)).toBe('upcoming')
    expect(eventPhase(event, 100)).toBe('live')
    expect(eventPhase(event, 199)).toBe('live')
    expect(eventPhase(event, 200)).toBe('past')
  })
})
