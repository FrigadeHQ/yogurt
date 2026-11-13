import { afterEach, expect, it, vi } from 'vitest'
import { createElement, useLayoutEffect } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { StartRecording } from '../src/renderer/src/components/StartRecording'
import type { WidgetView } from '../src/shared/types'

vi.mock('react', async importOriginal => {
  const react = await importOriginal<typeof import('react')>()
  return { ...react, useLayoutEffect: vi.fn(), useState: (initial: unknown) => react.useState(initial === null ? { nodeType: 1 } : initial) }
})
vi.mock('react-dom', () => ({ createPortal: (children: unknown) => children }))
vi.mock('../src/renderer/src/components/TrashToast', () => ({ toasts: { add: vi.fn(), close: vi.fn() } }))
afterEach(() => vi.unstubAllGlobals())

it('hides unknown recording state and retains state across remounts without accepting an older read', async () => {
  let update!: (view: WidgetView | null) => void
  let reply!: (view: WidgetView | null) => void
  const off = vi.fn()
  vi.stubGlobal('document', { getElementById: () => ({ nodeType: 1 }) })
  vi.stubGlobal('window', { yogurt: { widget: {
    onState: (cb: typeof update) => { update = cb; return off },
    state: () => new Promise<WidgetView | null>(resolve => { reply = resolve }),
  } } })
  const render = () => renderToStaticMarkup(createElement(StartRecording))
  expect(render()).toBe('')
  const cleanup = vi.mocked(useLayoutEffect).mock.calls.at(-1)![0]()
  update({ kind: 'recording' } as WidgetView)
  reply(null)
  await Promise.resolve()
  cleanup?.()
  expect(off).toHaveBeenCalledOnce()
  expect(render()).toBe('')

  const stop = vi.mocked(useLayoutEffect).mock.calls.at(-1)![0]()
  reply(null)
  await Promise.resolve()
  stop?.()
  expect(render()).toContain('Start recording')
  expect(render()).not.toContain('disabled')
})
