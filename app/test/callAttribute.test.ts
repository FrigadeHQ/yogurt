import { describe, expect, it } from 'vitest'
import { nameFor, othersIn, type CallSample } from '../src/main/callNames/attribute'

/** a reading every 500 ms from `from` to `to` (meeting time), all saying the same */
const run = (from: number, to: number, s: Partial<CallSample>): CallSample[] =>
  Array.from({ length: Math.floor((to - from) / 500) }, (_, i) => ({ ms: from + i * 500, speaking: [], participants: [], me: null, ...s }))

const group = ['Alex Morgan', 'Dana Smith', 'Ann Lee']
const meetingOf3 = { participants: group, me: 'Alex Morgan' }

describe('nameFor: who the other side was, from what the call app showed', () => {
  it('names the person marked as talking for the whole line', () => {
    const tl = run(0, 10_000, { ...meetingOf3, speaking: ['Dana Smith'] })
    expect(nameFor({ startMs: 2000, endMs: 6000 }, tl)).toBe('Dana Smith')
  })

  it('takes the one who talked for most of the line', () => {
    const tl = [...run(0, 3000, { ...meetingOf3, speaking: ['Ann Lee'] }), ...run(3000, 10_000, { ...meetingOf3, speaking: ['Dana Smith'] })]
    expect(nameFor({ startMs: 2000, endMs: 7000 }, tl)).toBe('Dana Smith')
  })

  it('is Them when nobody has most of it', () => {
    const tl = [...run(0, 4000, { ...meetingOf3, speaking: ['Ann Lee'] }), ...run(4000, 6000, meetingOf3), ...run(6000, 10_000, { ...meetingOf3, speaking: ['Dana Smith'] })]
    expect(nameFor({ startMs: 2000, endMs: 8000 }, tl)).toBeNull()
  })

  it('is Them when two people are marked at once', () => {
    const tl = run(0, 10_000, { ...meetingOf3, speaking: ['Ann Lee', 'Dana Smith'] })
    expect(nameFor({ startMs: 1000, endMs: 5000 }, tl)).toBeNull()
  })

  it('is Them when only the person using Yogurt is marked (their own voice, not the other side)', () => {
    const tl = run(0, 10_000, { ...meetingOf3, speaking: ['Alex Morgan'] })
    expect(nameFor({ startMs: 1000, endMs: 5000 }, tl)).toBeNull()
    // and when they are told apart only by the name in Settings
    expect(nameFor({ startMs: 1000, endMs: 5000 }, run(0, 10_000, { participants: group, speaking: ['Alex Morgan'] }), { myNames: ['alex morgan'] })).toBeNull()
  })

  it('is Them with no readings, or readings that stopped long before the line', () => {
    expect(nameFor({ startMs: 1000, endMs: 5000 }, [])).toBeNull()
    // a reading counts for 2 s at most: a stuck app never keeps naming someone
    const tl = run(0, 1000, { ...meetingOf3, speaking: ['Dana Smith'] })
    expect(nameFor({ startMs: 4000, endMs: 8000 }, tl)).toBeNull()
  })

  it('a reading where the app could not be read counts as not knowing', () => {
    const tl = [...run(0, 2000, { ...meetingOf3, speaking: ['Dana Smith'] }), ...run(2000, 10_000, { ok: false })]
    expect(nameFor({ startMs: 0, endMs: 6000 }, tl)).toBeNull()
  })

  it('in a call with one other person, every line of the other side is theirs, marked or not', () => {
    const pair = { participants: ['Alex Morgan', 'Dana Smith'], me: 'Alex Morgan' }
    expect(nameFor({ startMs: 1000, endMs: 5000 }, run(0, 10_000, pair))).toBe('Dana Smith')
    // the app marking the person themself changes nothing: the call's sound can only be the other person
    expect(nameFor({ startMs: 1000, endMs: 5000 }, run(0, 10_000, { ...pair, speaking: ['Alex Morgan'] }))).toBe('Dana Smith')
  })

  it('does not use the two-person fallback when a stale roster conflicts with speaker marks', () => {
    const pair = { participants: ['Alex Morgan', 'Dana Smith'], me: 'Alex Morgan' }
    const label = (speaking: string[]) => nameFor({ startMs: 1000, endMs: 5000 }, run(0, 10_000, { ...pair, speaking }))
    expect(label(['Dana Smith'])).toBe('Dana Smith')
    expect(label(['Ann Lee'])).toBe('Ann Lee')
    expect(label(['Alex Morgan', 'Ann Lee'])).toBe('Ann Lee')
    expect(label(['Dana Smith', 'Ann Lee'])).toBeNull()
    expect(label(['Ann Lee', 'Bo Park'])).toBeNull()
  })

  it('a call of two where nobody is known to be the person using Yogurt names nobody', () => {
    expect(nameFor({ startMs: 1000, endMs: 5000 }, run(0, 10_000, { participants: ['Ann Lee', 'Dana Smith'] }))).toBeNull()
    // the name in Settings tells them apart
    expect(nameFor({ startMs: 1000, endMs: 5000 }, run(0, 10_000, { participants: ['Ann Lee', 'Dana Smith'] }), { myNames: ['Ann  Lee'] })).toBe('Dana Smith')
  })

  it('a very short line is named by the moment it starts', () => {
    const tl = run(0, 10_000, { ...meetingOf3, speaking: ['Ann Lee'] })
    expect(nameFor({ startMs: 3000, endMs: 3000 }, tl)).toBe('Ann Lee')
  })

  it('readings out of order are sorted first', () => {
    const tl = run(0, 10_000, { ...meetingOf3, speaking: ['Dana Smith'] }).reverse()
    expect(nameFor({ startMs: 2000, endMs: 6000 }, tl)).toBe('Dana Smith')
  })
})

