import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Children, isValidElement, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { Menu } from '@base-ui/react/menu'
import { CornerMenu } from '../src/renderer/src/components/CornerMenu'
import { cornerLinks, cornerRows, knownRelease, newerRelease, restartState } from '../src/renderer/src/components/cornerMenuModel'
import type { UpdateStatus } from '../src/shared/types'

vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: vi.fn(), useRef: vi.fn(), useEffect: vi.fn() }))
const ready: UpdateStatus = { version: '0.3.9', next: '0.3.10', state: 'ready', available: true, on: true }
const off = vi.fn(), restart = vi.fn(), go = vi.fn(), shortcuts = vi.fn()
let notify: (s: UpdateStatus) => void, initial: (s: UpdateStatus) => void
let values: unknown[], cursor: number, tree: ReactNode
function nodes(node: ReactNode): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap(nodes)
  if (!isValidElement<Record<string, any>>(node)) return []
  return [node, ...nodes(node.props.children)]
}
function render(recording = false, visible = true) {
  cursor = 0
  tree = CornerMenu({ visible, section: '/settings', recording, go, shortcuts })
}
const props = (id: string) => nodes(tree).find(n => n.props['data-testid'] === id)?.props
const root = () => nodes(tree).find(n => n.type === Menu.Root)!.props
function mount() { render(); return vi.mocked(useEffect).mock.lastCall![0]() }
beforeEach(() => {
  vi.clearAllMocks(); values = []; cursor = 0
  vi.mocked(useState).mockImplementation(((initial: unknown) => {
    const i = cursor++
    if (!(i in values)) values[i] = typeof initial === 'function' ? initial() : initial
    return [values[i], (v: unknown) => { values[i] = v }]
  }) as typeof useState)
  vi.mocked(useRef).mockImplementation(((initial: unknown) => {
    const i = cursor++
    return values[i] ??= { current: initial }
  }) as typeof useRef)
  restart.mockResolvedValue(true)
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) })
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn(), yogurt: { updates: {
    status: () => new Promise<UpdateStatus>(resolve => { initial = resolve }),
    onStatus: (fn: typeof notify) => { notify = fn; return off }, restart,
  } } })
})
afterEach(() => vi.unstubAllGlobals())

it('uses the approved seven rows and appends the downloaded version nearest the corner button', () => {
  mount(); notify(ready); render()
  expect(cornerRows).toEqual(['news','github','discord','shortcuts','feedback','settings','trash'])
  const items = nodes(tree).filter(n => n.type === Menu.Item || n.type === Menu.LinkItem)
  expect(items.slice(0,-1).map(n => n.props.label)).toEqual(["What's new",'Star us on GitHub','Join Discord','Keyboard shortcuts','Send feedback','Settings','Trash'])
  expect(items.at(-1)?.props['data-testid']).toBe('update-restart')
  expect(JSON.stringify(tree)).toContain('Restart to update · 0.3.10')
  const links = items.filter(n => n.type === Menu.LinkItem)
  for (const link of links) {
    const trailing = Children.toArray(link.props.children).slice(2) // after the leading icon and label
    expect(trailing.map(node => isValidElement<{ className: string }>(node) ? node.props.className : node))
      .toEqual(link.props.href === cornerLinks.news ? ['corner-row-dot'] : [])
  }
  expect(nodes(tree).filter(n => n.type === 'kbd').map(n => n.props.children)).toEqual(['⌘/', '⌘,', '⌘3'])
  expect(links.map(n => n.props.href)).toEqual([
    'https://yogurt.so/updates', 'https://github.com/FrigadeHQ/yogurt', 'https://yogurt.so/discord',
    'https://github.com/FrigadeHQ/yogurt/issues/new',
  ])
  expect(props('settings-open')!['aria-current']).toBe('page')
  const focus = vi.fn()
  props('corner-menu-button')!.ref.current = { focus }
  for (const [i, item] of ['settings-open', 'nav-trash', 'corner-shortcuts'].entries()) {
    root().onOpenChange(true); render()
    props(item)!.onClick(); render()
    expect(root().open).toBe(false)
    expect(props('corner-menu')!.finalFocus).toBe(false)
    root().onOpenChangeComplete(true)
    expect(focus).toHaveBeenCalledTimes(i)
    root().onOpenChangeComplete(false)
    root().onOpenChangeComplete(false)
    expect(focus).toHaveBeenCalledTimes(i + 1)
  }
  expect(go.mock.calls).toEqual([['/settings'],['/trash']]); expect(shortcuts).toHaveBeenCalledOnce()
})

it('closes the menu with its sidebar and keeps a ready update on the corner trigger', () => {
  mount(); notify(ready); root().onOpenChange(true); render()
  expect(root().open).toBe(true)
  render(false, false)
  expect(root().open).toBe(false)
  vi.mocked(useEffect).mock.calls.find(([, deps]) => deps?.[0] === false)![0]()
  render()
  expect(root().open).toBe(false)
  expect(nodes(props('corner-menu-button')!.children).some(n => n.props['data-testid'] === 'corner-notice-dot')).toBe(true)
})

