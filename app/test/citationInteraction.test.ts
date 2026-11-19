import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { AnswerText } from '../src/renderer/src/components/AnswerText'
import type { Popover } from '@base-ui/react/popover'

vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useEffect: vi.fn(), useId: vi.fn(), useLayoutEffect: vi.fn(), useMemo: vi.fn(), useRef: vi.fn(), useState: vi.fn() }))
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals() })

function harness() {
  const states: unknown[] = [], refs: Array<{ current: unknown }> = []
  const effects: Array<() => void> = []
  let stateIndex = 0, refIndex = 0
  const trigger = { id: 'first', getAttribute: () => 'popup', matches: vi.fn(() => false), focus: vi.fn() }
  const popup = { contains: vi.fn(() => false), matches: vi.fn(() => false) }
  const doc = { activeElement: null as unknown, getElementById: (id: string) => id === 'first' ? trigger : id === 'popup' ? popup : null }
  vi.stubGlobal('document', doc)
  vi.mocked(useId).mockReturnValue('answer')
  vi.mocked(useLayoutEffect).mockImplementation(effect => { effects.push(effect) })
  vi.mocked(useMemo).mockImplementation(fn => fn())
  vi.mocked(useRef).mockImplementation(initial => refs[refIndex++] ?? (refs[refIndex - 1] = { current: initial }) as never)
  vi.mocked(useState).mockImplementation((initial?: unknown): [unknown, (next: unknown) => void] => {
    const i = stateIndex++
    if (!(i in states)) states[i] = initial
    return [states[i], next => { states[i] = next }]
  })
  const render = () => {
    stateIndex = 0; refIndex = 0; effects.length = 0
    return AnswerText({ md: 'A decision.', live: false, sources: [], onSource: vi.fn() }) as ReactElement<Popover.Root.Props>
  }
  const change = (next: boolean, reason: Popover.Root.ChangeEventReason, id = 'first') => {
    const cancel = vi.fn()
    render().props.onOpenChange!(next, { reason, trigger: { id }, event: { detail: 1 }, cancel } as unknown as Popover.Root.ChangeEventDetails)
    return { open: render().props.open, triggerId: render().props.triggerId, cancel }
  }
  const close = vi.fn(), unmount = vi.fn()
  const commit = () => {
    const root = render()
    close.mockImplementation(() => root.props.onOpenChange!(false, { reason: 'imperative-action', cancel: vi.fn() } as unknown as Popover.Root.ChangeEventDetails))
    root.props.actionsRef!.current = { close, unmount }
    effects.forEach(effect => effect())
    return render().props
  }
  return { change, commit, close, unmount, doc, popup, trigger }
}

it('pins even a patient click on a hover preview, ignores hover exits, and toggles on the next press', () => {
  const h = harness()
  expect(h.change(true, 'trigger-hover').open).toBe(true)
  const press = h.change(false, 'trigger-press')
  expect(press.cancel).toHaveBeenCalledOnce()
  expect(press.open).toBe(true)
  expect(h.change(false, 'trigger-hover').open).toBe(true)
  expect(h.change(false, 'focus-out').open).toBe(true)
  expect(h.change(false, 'trigger-press').open).toBe(false)
})

it.each(['escape-key', 'outside-press'] as const)('%s dismisses a pinned citation', reason => {
  const h = harness()
  h.change(true, 'trigger-press')
  expect(h.change(false, reason).open).toBe(false)
  expect(h.change(true, 'trigger-hover', 'second').triggerId).toBe('second')
})

it('does not let another hover replace a pinned source, but another press can', () => {
  const h = harness()
  h.change(true, 'trigger-press')
  expect(h.change(true, 'trigger-hover', 'second').triggerId).toBe('first')
  expect(h.change(true, 'trigger-press', 'second').triggerId).toBe('second')
})

it('keeps a hovered preview open while the trigger or popup has focus', () => {
  const h = harness()
  h.change(true, 'trigger-hover')
  h.doc.activeElement = h.trigger
  expect(h.change(false, 'trigger-hover').open).toBe(true)
  h.doc.activeElement = null; h.popup.contains.mockReturnValue(true)
  expect(h.change(false, 'trigger-hover').open).toBe(true)
  h.popup.contains.mockReturnValue(false)
  expect(h.change(false, 'trigger-hover').open).toBe(false)
})

it('focus leaving a hovered popup does not close it until the pointer leaves too', () => {
  const h = harness()
  h.change(true, 'trigger-hover'); h.popup.matches.mockReturnValue(true)
  expect(h.change(false, 'focus-out').open).toBe(true)
  h.popup.matches.mockReturnValue(false)
  expect(h.change(false, 'focus-out').open).toBe(false)
})

it('closes through the popover API when a streamed citation removes its pinned trigger', () => {
  const h = harness()
  h.change(true, 'trigger-press')
  h.doc.getElementById = () => null
  expect(h.commit().open).toBe(false)
  expect(h.close).toHaveBeenCalledOnce()
  expect(h.commit().triggerId).toBe(null)
  expect(h.unmount).toHaveBeenCalledOnce()
  expect(h.change(true, 'trigger-hover', 'second').open).toBe(true)
})
