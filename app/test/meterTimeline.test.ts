import { afterEach, expect, it, vi } from 'vitest'
import { useEffect, useRef } from 'react'
import { silentSpeech, speechAt, speechBars, speechSample, type MeterPacket } from '../src/shared/speechWave'
import { LevelBars } from '../src/renderer/src/components/LevelBars'

vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useEffect: vi.fn(), useRef: vi.fn() }))
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks() })

it.each([
  { testId: 'widget-wave', restOpacity: undefined, expectedRest: .45 },
  { testId: 'note-wave', restOpacity: .7, expectedRest: .7 },
])('interpolates between level packets and settles at the resting opacity for $testId', ({ testId, restOpacity, expectedRest }) => {
  vi.useFakeTimers(); vi.setSystemTime(0)
  vi.stubGlobal('performance', { now: () => Date.now(), timeOrigin: 0 })
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  vi.stubGlobal('document', doc)
  let receive!: (p: MeterPacket) => void
  const media = Object.assign(new EventTarget(), { matches: false })
  vi.stubGlobal('window', { matchMedia: () => media, yogurt: { widget: { onLevel: (cb: typeof receive) => { receive = cb; return vi.fn() } } } })
  const bars = Array.from({ length: 5 }, () => ({
    style: { transform: '', opacity: '' },
    animate: vi.fn((_frames: Keyframe[], _timing: KeyframeAnimationOptions) => ({ startTime: 0, cancel: vi.fn() })),
  }))
  const svg = { querySelectorAll: () => bars, dataset: { live: '', level: '' } }
  vi.mocked(useRef).mockImplementation((value: unknown) => ({ current: value === null ? svg : value }) as never)
  LevelBars({ height: 16, testId, restOpacity })
  const cleanup = vi.mocked(useEffect).mock.calls[0][0]()
  expect(bars.every(bar => Number(bar.style.opacity) === expectedRest)).toBe(true)
  let anchor = silentSpeech
  const packet = () => { anchor = speechSample(anchor, { me: .7, them: 0 }, Date.now()); receive({ me: .7, them: 0, speech: anchor }) }
  packet()
  const line = bars[4]
  const ramp = line.animate.mock.calls[0][0]
  expect(ramp[0].opacity).toBe(expectedRest)
  expect(ramp.at(-1)!.opacity).toBe(1)
  const [frames, timing] = line.animate.mock.calls[1]
  expect(timing).toMatchObject({ delay: 300, duration: 900, iterations: Infinity })
  expect(line.animate.mock.results[1].value.startTime).toBe(0)
  // No renderer frame callback is delivered. Sample the submitted display timeline at 120 Hz.
  for (let bin = 0; bin < 12; bin++) {
    vi.advanceTimersByTime(100); packet()
    if (Date.now() < 300) continue
    for (let f = 0; f < 12; f++) {
      const t = Date.now() + f * 1000 / 120
      const index = ((t - 300) % 900) / 900 * (frames.length - 1)
      const scaleAt = (n: number) => Number(String(frames[n].transform).slice(7, -1))
      const a = Math.floor(index), b = Math.min(a + 1, frames.length - 1)
      const scale = scaleAt(a) + (scaleAt(b) - scaleAt(a)) * (index - a)
      const expected = 3 + 13 * speechBars(speechAt(anchor, t), false).heights[4]
      expect(Math.abs(1.75 + scale * (16 - 1.75) - expected)).toBeLessThan(.01)
    }
  }
  expect(line.animate).toHaveBeenCalledTimes(2) // steady packets do not restart travel
  vi.advanceTimersByTime(821)
  expect(svg.dataset).toMatchObject({ level: '0.00', live: '0' })
  expect(bars.every(bar => Number(bar.style.opacity) === expectedRest)).toBe(true)
  expect(line.animate.mock.results.every(result => result.value.cancel.mock.calls.length > 0)).toBe(true)
  media.matches = true; media.dispatchEvent(new Event('change')); packet()
  expect(svg.dataset.live).toBe('0')
  expect(line.animate.mock.calls.at(-1)![1].iterations).toBe(1)
  doc.visibilityState = 'hidden'; doc.dispatchEvent(new Event('visibilitychange'))
  expect(svg.dataset.live).toBe('0')
  if (typeof cleanup === 'function') cleanup()
  expect(vi.getTimerCount()).toBe(0)
})
