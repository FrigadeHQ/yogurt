import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Menu } from '@base-ui/react/menu'
import { StartRecording } from '../src/renderer/src/components/StartRecording'
import { recordingChoices } from '../src/renderer/src/agenda'
import { toasts } from '../src/renderer/src/components/TrashToast'
import type { AgendaEvent, WidgetView } from '../src/shared/types'

// Exercise the component's handlers and subscriptions without a browser or Electron.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], refs: [] as { current: unknown }[], state: 0, ref: 0,
  effects: [] as (() => (() => void) | void)[], layout: [] as (() => (() => void) | void)[] }))
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = hooks.state++
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === 'function' ? initial() : initial
    return [hooks.values[index], (value: unknown) => { hooks.values[index] = typeof value === 'function' ? value(hooks.values[index]) : value }]
  },
  useRef: (initial: unknown) => hooks.refs[hooks.ref++] ?? (hooks.refs[hooks.ref - 1] = { current: initial }),
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void) => hooks.effects.push(effect),
  useLayoutEffect: (effect: () => void) => hooks.layout.push(effect),
}))
vi.mock('react-dom', () => ({ createPortal: (children: unknown) => children }))
vi.mock('../src/renderer/src/dates', () => ({ useDay: () => new Date().toDateString() }))
vi.mock('../src/renderer/src/components/TrashToast', () => ({ toasts: { add: vi.fn(), close: vi.fn() } }))
const now = new Date(2026, 10, 13, 12).getTime()
const event = (id: string, start = now - 60_000, end = now + 30 * 60_000): AgendaEvent => ({ id, title: `Planning ${id}`, start, end, url: null, attendees: [{ name: 'Robin Vale', email: null }] })
const start = vi.fn()
const day = vi.fn()
const started = vi.fn()
const gone = vi.fn()
let calendarChanged: () => void
let widgetChanged: (view: WidgetView | null) => void
let cleanups: (() => void)[]
const flush = async () => { await Promise.resolve(); await Promise.resolve() }
const render = () => {
  hooks.state = 0; hooks.ref = 0; hooks.effects = []; hooks.layout = []
  return StartRecording({ onStarted: started, onGone: gone }) as ReactElement<Record<string, unknown>> | null
}
const run = (effect: () => (() => void) | void) => { const cleanup = effect(); if (cleanup) cleanups.push(cleanup) }
type Element = ReactElement<Record<string, unknown>>
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  return isValidElement<Record<string, unknown>>(node) ? [node, ...elements(node.props.children as ReactNode)] : []
}
const find = (tree: ReactNode, id: string) => elements(tree).find(el => el.props['data-testid'] === id)!
const label = (tree: ReactNode) => renderToStaticMarkup(find(tree, 'start-recording').props.children as ReactNode)
const click = async (element: Element) => { (element.props.onClick as () => void)(); await flush() }
async function calendar(events: AgendaEvent[]) {
  day.mockResolvedValue({ status: 'granted', events })
  render(); run(hooks.effects[0]); await flush()
  return render()
}
beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(now); vi.clearAllMocks()
  hooks.values = []; hooks.refs = []; cleanups = []
  start.mockResolvedValue({ id: 'note' }); day.mockResolvedValue({ status: 'granted', events: [] })
  vi.stubGlobal('document', { getElementById: () => ({ nodeType: 1 }) })
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn(), yogurt: {
    capabilities: { calendar: true },
    widget: { state: async () => null, onState: (cb: typeof widgetChanged) => { widgetChanged = cb; return vi.fn() } },
    calendar: { day, onChange: (cb: () => void) => { calendarChanged = cb; return vi.fn() } },
    meetings: { start },
  } })
  render(); run(hooks.layout[0]); await flush()
})
afterEach(() => { cleanups.reverse().forEach(cleanup => cleanup()); vi.useRealTimers(); vi.unstubAllGlobals() })

