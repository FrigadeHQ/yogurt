import { describe, expect, it } from 'vitest'
import { NEAR_MS, evidenceName, lineTurn, splitPlan, type SplitRow } from '../src/main/diarize/align'
import type { Turn } from '../src/main/diarize/rttm'

const identity = (t: string) => t
const w = (text: string, startMs: number, endMs: number) => ({ text, startMs, endMs })
const row = (id: number, text: string, startMs: number, endMs: number, speaker: string | null = null): SplitRow =>
  ({ id, text, startMs, endMs, speaker, words: text.split(' ').map((t, i, a) => w(t, startMs + i * Math.round((endMs - startMs) / a.length), startMs + (i + 1) * Math.round((endMs - startMs) / a.length))) })
const turns: Turn[] = [{ key: 'v1', startMs: 0, endMs: 1000 }, { key: 'v2', startMs: 2000, endMs: 4000 }]

describe('splitPlan', () => {
  it('splits one line across a speaker change, one row per voice', () => {
    const { keep, runs } = splitPlan([row(1, 'hello there friend', 0, 3000)], turns, identity)
    expect(keep).toEqual([])
    expect(runs.map(r => [r.key, r.text])).toEqual([['v1', 'hello'], ['v2', 'there friend']])
    expect(runs[0].startMs).toBe(0)
    expect(runs[1].endMs).toBe(3000)
    expect(runs.every(r => r.lineIds.includes(1))).toBe(true)
    expect(runs[0].words.map(x => x.text)).toEqual(['hello'])
  })
  it('joins consecutive words of one voice across line boundaries', () => {
    const { runs } = splitPlan([row(1, 'hello there', 0, 2000), row(2, 'friend', 2400, 3000)], turns, identity)
    expect(runs.map(r => [r.key, r.text])).toEqual([['v1', 'hello'], ['v2', 'there friend']])
    expect(runs[1].lineIds).toEqual([1, 2])
  })
  it('words with no turn inside 2 s stay with their line: untouched rows keep their id', () => {
    const far: Turn[] = [{ key: 'v1', startMs: 0, endMs: 500 }]
    const { keep, runs } = splitPlan([row(1, 'hello', 0, 500), row(2, 'lost words here', 10000, 12000)], far, identity)
    expect(keep).toEqual([2])
    expect(runs.map(r => r.key)).toEqual(['v1'])
  })
  it('a line with both assigned and unassigned words keeps an unsplit remainder', () => {
    const mid: Turn[] = [{ key: 'v1', startMs: 0, endMs: 400 }]
    const { keep, runs } = splitPlan([row(1, 'hello lost words', 0, 1200)], mid, identity)
    expect(keep).toEqual([])
    expect(runs.map(r => [r.key, r.text])).toEqual([['v1', 'hello'], [null, 'lost words']])
    expect(runs[1].speaker).toBeNull()
  })
  it("a run's evidence name is the duration-weighted majority of its source lines' call names", () => {
    const ann = row(1, 'hello there friend', 0, 3000, 'Ann Lee')
    const { runs } = splitPlan([ann], turns, identity)
    expect(runs.map(r => r.speaker)).toEqual(['Ann Lee', 'Ann Lee'])
    const mixed = [{ ...row(1, 'a b', 0, 2000, 'Ann Lee') }, { ...row(2, 'c d', 2000, 4000, 'Bo Park') }]
    const cross: Turn[] = [{ key: 'v1', startMs: 0, endMs: 3000 }]
    expect(splitPlan(mixed, cross, identity).runs.map(r => r.speaker)).toEqual(['Ann Lee'])
  })
  it('glues punctuation without a space, like the live view does', () => {
    const glued: SplitRow = { id: 1, text: 'Sure.', startMs: 0, endMs: 500, speaker: null, words: [w('Sure', 0, 400), w('.', 400, 500)] }
    expect(splitPlan([glued], [{ key: 'v1', startMs: 0, endMs: 500 }], identity).runs[0].text).toBe('Sure.')
  })
  it('passes the text through the spell normalizer', () => {
    expect(splitPlan([row(1, 'aple', 0, 400)], [{ key: 'v1', startMs: 0, endMs: 400 }], t => t.replace('aple', 'apple')).runs[0].text).toBe('apple')
  })
  it('lines whisper gave no words for fall back to whole-line max overlap', () => {
    const noWords: SplitRow = { id: 1, text: 'old line', startMs: 1000, endMs: 3000, speaker: 'Ann Lee' }
    const { keep, runs } = splitPlan([noWords], turns, identity)
    expect(keep).toEqual([1])
    expect(lineTurn(noWords, turns)?.key).toBe('v2')
    expect(lineTurn({ startMs: 10000, endMs: 11000 }, turns)).toBeNull()
  })
})

describe('evidenceName', () => {
  it('picks the named claim with the most speech', () => {
    expect(evidenceName([{ name: null, ms: 900 }, { name: 'Ann', ms: 500 }, { name: 'Bo', ms: 400 }])).toBe('Ann')
  })
  it('ignores null (Them) claims entirely', () => {
    expect(evidenceName([{ name: null, ms: 900 }, { name: 'Ann', ms: 100 }])).toBe('Ann')
    expect(evidenceName([{ name: null, ms: 900 }])).toBeNull()
  })
  it('ties go to the earliest claim', () => {
    expect(evidenceName([{ name: 'Ann', ms: 400 }, { name: 'Bo', ms: 400 }])).toBe('Ann')
  })
})
