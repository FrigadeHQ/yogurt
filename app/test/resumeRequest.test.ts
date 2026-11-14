import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { Note } from '../src/renderer/src/screens/Note'
import type { MeetingView, NoteView } from '../src/shared/types'

// Run the note's effects and handlers without mounting editors, a browser, or capture.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], refs: [] as { current: unknown }[],
  memos: [] as unknown[], effects: [] as { deps?: unknown[]; run: () => void | (() => void); cleanup?: () => void; pending: boolean }[],
  state: 0, ref: 0, memo: 0, effect: 0 }))
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const i = hooks.state++
    if (!(i in hooks.values)) hooks.values[i] = typeof initial === 'function' ? initial() : initial
    return [hooks.values[i], (next: unknown) => { hooks.values[i] = typeof next === 'function' ? next(hooks.values[i]) : next }]
  },
  useRef: (initial: unknown) => hooks.refs[hooks.ref++] ?? (hooks.refs[hooks.ref - 1] = { current: initial }),
  useMemo: (make: () => unknown) => { const i = hooks.memo++; return hooks.memos[i] ?? (hooks.memos[i] = make()) },
  useLayoutEffect: () => {},
  useEffect: (run: () => void | (() => void), deps?: unknown[]) => {
    const i = hooks.effect++, prev = hooks.effects[i]
    hooks.effects[i] = { run, deps, cleanup: prev?.cleanup, pending: !prev || !deps || deps.some((dep, index) => dep !== prev.deps?.[index]) }
  },
}))
vi.mock('../src/renderer/src/motion', async original => ({ ...await original<typeof import('../src/renderer/src/motion')>(), useReducedMotion: () => true }))
let meeting: MeetingView, notes: NoteView
let meetingChanged: () => void, notesChanged: (notes: NoteView) => void
const resume = vi.fn(), consumed = vi.fn(), title = vi.fn(), source = vi.fn()
let requested: (() => void) | undefined
let tree: ReactNode
const unmount = () => { hooks.effects.forEach(effect => effect.cleanup?.()); hooks.values = []; hooks.refs = []; hooks.memos = []; hooks.effects = [] }
async function render() {
  hooks.state = 0; hooks.ref = 0; hooks.memo = 0; hooks.effect = 0
  tree = Note({ id: 'resume-fixture', onTitleChange: title, onSource: source, onResumeRequested: requested })
  for (const effect of hooks.effects) if (effect.pending) {
    effect.cleanup?.()
    effect.cleanup = effect.run() || undefined
    effect.pending = false
  }
  for (let i = 0; i < 6; i++) await Promise.resolve()
}
function find(node: ReactNode, id: string): ReactElement<Record<string, unknown>> | undefined {
  if (Array.isArray(node)) return node.map(child => find(child, id)).find(Boolean)
  if (!isValidElement<Record<string, unknown>>(node)) return
  return node.props['data-testid'] === id || node.props.testId === id ? node : find(node.props.children as ReactNode, id)
}
beforeEach(() => {
  vi.clearAllMocks()
  meeting = { id: 'resume-fixture', title: 'Resume fixture', startedAt: 1, endedAt: 2, eventId: 'event', app: null, attendees: [], state: 'stopped', language: null, titleSource: 'calendar' }
  notes = { meetingId: meeting.id, mine: '', enhanced: null, edited: false, status: 'writing', draft: '', peopleChanged: false }
  requested = () => { consumed(); requested = undefined }
  resume.mockResolvedValue({ id: meeting.id })
  vi.stubGlobal('window', { matchMedia: () => ({ matches: true }), yogurt: {
    meetings: { get: async () => meeting, onChange: (cb: typeof meetingChanged) => { meetingChanged = cb; return vi.fn() }, resume, stop: vi.fn() },
    notes: { get: async () => notes, onChange: (cb: typeof notesChanged) => { notesChanged = cb; return vi.fn() } },
    widget: { state: async () => null, onState: () => vi.fn() },
  } })
})
afterEach(() => { unmount(); vi.unstubAllGlobals() })

it.each(['', 'Keep this decision.'])('the note Resume button always lands on My notes with content %j', async mine => {
  notes = { ...notes, status: 'done', mine }; requested = undefined
  await render(); await render()
  ;(find(tree, 'note-resume')!.props.onClick as () => void)()
  await render(); await render()
  expect(resume).toHaveBeenCalledExactlyOnceWith(meeting.id)
  expect(find(tree, 'note-notes-tab')?.props['aria-selected']).toBe(true)
})

it('retains the request through queued and writing summaries, then resumes exactly once on My notes', async () => {
  notes.status = 'waiting'
  await render(); await render()
  expect(consumed).not.toHaveBeenCalled()
  expect(resume).not.toHaveBeenCalled()
  notesChanged({ ...notes, status: 'writing' }); await render()
  expect(consumed).not.toHaveBeenCalled()
  notesChanged({ ...notes, status: 'done' }); await render(); await render()
  expect(consumed).toHaveBeenCalledOnce()
  expect(resume).toHaveBeenCalledExactlyOnceWith(meeting.id)
  expect(find(tree, 'note-notes-tab')?.props['aria-selected']).toBe(true)
  await render()
  expect(resume).toHaveBeenCalledOnce()
})

it('drops a pending request when navigation unmounts the note, including when returning after the summary finishes', async () => {
  await render(); await render()
  unmount(); requested = undefined; notes.status = 'done'
  await render(); await render()
  expect(consumed).not.toHaveBeenCalled()
  expect(resume).not.toHaveBeenCalled()
})

it('waits through Finish before the summary starts and still asks before replacing an edited summary', async () => {
  meeting.state = 'recording'; notes.status = 'idle'; requested = undefined
  await render(); await render()
  ;(find(tree, 'note-stop')!.props.onClick as (e: { detail: number }) => void)({ detail: 0 })
  meeting = { ...meeting, state: 'stopped' }; meetingChanged()
  requested = () => { consumed(); requested = undefined }
  await render(); await render()
  expect(consumed).not.toHaveBeenCalled()
  notesChanged({ ...notes, status: 'writing' }); await render(); await render()
  expect(consumed).not.toHaveBeenCalled()
  notesChanged({ ...notes, status: 'done', edited: true }); await render(); await render()
  expect(consumed).toHaveBeenCalledOnce()
  expect(resume).not.toHaveBeenCalled()
  expect(find(tree, 'resume-confirm')).toBeDefined()
  await (find(tree, 'resume-yes')!.props.onClick as () => Promise<void>)()
  await render()
  expect(resume).toHaveBeenCalledExactlyOnceWith(meeting.id)
})
