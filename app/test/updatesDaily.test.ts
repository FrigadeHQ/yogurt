import { expect, it } from 'vitest'
import { updateCheckDue } from '../src/main/updates'

const at = (iso: string) => Date.parse(iso)
const HOUR = 60 * 60 * 1000
const due = (now: string, last: number | undefined, o: { jitterMs?: number; on?: boolean } = {}) =>
  updateCheckDue({ now: at(now), last, jitterMs: o.jitterMs ?? 0, on: o.on ?? true })

it('a copy that never checked checks now', () => {
  expect(due('2026-11-23T15:00:00Z', undefined)).toBe(true)
})

it('once a day: not again on the same UTC day', () => {
  expect(due('2026-11-23T23:59:00Z', at('2026-11-23T00:05:00Z'))).toBe(false)
  expect(due('2026-11-23T10:00:00Z', at('2026-11-23T09:00:00Z'))).toBe(false)
})

it('the next UTC day checks again, a little after midnight for each copy', () => {
  const last = at('2026-11-23T23:30:00Z')
  expect(due('2026-11-24T00:01:00Z', last)).toBe(true)
  expect(due('2026-11-24T00:20:00Z', last, { jitterMs: 40 * 60 * 1000 })).toBe(false)
  expect(due('2026-11-24T00:41:00Z', last, { jitterMs: 40 * 60 * 1000 })).toBe(true)
})

it('more than 24 hours since the last check always checks', () => {
  expect(due('2026-11-25T09:00:00Z', at('2026-11-23T09:00:00Z'), { jitterMs: 59 * 60 * 1000 })).toBe(true)
  expect(due('2026-11-24T00:30:00Z', at('2026-11-23T00:29:00Z'), { jitterMs: 59 * 60 * 1000 })).toBe(true)
})

it('a clock that went backwards (last check in the future) checks, instead of waiting for that date', () => {
  expect(due('2026-11-23T10:00:00Z', at('2027-01-01T00:00:00Z'))).toBe(true)
  expect(due('2026-11-23T10:00:00Z', at('2026-11-23T10:05:00Z'))).toBe(true)
})

it('a broken saved time counts as never checked', () => {
  expect(due('2026-11-23T10:00:00Z', Number.NaN)).toBe(true)
})

it('with automatic updates off, it never checks by itself', () => {
  expect(due('2026-11-23T15:00:00Z', undefined, { on: false })).toBe(false)
  expect(due('2026-11-25T15:00:00Z', at('2026-11-23T09:00:00Z'), { on: false })).toBe(false)
})

it('the jitter stays within the first hour', () => {
  expect(due('2026-11-24T01:00:00Z', at('2026-11-23T12:00:00Z'), { jitterMs: 5 * HOUR })).toBe(true)
})
