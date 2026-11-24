import { describe, expect, it } from 'vitest'
import { bubbles, clock, lineAt, recentRuns, stableKeys, turns, withLive } from '../src/shared/transcript'

const l = (track: 'me' | 'them', startMs: number, speaker: string | null = null, endMs = startMs + 2000) => ({ track, startMs, endMs, speaker, text: '' })

describe('clock', () => {
  it('shows minutes and seconds from the start of the meeting', () => {
    expect(clock(0)).toBe('0:00')
    expect(clock(500)).toBe('0:00')
    expect(clock(5200)).toBe('0:05')
    expect(clock(65_000)).toBe('1:05')
    expect(clock(59 * 60_000 + 59_999)).toBe('59:59')
  })
  it('shows hours past the first hour', () => {
    expect(clock(3_723_000)).toBe('1:02:03')
  })
  it('never shows a negative time', () => expect(clock(-300)).toBe('0:00'))
})

describe('turns', () => {
  it('keeps one person speaking in a row together', () => {
    const lines = [l('me', 0), l('me', 2500), l('them', 5000, 'A'), l('them', 8000, 'A'), l('me', 11_000)]
    expect(turns(lines).map((t) => t.map((x) => x.startMs))).toEqual([[0, 2500], [5000, 8000], [11_000]])
  })
  it('starts a new turn when another voice on the same side speaks', () => {
    const lines = [l('them', 0, 'A'), l('them', 3000, 'B'), l('them', 6000, 'B')]
    expect(turns(lines).map((t) => t.length)).toEqual([1, 2])
  })
  it('keeps unlabelled lines of the other side together until voices are told apart', () => {
    expect(turns([l('them', 0), l('them', 3000)]).map((t) => t.length)).toEqual([2])
  })
  it('starts a new turn after a long silence, so its time shows', () => {
    expect(turns([l('me', 0, null, 2000), l('me', 40_000)]).map((t) => t.length)).toEqual([1, 1])
  })
  it('has nothing for no lines', () => expect(turns([])).toEqual([]))
})

describe('lineAt', () => {
  const lines = [l('me', 0), l('them', 5000, 'A'), l('me', 10_000), l('them', 13_000, 'B')]
  it('finds the last line that started by then', () => {
    expect(lineAt(lines, 0)).toBe(0)
    expect(lineAt(lines, 4999)).toBe(0)
    expect(lineAt(lines, 5000)).toBe(1)
    expect(lineAt(lines, 12_000)).toBe(2)
    expect(lineAt(lines, 99_000)).toBe(3)
  })
  it('has none before the first line, or with no lines', () => {
    expect(lineAt([l('me', 2000)], 1000)).toBe(-1)
    expect(lineAt([], 1000)).toBe(-1)
  })
  it('is quick on a long meeting', () => {
    const many = Array.from({ length: 100_000 }, (_, i) => l('me', i * 500))
    const t0 = performance.now()
    for (let i = 0; i < 10_000; i++) lineAt(many, i * 4000)
    expect(performance.now() - t0).toBeLessThan(50)
    expect(lineAt(many, 1_234_567)).toBe(2469)
  })
})

describe('bubbles', () => {
  it('keeps lines said without a real pause in one bubble, like one thought', () => {
    const lines = [l('me', 0, null, 2000), l('me', 2400, null, 4000), l('me', 7000, null, 9000), l('me', 9200)]
    expect(bubbles(lines).map((b) => b.map((x) => x.startMs))).toEqual([[0, 2400], [7000, 9200]])
  })
  it('has nothing for no lines', () => expect(bubbles([])).toEqual([]))
})

describe('withLive', () => {
  const said = (track: 'me' | 'them', startMs: number, endMs: number) => ({ track, startMs, endMs, text: 'x', words: [{ text: 'x', startMs, endMs }] })
  it('puts what is being said among the lines by its time, with the speaker of the line it carries on', () => {
    const lines = [l('them', 0, 'Ann', 2000), l('me', 3000, null, 4000)]
    const out = withLive(lines, [said('them', 2500, 3500), said('me', 5000, 6000)])
    expect(out.map((x) => [x.track, x.startMs, 'live' in x ? 'live' : 'line', x.speaker])).toEqual([['them', 0, 'line', 'Ann'], ['them', 2500, 'live', 'Ann'], ['me', 3000, 'line', null], ['me', 5000, 'live', null]])
  })
  it('leaves out a side with nothing being said', () => {
    expect(withLive([l('me', 0)], [{ track: 'them', startMs: 0, endMs: 0, text: '', words: [] }])).toHaveLength(1)
  })
})

describe('stableKeys', () => {
  it('a word keeps its key while it is shown, after earlier words went to a final line too; new words get new keys', () => {
    const a = stableKeys([], [], ['so', 'I', 'can'], 0)
    expect(a.keys).toEqual([0, 1, 2])
    const b = stableKeys(['so', 'I', 'can'], a.keys, ['so', 'I', 'can', 'take'], a.next)
    expect(b.keys).toEqual([0, 1, 2, 3])
    const c = stableKeys(['so', 'I', 'can', 'take'], b.keys, ['take', 'a', 'break'], b.next)
    expect(c.keys).toEqual([3, 4, 5])
  })
  it('a word read again differently keeps its place and key; what follows it does too', () => {
    const a = stableKeys(['the', 'same', 'bump'], [0, 1, 2], ['the', 'same', 'bubble', 'as'], 3)
    expect(a.keys).toEqual([0, 1, 2, 3])
  })
})

describe('a long recording draws only its latest lines (all of them stay saved)', () => {
  const run = (n: number, from = 0) => ({ echo: false, lines: Array.from({ length: n }, (_, i) => ({ id: from + i })) })
  it('a short meeting draws everything', () => {
    expect(recentRuns([run(120)], 300, 50)).toEqual({ runs: [run(120)], earlier: 0 })
  })
  it('a long one keeps the last lines, trimmed in steps so the top changes rarely', () => {
    const r = recentRuns([run(400)], 300, 50)
    expect(r.earlier).toBe(100)
    expect(r.runs[0].lines[0]).toEqual({ id: 100 })
    expect(r.runs[0].lines.at(-1)).toEqual({ id: 399 })
    // ten more lines: the same top line, nothing moves up there
    expect(recentRuns([run(410)], 300, 50).runs[0].lines[0]).toEqual({ id: 100 })
    expect(recentRuns([run(451)], 300, 50).earlier).toBe(150)
  })
  it('cuts across runs, and never counts the words being said (live) as lines to drop', () => {
    const live = { live: true }
    const r = recentRuns([run(250), run(150, 250), { echo: false, lines: [live] }] as never, 300, 50)
    expect(r.earlier).toBe(100)
    expect(r.runs.map((x: { lines: unknown[] }) => x.lines.length)).toEqual([150, 150, 1])
  })
})

it('highlights surviving overlapping speech and leaves a removed-only interval unhighlighted', async () => {
  const { playbackLookup } = await import('../src/shared/transcript')
  const row = (startMs:number,endMs:number) => ({ track:'them' as const, speaker:null, startMs,endMs })
  const at = playbackLookup([row(0,8000),row(1000,3000),row(12000,15000)],[row(2500,10000)])
  expect([2000,4000,8500,12000].map(at)).toEqual([1,0,-1,2])
})
