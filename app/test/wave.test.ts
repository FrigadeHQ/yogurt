import { describe, expect, it } from 'vitest'
import { micFloor, silentSpeech, speechAt, speechBars, speechRestAt, speechSample } from '../src/shared/speechWave'

const input = (db: number) => ({ me: Math.max(0, (db + 60) / 60), them: 0 })
const on = speechSample(silentSpeech, input(-25), 0)
const atStrength = (phase: number, reduced = false) => speechBars({ drive: 1, phase }, reduced).heights

describe('recording speech wave', () => {
  it('uses only the microphone and keeps small fluctuations inside the speech gate from moving it', () => {
    expect(speechSample(silentSpeech, { me: 0, them: 1 }, 0).speaking).toBe(false)
    expect(speechSample(silentSpeech, input(-47), 0).speaking).toBe(false)
    const held = speechSample(on, input(-47), 100)
    expect(held).toEqual(speechSample(on, input(-9), 100))
    expect(held.speaking).toBe(true)
    expect(speechSample(held, input(-52), 200).speaking).toBe(false)
    expect(speechSample(on, input(-47), 1500).speaking).toBe(false)
  })

  it('rises in 300 ms and releases in 520 ms; a brief pause reverses from the current energy', () => {
    expect(speechAt(on, 150).drive).toBeCloseTo(.5)
    expect(speechAt(on, 300).drive).toBe(1)
    const off = speechSample(on, input(-60), 300)
    expect(speechAt(off, 560).drive).toBeCloseTo(.5)
    const resumed = speechSample(off, input(-25), 560)
    expect(speechAt(resumed, 560)).toEqual(speechAt(off, 560))
    expect(speechAt(resumed, 710).drive).toBe(1)
    expect(speechRestAt(off)).toBe(820)
    expect(speechAt(off, 820).drive).toBe(0)
  })

  it('holds phase throughout silence and resumes from the same position even across a missing stream', () => {
    const resting = speechAt(on, 820)
    expect(resting).toEqual({ drive: 0, phase: 820 })
    expect(speechRestAt(on)).toBe(820)
    expect(speechAt(on, 12000)).toEqual(resting)
    const again = speechSample(on, input(-24), 12000)
    expect(speechAt(again, 12000)).toEqual(resting)
    expect(speechAt(again, 12100).phase).toBe(920)
    expect(speechBars(resting, false).heights).toEqual([0, 0, 0, 0, 0])
  })

  it('passes the crest one bar left every 180 ms at every energy and wraps continuously', () => {
    for (const drive of [.25, .7, 1]) {
      for (let i = 0; i <= 5; i++) {
        const { heights } = speechBars({ drive, phase: 180 * i }, false)
        expect(heights.indexOf(Math.max(...heights))).toBe(4 - i % 5)
      }
    }
    expect(atStrength(900)[4]).toBeCloseTo(atStrength(0)[4], 10)
    expect(atStrength(0)[4]).toBe(.7)
    expect(Math.min(...atStrength(90))).toBeCloseTo(.077)
  })

  it('keeps a centred live energy reading without travel in reduced motion', () => {
    expect(atStrength(80, true)).toEqual(atStrength(600, true))
    expect(atStrength(0, true)).toEqual(atStrength(0, true).reverse())
    expect(speechBars({ drive: .5, phase: 135 }, true).heights[2]).toBe(.35)
  })

  it('stays still over a noisy mic, measured against its own quietest tenth over the last minute', () => {
    const recent: number[] = []
    let speech = silentSpeech, floor = -Infinity
    // a laptop mic whose room sits between -45 and -38 dB, louder than the fixed -44.4 dB gate
    for (let i = 0; i < 100; i++) { floor = micFloor(recent, input(i % 2 ? -45 : -38)); speech = speechSample(speech, input(i % 2 ? -45 : -38), i * 100, floor) }
    expect(floor).toBe(-45)
    expect(speech.speaking).toBe(false)
    expect(speechSample(speech, input(-25), 10000, micFloor(recent, input(-25))).speaking).toBe(true)
    // no floor for the first five seconds: the fixed levels alone
    expect(micFloor([], input(-40))).toBe(-Infinity)
    expect(speechSample(silentSpeech, input(-40), 0, -Infinity).speaking).toBe(true)
  })
})