it('only offers restart after a download, including after Later, and ignores stale reads', async () => {
  const cleanup = mount()
  for (const state of ['checking','idle','latest','error','downloading'] as const) {
    notify({ ...ready, state }); render()
    expect(props('update-restart')).toBeUndefined()
  }
  root().onOpenChange(true); render(); root().onOpenChange(false); render()
  expect(props('update-restart')).toBeUndefined()
  notify(ready); initial({ ...ready, state: 'idle' }); await Promise.resolve(); render()
  expect(props('corner-notice-dot')).toBeDefined()
  notify({ ...ready, dismissed: true }); render(); expect(props('corner-notice-dot')).toBeDefined()
  expect(props('update-restart')).toBeDefined()
  cleanup?.(); notify({ ...ready, state: 'error' }); render()
  expect(props('update-restart')).toBeDefined(); expect(off).toHaveBeenCalledOnce()
})

it('ignores an initial status that arrives after unmount', async () => {
  mount()?.(); initial(ready); await Promise.resolve(); render()
  expect(props('update-restart')).toBeUndefined()
})

it('preserves the recording lockout and never installs just because the menu closed or recording ended', () => {
  mount(); notify(ready); root().onOpenChange(true); render(true)
  expect(restartState(ready,true)).toBe('after-recording'); expect(props('update-restart')!.disabled).toBe(true)
  expect(JSON.stringify(tree)).toContain('You can restart after recording')
  props('update-restart')!.onClick(); root().onOpenChange(false); render(false)
  expect(props('update-restart')!.disabled).toBe(false); expect(restart).not.toHaveBeenCalled()
})

it.each(['false','reject'])('keeps a failed restart visible and retryable (%s)', async result => {
  mount(); notify(ready); root().onOpenChange(true); render()
  if (result === 'false') restart.mockResolvedValueOnce(false)
  else restart.mockRejectedValueOnce(new Error('unavailable'))
  props('update-restart')!.onClick(); props('update-restart')!.onClick(); render()
  expect(props('update-restart')!.disabled).toBe(true); expect(restart).toHaveBeenCalledOnce()
  await vi.waitFor(() => { render(); expect(JSON.stringify(tree)).toContain("Yogurt couldn't restart. Try again.") })
  expect(root().open).toBe(true)
  props('update-restart')!.onClick()
  await vi.waitFor(() => { render(); expect(root().open).toBe(false) })
  expect(restart).toHaveBeenCalledTimes(2)
})

it('remembers a changelog release across remounts and only flags a newer stable release', async () => {
  expect(newerRelease('0.3.10', '0.3.9')).toBe(true)
  expect(newerRelease('1.0.2+build.4','1.0.2')).toBe(false)
  expect(newerRelease('1.0.0-preview.1')).toBe(false)
  expect(knownRelease({ ...ready, next:'0.2.0' })).toBe('0.3.9')
  mount(); notify(ready); render()
  const news = () => nodes(tree).find(n => n.props.href === cornerLinks.news)!.props
  expect(news()['aria-description']).toBe('New')
  await news().onClick(); values = []; render(); notify(ready); render()
  expect(news()['aria-description']).toBeUndefined()
  notify({ ...ready, next:'0.3.11' }); render()
  expect(news()['aria-description']).toBe('New')
})

it('tracks unread release notes on their row and keeps the corner dot tied to the downloaded update', async () => {
  const installed = { ...ready, next: undefined, state: 'latest' as const }
  const news = () => nodes(tree).find(n => n.props.href === cornerLinks.news)!.props
  function expectDots(unread: boolean, waiting: boolean) {
    expect(!!props('corner-notice-dot')).toBe(waiting)
    expect(nodes(news().children).some(n => n.props.className === 'corner-row-dot')).toBe(unread)
    expect(news()['aria-description']).toBe(unread ? 'New' : undefined)
    expect(nodes(news().children).some(n => n.props.children === 'New')).toBe(false)
    expect(nodes(props('update-restart')?.children).some(n => n.props.className === 'corner-row-dot')).toBe(waiting)
  }
  mount(); notify(installed); render()
  expectDots(true, false)
  root().onOpenChange(true); render(); expectDots(true, false)
  await news().onClick(); render(); expectDots(false, false)
  notify(ready); render(); expectDots(true, true)
  root().onOpenChange(false); render(); expectDots(true, true)
  root().onOpenChange(true); render(); expectDots(true, true)
  await news().onClick(); render(); expectDots(false, true)
  props('update-restart')!.onClick(); await Promise.resolve(); render()
  expect(root().open).toBe(false); expectDots(false, true)

  // The old process can reopen before the updater finishes checking its cache.
  values = []; mount(); notify(installed); render()
  expectDots(false, true)
  expect(props('update-restart')!.disabled).toBe(true)
  notify({ ...ready, dismissed: true }); render()
  expectDots(false, true)
  expect(props('update-restart')!.disabled).toBe(false)
  notify({ ...installed, version: ready.next! }); render(); expectDots(false, false)
  notify({ ...ready, version: ready.next!, next: '0.3.11' }); render(); expectDots(true, true)
  notify({ ...installed, version: '0.3.11' }); render(); expectDots(true, false)
  await news().onClick(); render(); expectDots(false, false)
})

it('enables pointer highlighting on movement or entry completion', () => {
  mount()
  for (const moved of [true, false]) {
    root().onOpenChange(true); render()
    props('corner-menu')!.onPointerMove({ movementX: 0, movementY: 0 }); render()
    expect(root().highlightItemOnHover).toBe(false)
    expect(props('corner-menu')!['data-suppress-hover']).toBe(true)
    if (moved) props('corner-menu')!.onPointerMove({ movementX: 1, movementY: 0 })
    else root().onOpenChangeComplete(true)
    render()
    expect(root().highlightItemOnHover).toBe(true)
    expect(props('corner-menu')!['data-suppress-hover']).toBeUndefined()
    root().onOpenChange(false); render()
  }
})