// ---- #112: an 8-person Meet in Chrome read "talking 2 of 8" or "3 of 8" for the whole call, never 1, and named none
// of 370 lines. Two tiles kept Meet's talking mark all along (my own tile, a pinned or presenting one); the third mark
// came and went with whoever spoke. Me was never known. Made-up names, the log's shape. ----
describe('nameFor: a mark that never leaves a tile is not talking (#112)', () => {
  const room = ['Theo Lane', 'Pia Stone', 'Dana Smith', 'Ann Lee', 'Bo Park', 'Cy Diaz', 'Eve Ruiz', 'Gus Hart']
  const steady = ['Theo Lane', 'Pia Stone']
  /** five minutes of the call: the two steady marks always on, Dana speaking 60-90 s and Ann 200-230 s */
  const call = [...run(0, 60_000, { participants: room, speaking: steady }), ...run(60_000, 90_000, { participants: room, speaking: [...steady, 'Dana Smith'] }),
    ...run(90_000, 200_000, { participants: room, speaking: steady }), ...run(200_000, 230_000, { participants: room, speaking: ['Ann Lee', ...steady] }),
    ...run(230_000, 300_000, { participants: room, speaking: steady })]

  it('names the one person marked besides the marks that stay all call', () => {
    expect(nameFor({ startMs: 62_000, endMs: 70_000 }, call)).toBe('Dana Smith')
    expect(nameFor({ startMs: 205_000, endMs: 215_000 }, call)).toBe('Ann Lee')
  })

  it('with only the steady marks on, the line is Them, even when one of them drops for a moment', () => {
    expect(nameFor({ startMs: 120_000, endMs: 130_000 }, call)).toBeNull()
    const blip = call.map((x) => (x.ms >= 140_000 && x.ms < 146_000 ? { ...x, speaking: ['Pia Stone'] } : x))
    expect(nameFor({ startMs: 140_000, endMs: 146_000 }, blip)).toBeNull()
  })

  it('two people marked at once besides the steady ones is still Them', () => {
    const both = call.map((x) => (x.ms >= 60_000 && x.ms < 90_000 ? { ...x, speaking: [...steady, 'Dana Smith', 'Bo Park'] } : x))
    expect(nameFor({ startMs: 62_000, endMs: 70_000 }, both)).toBeNull()
  })

  it('one person talking at length with nobody else marked is still named (a talk, not a stuck mark)', () => {
    const talk = run(0, 300_000, { participants: room, speaking: ['Dana Smith'] })
    expect(nameFor({ startMs: 100_000, endMs: 110_000 }, talk)).toBe('Dana Smith')
  })

  it('a few seconds of two marks together are not enough to call either steady', () => {
    const tl = [...run(0, 4000, { ...meetingOf3, speaking: ['Ann Lee', 'Dana Smith'] }), ...run(4000, 8000, { ...meetingOf3, speaking: ['Dana Smith'] })]
    expect(nameFor({ startMs: 4000, endMs: 8000 }, tl)).toBe('Dana Smith')
  })
})

describe('othersIn: everyone seen in the call but the person using Yogurt', () => {
  it('lists each other name once, in the order first seen', () => {
    const tl = [...run(0, 1000, meetingOf3), ...run(1000, 2000, { participants: ['Alex Morgan', 'Bo Park', 'Dana Smith'], me: 'Alex Morgan', speaking: ['Bo Park'] })]
    expect(othersIn(tl)).toEqual(['Dana Smith', 'Ann Lee', 'Bo Park'])
    expect(othersIn(run(0, 1000, { participants: ['Alex Morgan', 'Dana Smith'] }), { myNames: ['Alex Morgan'] })).toEqual(['Dana Smith'])
  })
})
