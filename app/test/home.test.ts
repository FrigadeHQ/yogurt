import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readAgendaOpen, saveAgendaOpen } from '../src/renderer/src/agenda'
import { Home } from '../src/renderer/src/screens/Home'
import { pickNext } from '../src/shared/comingUp'
import { loadUpTo } from '../src/renderer/src/paging'
import { landOnHeading, resolveMeetingDate } from '../src/renderer/src/meetingDateJump'
import type { CalEvent } from '../src/shared/types'

vi.mock('../src/renderer/src/components/LoadingContent', () => ({ LoadingContent: () => null }))

const MIN = 60_000
const ev = (id: string, start: number, end: number): CalEvent => ({ id, title: id, start, end, attendees: [], url: null })

describe('pickNext', () => {
  const now = 1_000 * MIN
  it('picks the one about to start over a long one already running', () => {
    expect(pickNext([ev('allday', now - 120 * MIN, now + 240 * MIN), ev('soon', now + 5 * MIN, now + 35 * MIN)], now)).toBe('soon')
  })
  it('picks the one that just started over one running for a while', () => {
    expect(pickNext([ev('old', now - 50 * MIN, now + 10 * MIN), ev('new', now - 2 * MIN, now + 28 * MIN)], now)).toBe('new')
  })
  it('picks the soonest of those starting', () => {
    expect(pickNext([ev('b', now + 12 * MIN, now + 40 * MIN), ev('a', now + 3 * MIN, now + 30 * MIN)], now)).toBe('a')
  })
  it('none when nothing starts within 15 minutes or is on', () => {
    expect(pickNext([ev('later', now + 40 * MIN, now + 70 * MIN)], now)).toBeUndefined()
  })
})

describe('loadUpTo', () => {
  type C = { id: string; startedAt: number }
  const all: C[] = Array.from({ length: 1234 }, (_, i) => ({ id: `m${String(i).padStart(4, '0')}`, startedAt: 10_000 - i }))
  // like main: newest first, at most 1000 a call
  const fetch = async ({ before, limit }: { before?: { at: number; id: string }; limit: number }) => {
    const from = before ? all.findIndex((c) => c.startedAt < before.at) : 0
    return all.slice(from, from + Math.min(limit, 1000))
  }
  it('loads past the cap of one call, in order, and says when more remain', async () => {
    const r = await loadUpTo(fetch, 1100, 40)
    expect(r.cards.map((c) => c.id)).toEqual(all.slice(0, 1100).map((c) => c.id))
    expect(r.more).toBe(true)
  })
  it('loads at least a page, and says when the end was reached', async () => {
    const r = await loadUpTo(fetch, 0, 40)
    expect(r.cards).toHaveLength(40)
    const end = await loadUpTo(fetch, 5000, 40)
    expect(end.cards).toHaveLength(1234)
    expect(end.more).toBe(false)
  })
})

describe('Go to a meeting day', () => {
  afterEach(() => vi.unstubAllGlobals())
  const at = (day: number, hour = 0) => new Date(2026, 10, day, hour).getTime()
  const cards = (days: number[]) => days.map(d => ({ startedAt: at(d, 23) }))
  const jump = (day: number, days: number[], more: boolean) => resolveMeetingDate(at(day), cards(days), more, at(15, 12))
  const key = (day: number) => new Date(at(day)).toDateString()
  it('lands on the exact local day, including today and meetings late in the day', () => {
    for (const day of [15, 11]) expect(jump(day, [15, 12, 11, 11, 8], true)).toEqual({ kind: 'day', key: key(day) })
  })
  it('chooses the closest calendar day in either direction, preferring the earlier day on a tie', () => {
    expect(jump(11, [14, 12, 6, 4], true)).toEqual({ kind: 'day', key: key(12) })
    expect(jump(11, [14, 10, 6], true)).toEqual({ kind: 'day', key: key(10) })
    expect(jump(11, [12, 10], true)).toEqual({ kind: 'day', key: key(10) })
    expect(jump(15, [11, 8], true)).toEqual({ kind: 'day', key: key(11) })
    const aroundMidnight = [{ startedAt: at(2) }, { startedAt: at(0) }]
    expect(resolveMeetingDate(at(1, 23), aroundMidnight, false, at(15))).toEqual({ kind: 'day', key: key(0) })
  })
  it('pages until the closest day is known and lands at the bottom for dates before the library', () => {
    expect(jump(4, [14, 10], true)).toEqual({ kind: 'page' })
    expect(jump(4, [14, 10, 7, 5], true)).toEqual({ kind: 'page' })
    expect(jump(4, [14, 10, 7, 5, 4], true)).toEqual({ kind: 'day', key: key(4) })
    expect(jump(4, [14, 10, 7, 5, 1], false)).toEqual({ kind: 'day', key: key(5) })
    expect(jump(3, [14, 10, 7, 5, 4], false)).toEqual({ kind: 'bottom', key: key(4) })
    expect(jump(3, [], false)).toEqual({ kind: 'empty' })
  })
  it('sends a future date directly to the top regardless of the loaded meetings', () => {
    for (const days of [[15, 12], [12], []]) expect(jump(16, days, true)).toEqual({ kind: 'top' })
  })
  it.each([false, true])('limits travel to one viewport going back to the top without highlighting (reduced %s)', reduced => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: reduced }) })
    vi.stubGlobal('performance', { now: () => 0 })
    let frame: FrameRequestCallback | undefined
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frame = fn; return 1 })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const root = Object.assign(new EventTarget(), { scrollTop: 3200, clientHeight: 500 })
    const heading = { focus: vi.fn(), animate: vi.fn() }
    const cleanup = landOnHeading(root as HTMLElement, heading as unknown as HTMLElement, 0)
    expect(heading.focus).toHaveBeenCalledWith({ preventScroll: true })
    if (reduced) expect(frame).toBeUndefined()
    else {
      expect(root.scrollTop).toBe(500)
      frame!(150)
      expect(root.scrollTop).toBeGreaterThan(0)
      expect(root.scrollTop).toBeLessThan(250)
      frame!(300)
    }
    expect(root.scrollTop).toBe(0)
    expect(heading.animate).not.toHaveBeenCalled()
    cleanup()
  })
})

describe('Home Agenda', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('starts shown and restores the chosen layout when Home remounts', () => {
    const stored = new Map<string, string>()
    const capabilities = { calendar: true }
    vi.stubGlobal('window', {
      yogurt: { capabilities }, matchMedia: () => ({ matches: true }),
      localStorage: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => stored.set(k, v) },
    })
    const render = () => renderToStaticMarkup(createElement(Home, { open() {}, openSearch() {} }))
    expect(readAgendaOpen()).toBe(true)
    expect(render()).toContain('class="native-agenda"')
    saveAgendaOpen(false)
    expect(render()).toContain('class="home-agenda-panel" inert=""')
    expect(render()).not.toContain('class="native-agenda"')
    saveAgendaOpen(true)
    expect(render()).toContain('class="native-agenda"')
    capabilities.calendar = false
    expect(render()).toContain('native-home no-agenda')
    expect(render()).not.toContain('id="home-agenda"')
  })
})
