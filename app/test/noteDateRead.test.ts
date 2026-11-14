import { afterEach, expect, it, vi } from 'vitest'
import { NoteDate } from '../src/renderer/src/components/NoteDate'
import type { Meeting } from '../src/shared/types'

// Exercise this component's hooks and effects without mounting a browser or its child components.
const h = vi.hoisted(() => ({ values: [] as any[], index: 0, dirty: false, pending: [] as any[], effects: new Map<number, any>() }))
vi.mock('react', async original => {
  const react = await original<typeof import('react')>()
  const effect = (run: () => unknown, deps?: unknown[]) => {
    const index = h.index++
    h.pending.push({ index, run, deps })
  }
  return { ...react,
    useState: (initial: any) => {
      const index = h.index++
      if (!(index in h.values)) h.values[index] = typeof initial === 'function' ? initial() : initial
      return [h.values[index], (value: any) => {
        const next = typeof value === 'function' ? value(h.values[index]) : value
        if (!Object.is(next, h.values[index])) { h.values[index] = next; h.dirty = true }
      }]
    },
    useRef: (initial: unknown) => { const index = h.index++; return h.values[index] ??= { current: initial } },
    useCallback: (fn: unknown) => fn,
    useEffect: effect, useLayoutEffect: effect,
  }
})
const at = +new Date(2026, 10, 10, 12, 24)
const event = { id: 'event', title: 'Planning', start: at, end: at + 1_800_000, attendees: [], url: null }
const linked = { id: 'note', title: 'Planning', startedAt: at, durationMs: 420_000, eventId: 'event', eventStartedAt: at, eventEndedAt: event.end } as Meeting
const unlinked = { ...linked, eventId: null, eventStartedAt: null, eventEndedAt: null }
function find(node: any, match: (node: any) => boolean): any {
  if (!node || typeof node !== 'object') return undefined
  if (match(node)) return node
  for (const child of [node.props?.children].flat(Infinity)) { const found = find(child, match); if (found) return found }
}
const byId = (tree: any, id: string) => find(tree, node => node.props?.['data-testid'] === id)
const picker = (tree: any) => find(tree, node => node.type?.name === 'EventPicker')
function setup(day: ReturnType<typeof vi.fn>, onClose = vi.fn()) {
  vi.useFakeTimers()
  vi.stubGlobal('requestAnimationFrame', vi.fn())
  vi.stubGlobal('window', { yogurt: { capabilities: { calendar: true }, calendar: { day, onChange: () => () => {} } }, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {} })
  h.values = ['pointer']; h.index = 0
  const first = NoteDate({ m: linked }) as any
  const cardElement = first.props.children[1]
  h.index = 0
  expect((NoteDate({ m: unlinked }) as any).props.children[1].key).toBe(cardElement.key)
  h.values = []; h.effects.clear()
  return (m: Meeting) => {
    let tree: any
    do { h.dirty = false; h.index = 0; h.pending = []; tree = cardElement.type({ ...cardElement.props, m, chip: { current: null }, onClose }) } while (h.dirty)
    for (const effect of h.pending) {
      const old = h.effects.get(effect.index)
      if (!old || !effect.deps || effect.deps.some((dep: unknown, i: number) => !Object.is(dep, old.deps?.[i]))) {
        old?.cleanup?.()
        h.effects.set(effect.index, { deps: effect.deps, cleanup: effect.run() })
      }
    }
    return tree
  }
}
afterEach(() => { for (const effect of h.effects.values()) effect.cleanup?.(); h.effects.clear(); vi.useRealTimers(); vi.unstubAllGlobals() })
it('keeps the card and cached results through unlink, Link event and selecting the event again', async () => {
  const value = { status: 'granted', events: [event] }
  const day = vi.fn().mockResolvedValue(value)
  const render = setup(day)
  render(linked)
  await Promise.resolve(); await Promise.resolve()
  let tree = render(linked)
  byId(tree, 'note-date-events-toggle').props.onClick({ detail: 1 })
  tree = render(linked)
  picker(tree).props.onLinked()
  expect(byId(render(linked), 'note-date-events-toggle').props['aria-expanded']).toBe(true)
  tree = render(unlinked)
  expect(byId(tree, 'note-date-events-toggle').props['aria-expanded']).toBe(false)
  byId(tree, 'note-date-events-toggle').props.onClick({ detail: 1 })
  tree = render(unlinked)
  expect(picker(tree).props.result).toBe(value)
  picker(tree).props.onLinked()
  expect(picker(render(unlinked))).toBeDefined()
  tree = render(linked)
  expect(byId(tree, 'note-date-events-toggle').props['aria-expanded']).toBe(false)
  expect(picker(tree).props.result).toBe(value)
  expect(day).toHaveBeenCalledTimes(1)
  expect(find(tree, node => node.props?.className === 'loading-content')).toBeUndefined()
})
it.each([50, 99])('never inserts a loading placeholder for a %s ms read', async delay => {
  const day = vi.fn(() => new Promise(resolve => setTimeout(() => resolve({ status: 'granted', events: [event] }), delay)))
  const render = setup(day)
  expect(find(render(unlinked), node => node.props?.className === 'loading-content')).toBeUndefined()
  await vi.advanceTimersByTimeAsync(delay)
  expect(find(render(unlinked), node => node.props?.className === 'loading-content')).toBeUndefined()
  await vi.advanceTimersByTimeAsync(200)
  expect(find(render(unlinked), node => node.props?.className === 'loading-content')).toBeUndefined()
})
it('shows the delayed skeleton for a read that remains pending', async () => {
  const render = setup(vi.fn(() => new Promise(() => {})))
  render(unlinked)
  await vi.advanceTimersByTimeAsync(99)
  expect(find(render(unlinked), node => node.props?.className === 'loading-content')).toBeUndefined()
  await vi.advanceTimersByTimeAsync(1)
  expect(find(render(unlinked), node => node.props?.className === 'loading-content')?.props['data-loading-phase']).toBe('skeleton')
})
it('does not expose the previous ready phase as a loading flash when navigating to an uncached day', async () => {
  const day = vi.fn().mockResolvedValueOnce({ status: 'granted', events: [event] }).mockImplementation(() => new Promise(() => {}))
  const render = setup(day)
  render(unlinked)
  await Promise.resolve(); await Promise.resolve()
  render(unlinked)
  let tree = render(unlinked)
  byId(tree, 'note-date-next').props.onClick({ detail: 1 })
  tree = render(unlinked)
  const waitingPicker = picker(tree)
  expect(waitingPicker.props.result).toBeUndefined()
  expect(waitingPicker.props.loading).toBeNull()
  await vi.advanceTimersByTimeAsync(100)
  expect(picker(render(unlinked)).props.loading.props['data-loading-phase']).toBe('skeleton')
})

it('dismisses on Escape and restores the date chip for outside dismissal', () => {
  const close = vi.fn()
  const render = setup(vi.fn(() => new Promise(() => {})), close)
  const preventDefault = vi.fn(), stopPropagation = vi.fn()
  render(unlinked).props.onKeyDown({ key: 'Escape', preventDefault, stopPropagation })
  expect(close).toHaveBeenCalledOnce()
  expect(preventDefault).toHaveBeenCalledOnce()
  expect(stopPropagation).toHaveBeenCalledOnce()
  h.values = ['pointer']; h.index = 0
  const tree = NoteDate({ m: unlinked }) as any
  const focus = vi.fn()
  tree.props.children[0].props.ref.current = { focus }
  tree.props.children[1].props.onClose(false)
  expect(h.values[0]).toBe(false)
  expect(focus).toHaveBeenCalledWith({ preventScroll: true })
})
