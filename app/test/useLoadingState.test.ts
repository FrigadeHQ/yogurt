import { afterEach, expect, it, vi } from 'vitest'
import { useLoadingState } from '../src/renderer/src/useLoadingState'

const hook = vi.hoisted(() => ({ phase: 'waiting', effect: undefined as (() => (() => void)) | undefined, reduced: false }))
vi.mock('react', () => ({
  useState: () => [hook.phase, (value: string) => { hook.phase = value }],
  useRef: () => ({ current: undefined }),
  useLayoutEffect: (effect: () => (() => void)) => { hook.effect = effect },
}))
vi.mock('../src/renderer/src/motion', () => ({ useReducedMotion: () => hook.reduced }))
afterEach(() => { vi.useRealTimers(); hook.phase = 'waiting'; hook.reduced = false })

it.each([false, true])('waits 100 ms before showing the date skeleton (reduced motion: %s)', reduced => {
  vi.useFakeTimers(); hook.reduced = reduced
  useLoadingState(true)
  const cleanup = hook.effect!()
  vi.advanceTimersByTime(99)
  expect(hook.phase).toBe('waiting')
  vi.advanceTimersByTime(1)
  expect(hook.phase).toBe('skeleton')
  cleanup()
})
it('cancels a fast calendar read without flashing and preserves the default delay', () => {
  vi.useFakeTimers()
  useLoadingState(true)
  const cleanup = hook.effect!()
  vi.advanceTimersByTime(50); cleanup()
  useLoadingState(false); hook.effect!()
  vi.advanceTimersByTime(100)
  expect(hook.phase).toBe('ready')
  hook.phase = 'waiting'
  useLoadingState(true); hook.effect!()
  vi.advanceTimersByTime(99)
  expect(hook.phase).toBe('waiting')
  vi.advanceTimersByTime(1)
  expect(hook.phase).toBe('skeleton')
})
