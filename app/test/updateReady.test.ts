import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { isValidElement, useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { Popover } from '@base-ui/react/popover'
import { UpdateReady } from '../src/renderer/src/components/UpdateReady'
import type { UpdateStatus } from '../src/shared/types'

vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: vi.fn(), useEffect: vi.fn() }))
let values: unknown[], cursor: number, tree: ReactNode
let notify: (status: UpdateStatus) => void
let initial: (status: UpdateStatus) => void
const off = vi.fn(), restart = vi.fn(), later = vi.fn()
const ready: UpdateStatus = { version: '0.3.1', next: '0.3.2', state: 'ready', available: true, on: true }
function nodes(node: ReactNode): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap(nodes)
  if (!isValidElement<Record<string, any>>(node)) return []
  return [node, ...nodes(node.props.children)]
}
function render(recording = false) { cursor = 0; tree = UpdateReady({ recording }); return tree }
const control = (id: string) => nodes(tree).find(n => n.props['data-testid'] === id)!.props
const root = () => nodes(tree).find(n => n.type === Popover.Root)!.props
const content = () => JSON.stringify(tree)
function mount() { render(); return vi.mocked(useEffect).mock.calls[0][0]() }
beforeEach(() => {
  vi.clearAllMocks(); values = []; cursor = 0
  vi.mocked(useState).mockImplementation(((value: unknown) => {
    const index = cursor++
    if (!(index in values)) values[index] = value
    return [values[index], (next: unknown) => { values[index] = next }]
  }) as typeof useState)
  restart.mockResolvedValue(true)
  later.mockImplementation(async () => notify({ ...ready, dismissed: true }))
  vi.stubGlobal('window', { yogurt: { updates: {
    status: () => new Promise<UpdateStatus>(resolve => { initial = resolve }),
    onStatus: (fn: typeof notify) => { notify = fn; return off }, restart, later,
  } } })
})
afterEach(() => vi.unstubAllGlobals())

it('shows only ready, uses the downloaded version, and never lets the initial read overwrite an event', async () => {
  const cleanup = mount()
  for (const state of ['idle', 'checking', 'downloading', 'latest', 'error'] as const) {
    notify({ ...ready, state }); expect(render()).toBeNull()
  }
  notify(ready); initial({ ...ready, state: 'idle' }); await Promise.resolve(); render()
  expect(control('update-ready').title).toBe('Update ready')
  expect(content()).toContain('Yogurt 0.3.2')
  expect(content()).not.toContain('Yogurt 0.3.1')
  cleanup?.(); notify({ ...ready, state: 'latest' }); render()
  expect(control('update-ready')).toBeDefined(); expect(off).toHaveBeenCalledOnce()
})

it('ignores a pending status read after unmount', async () => {
  const cleanup = mount(); cleanup?.(); initial(ready); await Promise.resolve()
  expect(render()).toBeNull(); expect(off).toHaveBeenCalledOnce()
})

it('closing the popover keeps the pill and does not restart', async () => {
  mount(); initial(ready); await Promise.resolve(); render()
  root().onOpenChange(true); render(); expect(root().open).toBe(true)
  root().onOpenChange(false); render()
  expect(control('update-ready')).toBeDefined(); expect(root().open).toBe(false)
  expect(restart).not.toHaveBeenCalled()
})

it('disables Restart while recording and enables it afterward without restarting', () => {
  mount(); notify(ready); render(true)
  expect(control('update-restart').disabled).toBe(true)
  expect(content()).toContain('You can restart after recording')
  control('update-restart').onClick(); expect(restart).not.toHaveBeenCalled()
  render(false); expect(control('update-restart').disabled).toBe(false)
  expect(content()).toContain('Installs when you restart Yogurt')
  expect(restart).not.toHaveBeenCalled()
})

it.each(['false', 'reject'] as const)('retains ready and the open popover if restart returns %s, and allows retry', async result => {
  mount(); notify(ready); render(); root().onOpenChange(true); render()
  if (result === 'false') restart.mockResolvedValueOnce(false)
  else restart.mockRejectedValueOnce(new Error('unavailable'))
  control('update-restart').onClick(); render()
  expect(control('update-restart').disabled).toBe(true)
  await vi.waitFor(() => { render(); expect(control('update-restart').disabled).toBe(false) })
  expect(control('update-ready')).toBeDefined(); expect(root().open).toBe(true)
  expect(content()).toContain("Yogurt couldn't restart. Try again.")
  control('update-restart').onClick()
  await vi.waitFor(() => { render(); expect(root().open).toBe(false) })
  expect(restart).toHaveBeenCalledTimes(2)
  notify({ ...ready, state: 'latest' }); expect(render()).toBeNull()
})

it('Later hides the version across remounts, then a newer ready version returns', async () => {
  mount(); initial(ready); await Promise.resolve(); render(); root().onOpenChange(true); render()
  control('update-later').onClick(); await Promise.resolve()
  expect(render()).toBeNull(); expect(later).toHaveBeenCalledOnce(); expect(restart).not.toHaveBeenCalled()
  values = []; mount(); initial({ ...ready, dismissed: true }); await Promise.resolve()
  expect(render()).toBeNull()
  notify({ ...ready, next: '0.3.3', dismissed: false }); render()
  expect(control('update-ready')).toBeDefined(); expect(content()).toContain('Yogurt 0.3.3')
})

it('keeps the pill and popover available if Later fails', async () => {
  mount(); notify(ready); render(); root().onOpenChange(true); render()
  later.mockRejectedValueOnce(new Error('unavailable'))
  control('update-later').onClick()
  await vi.waitFor(() => { render(); expect(content()).toContain("Yogurt couldn't make that change. Try again.") })
  expect(root().open).toBe(true); expect(control('update-ready')).toBeDefined()
})
