import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NoteMenu } from '../src/renderer/src/components/NoteMenu'
import { Note } from '../src/renderer/src/screens/Note'
import type { MeetingView, NoteView, SetupState } from '../src/shared/types'

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
const meetingListeners=new Set<()=>void>()
const transcriptGet = vi.fn(), stopSummary = vi.fn()
let segmentChanged: (line: { meetingId: string; text: string }) => void, transcriptChanged: (id: string) => void, setupChanged: (state: SetupState) => void
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
function find(node: ReactNode, id: string | typeof NoteMenu): ReactElement<Record<string, unknown>> | undefined {
  if (Array.isArray(node)) return node.map(child => find(child, id)).find(Boolean)
  if (!isValidElement<Record<string, unknown>>(node)) return
  return node.type === id || node.props.id === id || node.props['data-testid'] === id || node.props.testId === id ? node : find(node.props.children as ReactNode, id)
}
beforeEach(() => {
  vi.clearAllMocks();meetingListeners.clear();meetingChanged=()=>meetingListeners.forEach(cb=>cb())
  meeting = { id: 'resume-fixture', title: 'Resume fixture', startedAt: 1, endedAt: 2, eventId: 'event', app: null, attendees: [], state: 'stopped', language: null, titleSource: 'calendar' }
  notes = { meetingId: meeting.id, mine: '', enhanced: null, edited: false, status: 'writing', draft: '', peopleChanged: false }
  requested = () => { consumed(); requested = undefined }
  transcriptGet.mockResolvedValue([])
  resume.mockResolvedValue({ id: meeting.id })
  stopSummary.mockResolvedValue(undefined)
  vi.stubGlobal('window', { matchMedia: () => ({ matches: true }), yogurt: {
    meetings: { get: async () => meeting, onChange: (cb: typeof meetingChanged) => { meetingListeners.add(cb); return ()=>meetingListeners.delete(cb) }, resume, stop: vi.fn() },
    notes: { stop: stopSummary, setMine: async (_id: string, _text: string, revision: number) => ({ revision, status: 'saved' }), get: async () => notes, onChange: (cb: typeof notesChanged) => { notesChanged = cb; return vi.fn() } },
    transcript: { get: transcriptGet, onSegment: (cb: typeof segmentChanged) => { segmentChanged = cb; return vi.fn() }, onSpeakers: (cb: typeof transcriptChanged) => { transcriptChanged = cb; return vi.fn() } },
    setup: { state: async () => ({ phase: 'ready', fraction: 1 }), onState: (cb: typeof setupChanged) => { setupChanged = cb; return vi.fn() } },
    audio: { tracks: async()=>[], onDeleted:()=>vi.fn() },
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

it('waits through Stop before the summary starts and still asks before replacing an edited summary', async () => {
  meeting.state = 'recording'; notes.status = 'idle'; requested = undefined
  await render(); await render()
  expect(find(tree, 'note-summary-tab')).toBeUndefined()
  ;(find(tree, 'note-stop')!.props.onClick as (e: { detail: number }) => void)({ detail: 0 })
  meeting = { ...meeting, state: 'stopped' }; meetingChanged()
  requested = () => { consumed(); requested = undefined }
  await render(); await render()
  expect(consumed).not.toHaveBeenCalled()
  expect(find(tree, 'note-finishing')).toBeDefined()
  expect(find(tree, 'note-resume')).toBeUndefined()
  notesChanged({ ...notes, status: 'waiting' }); await render()
  expect(find(tree, 'note-finishing')).toBeUndefined()
  expect(find(tree, 'note-summary-tab')!.props['aria-describedby']).toBe('note-summary-phase')
  expect(find(tree, 'note-summary-phase')!.props.children).toBe('Preparing…')
  expect(find(tree, 'note-resume')!.props['aria-label']).toBe('Stop summarizing')
  expect(find(tree, 'note-resume')!.props.disabled).toBe(false)
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

it('updates generation availability for typed notes, existing summaries, and Trash', async () => {
  notes.status = 'empty'; requested = undefined
  await render(); await render()
  expect(find(tree, NoteMenu)?.props.generation).toBeUndefined()
  ;(find(tree, 'note-notes-tab')!.props.onClick as (e: { detail: number }) => void)({ detail: 0 }); await render()
  ;(find(tree, 'note-mine')!.props.onChange as (md: string) => void)('Keep the release small.'); await render()
  expect(find(tree, NoteMenu)?.props.generation).toMatchObject({ label: 'Generate summary', reason: undefined })
  notesChanged({ ...notes, enhanced: '## Plan', status: 'done' }); await render()
  expect(find(tree, NoteMenu)?.props.generation).toMatchObject({ label: 'Regenerate summary' })
  meeting.trashedAt = 1; meetingChanged(); await render(); await render()
  expect(find(tree, NoteMenu)?.props.generation).toBeUndefined()
})

it('keeps a live transcript arrival over an older empty read, and refreshes after hidden lines change', async () => {
  notes.status = 'empty'; requested = undefined
  let resolve!: (lines: []) => void
  transcriptGet.mockImplementationOnce(() => new Promise(r => { resolve = r }))
  await render(); await render()
  segmentChanged({ meetingId: meeting.id, text: 'Release on Tuesday.' })
  resolve([]); await render(); await render()
  expect(find(tree, NoteMenu)?.props.generation).toMatchObject({ label: 'Generate summary' })
  expect(transcriptGet).toHaveBeenCalledWith(meeting.id, { last: 1 })
  transcriptChanged(meeting.id); await render(); await render()
  expect(find(tree, NoteMenu)?.props.generation).toBeUndefined()
})

it('waits for the first notes model but allows generation during an optional upgrade', async () => {
  notes = { ...notes, status: 'done', enhanced: '## Plan' }; requested = undefined
  await render(); await render()
  setupChanged({ phase: 'ready', fraction: 1, notesDownloading: true }); await render()
  expect(find(tree, NoteMenu)?.props.generation).toMatchObject({ reason: 'Waiting for Yogurt AI to download' })
  setupChanged({ phase: 'ready', fraction: 1, notesUpgradeDownloading: true }); await render()
  expect(find(tree, NoteMenu)?.props.generation).toMatchObject({ reason: undefined })
  setupChanged({ phase: 'ready', fraction: 1, notesError: 'Download failed' }); await render()
  expect(find(tree, NoteMenu)?.props.generation).toMatchObject({ reason: 'Waiting for Yogurt AI to download' })
})


it('can cancel summary preparation while the transcript is still processing', async () => {
  meeting.transcriptionState = 'transcribing'; notes.status = 'waiting'; requested = undefined
  await render(); await render()
  const stop = find(tree, 'note-resume')!
  expect(stop.props['aria-label']).toBe('Stop summarizing')
  expect(stop.props.disabled).toBe(false)
  ;(stop.props.onClick as () => void)()
  expect(stopSummary).toHaveBeenCalledExactlyOnceWith(meeting.id)
  notesChanged({ ...notes, status: 'stopped' }); await render()
  expect(find(tree, 'note-resume')).toBeUndefined()
  expect(resume).not.toHaveBeenCalled()
})

it.each(['waiting', 'writing', 'failed', 'empty', 'stopped', 'done'] as const)('the header action for %s stops a summary or resumes recording without confusing the two', async status => {
  notes.status = status; requested = undefined
  await render(); await render()
  const busy = status === 'waiting' || status === 'writing'
  const button = find(tree, 'note-resume')!
  expect(button.props.disabled).toBe(false)
  expect(button.props['aria-label']).toBe(busy ? 'Stop summarizing' : 'Resume recording')
  expect(button.props['aria-busy']).toBeUndefined()
  const summary = find(tree, 'note-summary-tab')!
  expect(summary.props['aria-label']).toBeUndefined()
  expect(summary.props.children).toContain('Summary')
  expect(summary.props['aria-describedby']).toBe(busy ? 'note-summary-phase' : undefined)
  const phase = find(tree, 'note-summary-phase')
  expect(phase?.props.hidden).toBe(busy ? true : undefined)
  expect(phase?.props.children).toBe(status === 'waiting' ? 'Preparing…' : status === 'writing' ? 'Writing the summary' : undefined)
  expect(renderToStaticMarkup(summary).includes('summary-writing-mark')).toBe(busy)
  ;(button.props.onClick as () => void)()
  await render(); await render()
  if (busy) {
    expect(stopSummary).toHaveBeenCalledExactlyOnceWith(meeting.id)
    expect(resume).not.toHaveBeenCalled()
    notesChanged({ ...notes, status: 'stopped' }); await render()
    expect(find(tree, 'note-resume')!.props['aria-label']).toBe('Resume recording')
  } else {
    expect(resume).toHaveBeenCalledExactlyOnceWith(meeting.id)
    expect(stopSummary).not.toHaveBeenCalled()
  }
})
