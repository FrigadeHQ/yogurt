import { describe, expect, it } from 'vitest'
import { CLAIM_MIN_MS, CLAIM_SHARE, nextSpeakerNumber, resolveNames, reuseKeys } from '../src/main/diarize/naming'
import type { Turn } from '../src/main/diarize/rttm'

describe('reuseKeys', () => {
  it('a new turn overlapping an old cluster by more than half its duration joins it', () => {
    const existing = [{ key: 'v1', startMs: 0, endMs: 5000 }]
    // endMs 5500 (brief had 6000: overlap exactly half, contradicting this test's title, the boundary test
    // below, and the strictly-more-than-half rule — see task-5-report.md)
    const turns: Turn[] = [{ key: 'a', startMs: 4000, endMs: 5500 }, { key: 'b', startMs: 8000, endMs: 9000 }]
    expect(reuseKeys(turns, existing).get('a')).toBe('v1')
    expect(reuseKeys(turns, existing).has('b')).toBe(false)
  })
  it('exactly half is not a reuse', () => {
    const existing = [{ key: 'v1', startMs: 0, endMs: 2000 }]
    expect(reuseKeys([{ key: 'a', startMs: 1000, endMs: 3000 }], existing).has('a')).toBe(false)
  })
})

describe('nextSpeakerNumber', () => {
  it('continues after the highest existing Speaker N, so a new voice never collides', () => {
    expect(nextSpeakerNumber([])).toBe(1)
    expect(nextSpeakerNumber(['Ann Lee', 'Speaker 1', 'Speaker 3'])).toBe(4)
  })
})

describe('resolveNames', () => {
  const cluster = (key: string, name: string | null, ms: number) => ({ key, claims: [{ name, ms }], total: ms })
  it(`keeps a call-app name claiming at least ${CLAIM_MIN_MS} ms and ${CLAIM_SHARE * 100}% of the cluster`, () => {
    expect(resolveNames([cluster('v1', 'Ann Lee', 3000)], { taken: [], startNumber: 1 })).toEqual([{ key: 'v1', speaker: 'Ann Lee' }])
    expect(resolveNames([cluster('v1', 'Ann Lee', 1999)], { taken: [], startNumber: 1 })).toEqual([{ key: 'v1', speaker: null }])
    expect(resolveNames([{ key: 'v1', claims: [{ name: 'Ann Lee', ms: 2000 }, { name: null, ms: 2000 }], total: 4000 }], { taken: [], startNumber: 1 }))
      .toEqual([{ key: 'v1', speaker: null }])
  })
  it('one person is one voice: a weaker cluster claiming the same name drops to Speaker N', () => {
    const a = { key: 'v1', claims: [{ name: 'Ann Lee', ms: 5000 }], total: 5000 }
    const b = { key: 'v2', claims: [{ name: 'Ann Lee', ms: 2500 }], total: 2500 }
    const out = resolveNames([a, b], { taken: [], startNumber: 1 })
    expect(out).toEqual([{ key: 'v1', speaker: 'Ann Lee' }, { key: 'v2', speaker: 'Speaker 1' }])
  })
  it('unnamed clusters number in first-appearance order; taken names are skipped', () => {
    const out = resolveNames([cluster('v1', null, 1000), cluster('v2', null, 1000)], { taken: ['Speaker 2'], startNumber: 3 })
    expect(out).toEqual([{ key: 'v1', speaker: 'Speaker 3' }, { key: 'v2', speaker: 'Speaker 4' }])
  })
  it(`reused (taken) names are not reassigned; a resumed meeting's numbers continue`, () => {
    const out = resolveNames([cluster('v1', 'Bo Park', 3000)], { taken: ['Bo Park'], startNumber: 2 })
    expect(out).toEqual([{ key: 'v1', speaker: 'Speaker 2' }])
  })
  it('named clusters do not consume numbers', () => {
    const out = resolveNames([cluster('v1', null, 1000), cluster('v2', 'Ann Lee', 3000)], { taken: [], startNumber: 5 })
    expect(out).toEqual([{ key: 'v1', speaker: 'Speaker 5' }, { key: 'v2', speaker: 'Ann Lee' }])
  })
})
