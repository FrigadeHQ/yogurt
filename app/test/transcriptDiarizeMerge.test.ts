import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useEffect } from 'react'
import type { Segment } from '../src/shared/types'
import { useLines } from '../src/renderer/src/components/Transcript'

const hooks = vi.hoisted(() => ({ values: [] as unknown[], refs: [] as { current: unknown }[], state: 0, ref: 0 }))
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const i = hooks.state++
    if (!(i in hooks.values)) hooks.values[i] = typeof initial === 'function' ? initial() : initial
    return [hooks.values[i], (next: unknown) => { hooks.values[i] = typeof next === 'function' ? next(hooks.values[i]) : next }]
  },
  useRef: (initial: unknown) => hooks.refs[hooks.ref++] ?? (hooks.refs[hooks.ref - 1] = { current: initial }),
  useEffect: vi.fn(),
}))

const get = vi.fn()
const speakers = { cb: null as ((id: string) => void) | null }
const segment = { cb: null as ((l: Line) => void) | null }

beforeEach(() => {
  hooks.state = 0; hooks.ref = 0; hooks.values = []; hooks.refs = []
  vi.clearAllMocks(); speakers.cb = null; segment.cb = null
  vi.stubGlobal('window', { yogurt: { transcript: {
    get,
    draft: () => Promise.resolve([]),
    onSegment: (cb: (l: Line) => void) => { segment.cb = cb; return () => { segment.cb = null } },
    onSpeakers: (cb: (id: string) => void) => { speakers.cb = cb; return () => { speakers.cb = null } },
    onReplaced: () => () => {},
  } } })
})
afterEach(() => vi.unstubAllGlobals())

/** a line as the view keeps it, and as whisper saved it: its start is the chunk's, before the first word */
type Line = Omit<Segment, 'id'> & { id?: number }
const row = (startMs: number, endMs: number, speaker: string | null): Line =>
  ({ meetingId: 'm1', track: 'them', startMs, endMs, text: 'said', speaker, speakerKey: null })

const shown = () => render().map(l => [l.startMs, l.speaker])
function render() {
  hooks.state = 0; hooks.ref = 0
  return useLines('m1', false).lines
}
/** the view's effect that reads its meeting's lines (deps [id]) */
const mount = () => vi.mocked(useEffect).mock.calls.find(([, deps]) => deps?.length === 1 && deps[0] === 'm1')![0]

it('the diarized runs replace the row whisper saved, so nothing is left shown as Andere', async () => {
  get.mockResolvedValueOnce([row(1000, 10_000, null)])
  render()
  mount()()
  await vi.waitFor(() => expect(shown()).toEqual([[1000, null]]))
  // diarization re-split that row into its voices' runs and told the view the speakers changed
  get.mockResolvedValue([row(1200, 5000, 'Speaker 1'), row(5000, 10_000, 'Speaker 2')])
  speakers.cb!('m1')
  // the row the store no longer has is gone: its words show only in the named runs
  await vi.waitFor(() => expect(shown()).toEqual([[1200, 'Speaker 1'], [5000, 'Speaker 2']]))
})

it('a line that arrives during the read stays beside the diarized runs', async () => {
  get.mockResolvedValueOnce([row(1000, 10_000, null)])
  render()
  mount()()
  await vi.waitFor(() => expect(shown()).toEqual([[1000, null]]))
  get.mockResolvedValue([row(1200, 5000, 'Speaker 1')])
  segment.cb!(row(12_000, 14_000, null)) // arrived while the saved lines were being read
  speakers.cb!('m1')
  await vi.waitFor(() => expect(shown()).toEqual([[1200, 'Speaker 1'], [12_000, null]]))
})
