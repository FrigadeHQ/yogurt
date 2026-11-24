import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Meeting } from '../src/shared/types'

const h = vi.hoisted(() => ({ current: null as any }))
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState: (initial: any) => {
    const ctx = h.current, index = ctx.index++
    if (!(index in ctx.values)) ctx.values[index] = typeof initial === 'function' ? initial() : initial
    return [ctx.values[index], (next: any) => { ctx.values[index] = typeof next === 'function' ? next(ctx.values[index]) : next }]
  },
  useCallback: (callback: any) => { const ctx = h.current, index = ctx.index++; return ctx.values[index] ??= callback },
  useEffect: (run: () => unknown, deps: unknown[]) => { const ctx = h.current; ctx.pending.push({ index: ctx.index++, run, deps }) },
}))
const cleanups = new Set<() => void>()
function renderer(hook: typeof import('../src/renderer/src/useNoteCalendar').useNoteCalendar) {
  const ctx = { index: 0, values: [] as any[], pending: [] as any[], effects: new Map<number, any>() }
  const unmount = () => { for (const effect of ctx.effects.values()) effect.cleanup?.(); ctx.effects.clear() }
  cleanups.add(unmount)
  return { unmount, render: (m: Meeting) => {
    h.current = ctx; ctx.index = 0; ctx.pending = []
    const result = hook(m)
    for (const effect of ctx.pending) {
      const old = ctx.effects.get(effect.index)
      if (!old || effect.deps.some((value: unknown, i: number) => !Object.is(value, old.deps[i]))) {
        old?.cleanup?.()
        ctx.effects.set(effect.index, { deps: effect.deps, cleanup: effect.run() })
      }
    }
    return result
  } }
}
const at = +new Date(2026, 10, 16, 10)
const meeting = { id: 'note', eventId: 'event', startedAt: at } as Meeting
const event = { id: 'event', title: 'Review', start: at, end: at + 1_800_000, attendees: [], url: 'https://call.example/meeting', calendar: { id: 'work', name: 'Work' } }
const dayValue = { status: 'granted', events: [event] }
const listValue = { status: 'granted', calendars: [{ id: 'work', color: '#438879' }, { id: 'invalid', color: 'invalid' }] }
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
function deferred() { let resolve!: (value: any) => void; const promise = new Promise<any>(done => { resolve = done }); return { promise, resolve } }
function setup(day = vi.fn().mockResolvedValue(dayValue), list = vi.fn().mockResolvedValue(listValue)) {
  const changes = new Set<() => void>(), focus = new Set<() => void>()
  vi.stubGlobal('window', { yogurt: { capabilities: { calendar: true }, calendar: { day, list, onChange: (fn: () => void) => { changes.add(fn); return () => changes.delete(fn) } } }, addEventListener: (_event: string, fn: () => void) => focus.add(fn), removeEventListener: (_event: string, fn: () => void) => focus.delete(fn) })
  return { day, list, change: () => [...changes].forEach(fn => fn()), focus: () => [...focus].forEach(fn => fn()) }
}
beforeEach(() => vi.resetModules())
afterEach(() => { cleanups.forEach(fn => fn()); cleanups.clear(); vi.unstubAllGlobals() })
it('prefetches a complete linked event and color together before the popover is opened', async () => {
  const day = deferred(), list = deferred()
  const api = setup(vi.fn(() => day.promise), vi.fn(() => list.promise))
  const { useNoteCalendar } = await import('../src/renderer/src/useNoteCalendar')
  const note = renderer(useNoteCalendar)
  expect(note.render(meeting).details).toBeUndefined()
  expect(api.day).toHaveBeenCalledWith(at, 'link-event')
  expect(api.list).toHaveBeenCalledOnce()
  day.resolve(dayValue); await flush()
  expect(note.render(meeting).details).toBeUndefined()
  list.resolve(listValue); await flush()
  expect(note.render(meeting).details).toMatchObject({ result: dayValue, colors: { work: '#438879' } })
  expect(note.render(meeting).details!.colors).not.toHaveProperty('invalid')
  expect(api.day).toHaveBeenCalledOnce()
})
it('shares pending and completed calendar lists across notes and invalidates on calendar changes and focus', async () => {
  const api = setup()
  const { useNoteCalendar } = await import('../src/renderer/src/useNoteCalendar')
  const first = renderer(useNoteCalendar), second = renderer(useNoteCalendar)
  first.render(meeting); second.render({ ...meeting, id: 'other' }); await flush()
  expect(api.list).toHaveBeenCalledOnce()
  first.unmount(); second.unmount()
  const next = renderer(useNoteCalendar)
  next.render(meeting); await flush()
  expect(api.list).toHaveBeenCalledOnce()
  api.change(); next.render(meeting); await flush()
  expect(api.list).toHaveBeenCalledTimes(2)
  api.focus(); next.render(meeting); await flush()
  expect(api.list).toHaveBeenCalledTimes(3)
})
it('ignores old note reads and makes no requests for unlinked notes or unsupported computers', async () => {
  const old = deferred()
  const api = setup(vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(dayValue))
  const { useNoteCalendar } = await import('../src/renderer/src/useNoteCalendar')
  const note = renderer(useNoteCalendar)
  note.render({ ...meeting, eventId: null })
  expect(api.day).not.toHaveBeenCalled(); expect(api.list).not.toHaveBeenCalled()
  note.render(meeting)
  const next = { ...meeting, id: 'next', eventId: 'next-event' }
  note.render(next); await flush()
  const current = note.render(next).details
  old.resolve({ status: 'denied', events: [] }); await flush()
  expect(note.render(next).details).toBe(current)
  expect(note.render(meeting).details).toBeUndefined()
  window.yogurt.capabilities.calendar = false
  const calls = api.day.mock.calls.length
  expect(note.render(next).details).toBeUndefined()
  expect(api.day).toHaveBeenCalledTimes(calls)
})
it('keeps call details when the calendar list fails, and retries failures without caching them', async () => {
  const api = setup(vi.fn().mockResolvedValue(dayValue), vi.fn().mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValue(listValue))
  const { useNoteCalendar } = await import('../src/renderer/src/useNoteCalendar')
  const note = renderer(useNoteCalendar)
  note.render(meeting); await flush()
  expect(note.render(meeting).details).toMatchObject({ result: dayValue, colors: {} })
  note.render(meeting).refresh(); note.render(meeting); await flush()
  expect(note.render(meeting).details!.colors.work).toBe('#438879')
  expect(api.list).toHaveBeenCalledTimes(2)
})
it('reports event-read failures and retains settled details while refreshing', async () => {
  const next = deferred()
  const api = setup(vi.fn().mockResolvedValueOnce(dayValue).mockReturnValueOnce(next.promise).mockRejectedValue(new Error('Unavailable')))
  const { useNoteCalendar } = await import('../src/renderer/src/useNoteCalendar')
  const note = renderer(useNoteCalendar)
  note.render(meeting); await flush()
  const ready = note.render(meeting)
  ready.refresh()
  expect(note.render(meeting).details).toBe(ready.details)
  next.resolve(dayValue); await flush()
  api.focus(); note.render(meeting); await flush()
  expect(note.render(meeting).details!.result).toEqual({ status: 'error', events: [] })
})
