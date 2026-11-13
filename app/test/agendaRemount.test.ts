import { afterEach, expect, it, vi } from 'vitest'
import { createElement, useEffect, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Agenda } from '../src/renderer/src/components/Agenda'
import type { AgendaEvent } from '../src/shared/types'

vi.mock('react', async importOriginal => ({ ...await importOriginal<typeof import('react')>(), useEffect: vi.fn() }))
vi.mock('../src/renderer/src/components/ScrollFade', () => ({ ScrollFade: ({ children }: { children: ReactNode }) => children }))
vi.mock('../src/renderer/src/components/TrashToast', () => ({ toasts: { add: vi.fn(), close: vi.fn() } }))
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

it('renders the last day and its people immediately on remount, refreshes quietly, and invalidates offscreen', async () => {
  vi.useFakeTimers()
  const event: AgendaEvent = { id: 'event', title: 'Example meeting', start: Date.now(), end: Date.now() + 60_000,
    attendees: [{ name: 'Participant A', email: null }], url: null }
  const day = vi.fn().mockResolvedValueOnce({ status: 'granted', events: [event] })
    .mockImplementation(() => new Promise(() => {}))
  const listeners = new Set<() => void>()
  vi.stubGlobal('window', {
    addEventListener: vi.fn(), removeEventListener: vi.fn(), matchMedia: () => ({ matches: true }),
    yogurt: { calendar: { day, onChange: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb) } },
      meetings: { onChange: () => () => {} } },
  })
  const render = () => {
    vi.mocked(useEffect).mockClear()
    return renderToStaticMarkup(createElement(Agenda, { revision: 0, onStart: async () => {}, onOpen() {} }))
  }
  const load = () => vi.mocked(useEffect).mock.calls.find(([, deps]) => deps?.length === 3 && typeof deps[0] === 'function')![0]()
  expect(render()).toContain('agenda-skeleton')
  const cleanup = load()
  await vi.waitFor(() => expect(render()).toContain('Example meeting'))
  cleanup?.()

  const cached = render()
  expect(cached).toContain('Participant')
  expect(cached).not.toContain('agenda-skeleton')
  expect(cached).toContain('data-loading-phase="ready"')
  const refreshCleanup = load()
  expect(day).toHaveBeenCalledTimes(2)
  expect(render()).toContain('Example meeting')
  refreshCleanup?.()
  for (const changed of listeners) changed()
  expect(render()).toContain('agenda-skeleton')
  expect(render()).not.toContain('Example meeting')
})