it('keeps the plain, unattached action and no arrow outside the live/15-minute window', async () => {
  for (const events of [[], [event('past', now - 60_000, now)], [event('later', now + 15 * 60_000 + 1)]]) {
    const tree = await calendar(events)
    expect(label(tree)).toContain('Start recording')
    expect(find(tree, 'recording-choices')).toBeUndefined()
    await click(find(tree, 'start-recording'))
    expect(start).toHaveBeenLastCalledWith(null)
  }
})
it('attaches the one live meeting and preserves its full title while CSS truncates the label', async () => {
  const live = { ...event('live'), title: 'Planning the next release and reviewing every open question '.repeat(4) }
  const tree = await calendar([event('soon', now + 8 * 60_000), live])
  expect(label(tree)).toContain(`Take notes · ${live.title}`)
  expect(find(tree, 'start-recording').props.title).toBe(`Take notes · ${live.title}`)
  expect(find(tree, 'recording-choices').type).toBe(Menu.Trigger)
  await click(find(tree, 'start-recording'))
  expect(start).toHaveBeenCalledExactlyOnceWith(live.id)
  expect(started).toHaveBeenCalledExactlyOnceWith('note')
  const css = readFileSync(new URL('../src/renderer/src/workspace.css', import.meta.url), 'utf8')
  expect(css).toMatch(/\.recording-label \{[^}]*max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap/)
  expect(css).toMatch(/\.recording-split \{[^}]*max-width:min\(100%,276px\)/)
})
it('uses the menu trigger for two live meetings, with live choices first and an unattached final action', async () => {
  const tree = await calendar([event('soon', now + 8 * 60_000), event('second', now - 30_000), event('first')])
  expect(label(tree)).toContain('Take notes · 2 now')
  // The same Base UI trigger used by the arrow owns click, Enter, arrows and Escape.
  expect(find(tree, 'start-recording').type).toBe(Menu.Trigger)
  expect(find(tree, 'start-recording').props.onClick).toBeUndefined()
  ;(tree!.props.onOpenChange as (open: boolean) => void)(true)
  expect(render()!.props.open).toBe(true)
  expect(start).not.toHaveBeenCalled()
  const items = elements(tree).filter(el => el.type === Menu.Item)
  expect(items.map(item => item.props.label)).toEqual(['Planning first', 'Planning second', 'Planning soon', undefined])
  expect(renderToStaticMarkup(items[0].props.children as ReactNode)).toContain('Now')
  const soon = renderToStaticMarkup(items[2].props.children as ReactNode)
  expect(soon).toContain('in 8 min'); expect(soon).toContain('Robin Vale')
  await click(items[2]); expect(start).toHaveBeenLastCalledWith('soon')
  expect(render()!.props.open).toBe(false)
  await click(find(render(), 'recording-unattached')); expect(start).toHaveBeenLastCalledWith(null)
})
it('suggests an upcoming meeting but keeps the main action unattached', async () => {
  const tree = await calendar([event('soon', now + 8 * 60_000)])
  expect(label(tree)).toContain('Start recording')
  expect(find(tree, 'recording-choices').type).toBe(Menu.Trigger)
  await click(find(tree, 'start-recording'))
  expect(start).toHaveBeenCalledExactlyOnceWith(null)
})
it('changes at the 15-minute, start and end boundaries and never offers a past event', async () => {
  const upcoming = event('boundary', now + 16 * 60_000, now + 17 * 60_000)
  await calendar([upcoming])
  for (const [minutes, expected, arrow] of [[0, 'Start recording', false], [1, 'Start recording', true], [16, 'Take notes · Planning boundary', true], [17, 'Start recording', false]] as const) {
    vi.setSystemTime(now + minutes * 60_000 - 1)
    render(); run(hooks.effects[1]); await vi.advanceTimersByTimeAsync(1)
    const tree = render()
    expect(label(tree)).toContain(expected)
    expect(!!find(tree, 'recording-choices')).toBe(arrow)
  }
  expect(recordingChoices([upcoming], upcoming.end)).toEqual([])
})
it('hides the entire control during recording and closes a previously open menu', async () => {
  const tree = await calendar([event('first'), event('second')])
  ;(tree!.props.onOpenChange as (open: boolean) => void)(true)
  widgetChanged({ kind: 'recording' } as WidgetView)
  expect(render()).toBeNull(); run(hooks.effects[2])
  widgetChanged(null)
  expect(render()!.props.open).toBe(false)
})
it('clears revoked calendars immediately and ignores an older in-flight response', async () => {
  await calendar([event('live')])
  let reply!: (value: unknown) => void
  day.mockImplementationOnce(() => new Promise(resolve => { reply = resolve }))
  calendarChanged()
  expect(find(render(), 'recording-choices')).toBeUndefined()
  day.mockResolvedValue({ status: 'denied', events: [event('private')] })
  calendarChanged(); await flush()
  reply({ status: 'granted', events: [event('stale')] }); await flush()
  expect(find(render(), 'recording-choices')).toBeUndefined()
})
it('refreshes on focus and polls today without reading the agenda-selected date', async () => {
  await calendar([])
  day.mockClear()
  const focus = vi.mocked(window.addEventListener).mock.calls.find(([name]) => name === 'focus')![1] as () => void
  focus(); await flush()
  expect(day).toHaveBeenCalledExactlyOnceWith(now)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(day).toHaveBeenLastCalledWith(now + 60_000)
})
it('reports a removed event, refreshes choices, and never reports a failed or raced start as new', async () => {
  const tree = await calendar([event('live')])
  start.mockResolvedValueOnce({ error: 'gone' })
  day.mockResolvedValue({ status: 'granted', events: [] })
  await click(find(tree, 'start-recording'))
  expect(toasts.add).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'That meeting is no longer on your calendar.' }))
  expect(gone).toHaveBeenCalledOnce()
  expect(find(render(), 'recording-choices')).toBeUndefined()
  expect(started).not.toHaveBeenCalled()
  start.mockResolvedValueOnce({ id: 'existing', alreadyRecording: true })
  await click(find(render(), 'start-recording'))
  expect(started).not.toHaveBeenCalled()
  start.mockRejectedValueOnce(new Error('fixture start failure'))
  await click(find(render(), 'start-recording'))
  expect(toasts.add).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Yogurt couldn't start the notes. Try again in a moment." }))
  expect(find(render(), 'start-recording').props.disabled).toBe(false)
  expect(gone).toHaveBeenCalledOnce()
})
