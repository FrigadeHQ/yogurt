import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { citationHover } from '../src/renderer/src/citationHover'

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }))
afterEach(() => vi.useRealTimers())

function fixture() {
  let state = { open: false, pinned: null as string | null, triggerId: null as string | null }, until = 0, eligible = true
  const events: Array<{ action: string; id: string | null; at: number }> = []
  const hover = citationHover({
    state: () => state,
    show: id => { state = { ...state, open: true, triggerId: id }; events.push({ action: 'show', id, at: performance.now() }) },
    close: () => { state = { ...state, open: false }; until = performance.now() + 150; events.push({ action: 'close', id: state.triggerId, at: performance.now() }) },
    valid: () => eligible && !state.pinned,
    resuming: id => id === state.triggerId && performance.now() < until,
  })
  return { hover, events, state: () => state, eligible: (value: boolean) => { eligible = value }, pin: () => { state.pinned = state.triggerId } }
}

it('waits for 600 ms at rest, restarting when the pointer moves', () => {
  const f = fixture()
  f.hover.move('a'); vi.advanceTimersByTime(599); expect(f.events).toEqual([])
  f.hover.move('a'); vi.advanceTimersByTime(599); expect(f.events).toEqual([])
  vi.advanceTimersByTime(1); expect(f.state().open).toBe(true)
})

it.each(['text', 'fast', 'slow', 'card'] as const)('starts the same immediate exit from A to %s, before considering B', sequence => {
  const f = fixture()
  f.hover.move('a'); vi.advanceTimersByTime(600)
  if (sequence === 'card') { f.hover.cancel(); vi.advanceTimersByTime(100) }
  const left = performance.now()
  f.hover.move(sequence === 'text' ? null : 'b', true)
  expect(f.events.at(-1)).toEqual({ action: 'close', id: 'a', at: left })
  expect(f.state().open).toBe(false)
  if (sequence === 'slow') { vi.advanceTimersByTime(80); f.hover.move('b', true) }
  vi.advanceTimersByTime(179); expect(f.state().open).toBe(false)
  vi.advanceTimersByTime(1)
  expect(f.state().open).toBe(sequence !== 'text')
  if (sequence !== 'text') expect(f.state().triggerId).toBe('b')
  const opened = f.events.filter(e => e.action === 'show' && e.id === 'b')[0]
  if (opened) expect(opened.at - left).toBeGreaterThanOrEqual(180)
})

it('reverses an unfinished exit immediately and keeps a pin when moving away', () => {
  const f = fixture()
  f.hover.move('a'); vi.advanceTimersByTime(600); f.hover.move(null); vi.advanceTimersByTime(70)
  f.hover.move('a'); expect(f.state().open).toBe(true)
  expect(f.events.at(-1)?.at).toBe(670)
  f.pin(); f.hover.move('b', true); vi.advanceTimersByTime(1000)
  expect(f.state()).toEqual({ open: true, pinned: 'a', triggerId: 'a' })
})

it('expires warm intent, clears it after scrolling or selection, and rechecks eligibility before opening', () => {
  const f = fixture()
  f.hover.move('a'); vi.advanceTimersByTime(600); f.hover.move(null); vi.advanceTimersByTime(1100)
  f.hover.move('b', true); vi.advanceTimersByTime(180); expect(f.state().open).toBe(false)
  vi.advanceTimersByTime(420); expect(f.state().triggerId).toBe('b')
  f.hover.cancel(true); f.hover.move('a', true); vi.advanceTimersByTime(180); expect(f.state().open).toBe(false)
  f.eligible(false); vi.advanceTimersByTime(420); expect(f.state().open).toBe(false)
  f.hover.move('a'); f.hover.cancel(); vi.advanceTimersByTime(1000); expect(f.state().open).toBe(false)
})
