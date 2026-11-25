import { describe, expect, it } from 'vitest'
import { createCallSilence } from '../src/main/callSilence'

const MIN = 60_000

/** levels every 100 ms from one moment to another; what the watch said, in order (only when it said something) */
function feed(watch: ReturnType<typeof createCallSilence>, from: number, to: number, them: number, talking: boolean) {
  const said: Array<boolean> = []
  for (let t = from; t < to; t += 100) { const r = watch(them, talking, t); if (r !== undefined) said.push(r) }
  return said
}

describe('the other side going silent while someone talks here', () => {
  it('says nothing when the call side was never heard: a missing permission has its own hint', () => {
    const w = createCallSilence()
    expect(feed(w, 1000, 1000 + 10 * MIN, 0, true)).toEqual([])
  })

  it('speaks once after four minutes of silence with minutes of talking here, and not before', () => {
    const w = createCallSilence()
    expect(feed(w, 1000, 1000 + MIN, 0.4, true)).toEqual([])
    expect(feed(w, 1000 + MIN, 1000 + 4 * MIN, 0, true)).toEqual([])
    expect(feed(w, 1000 + 4 * MIN, 1000 + 8 * MIN, 0, true)).toEqual([true])
  })

  it('goes away when the call side is heard again, and can come back', () => {
    const w = createCallSilence()
    feed(w, 1000, 1000 + MIN, 0.4, true)
    expect(feed(w, 1000 + MIN, 1000 + 6 * MIN, 0, true)).toEqual([true])
    expect(feed(w, 1000 + 6 * MIN, 1000 + 7 * MIN, 0.4, true)).toEqual([false])
    expect(feed(w, 1000 + 7 * MIN, 1000 + 13 * MIN, 0, true)).toEqual([true])
  })

  it('stays quiet while nobody talks here either: a quiet call is not a lost one', () => {
    const w = createCallSilence()
    feed(w, 1000, 1000 + MIN, 0.4, true)
    expect(feed(w, 1000 + MIN, 1000 + 20 * MIN, 0, false)).toEqual([])
    // somebody speaking for a few seconds is not enough to say a call was lost
    expect(feed(w, 1000 + 20 * MIN, 1000 + 20 * MIN + 10_000, 0, true)).toEqual([])
  })

  it('does not count a pause (no levels come) as silence', () => {
    const w = createCallSilence()
    feed(w, 1000, 1000 + MIN, 0.4, true)
    feed(w, 1000 + MIN, 1000 + 3 * MIN, 0, true)
    // paused for ten minutes, then talking again
    const back = 1000 + 13 * MIN
    expect(feed(w, back, back + 3 * MIN, 0, true)).toEqual([])
    expect(feed(w, back + 3 * MIN, back + 6 * MIN, 0, true)).toEqual([true])
  })
})
