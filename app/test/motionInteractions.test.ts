import { afterEach, expect, it, vi } from 'vitest'
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { Search } from '../src/renderer/src/components/Search'
import { Ask } from '../src/renderer/src/components/Chat'
import { Workspace } from '../src/renderer/src/components/Workspace'

vi.mock('react', async original => ({
  ...await original<typeof import('react')>(), useState: vi.fn(), useRef: vi.fn(), useEffect: vi.fn(), useLayoutEffect: vi.fn(),
}))
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

// Exercise the component's handlers and state without starting Electron or a browser.
function renderer(component: () => ReactNode) {
  const states: unknown[] = [], refs: { current: unknown }[] = []
  return () => {
    let state = 0, ref = 0
    vi.mocked(useState).mockImplementation((initial?: unknown): [unknown, (next: unknown) => void] => {
      const i = state++
      if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial
      return [states[i], next => { states[i] = typeof next === 'function' ? next(states[i]) : next }]
    })
    vi.mocked(useRef).mockImplementation(initial => refs[ref++] ??= { current: initial })
    vi.mocked(useEffect).mockClear()
    return component()
  }
}
function find(node: ReactNode, testId: string): ReactElement<any> {
  const visit = (value: ReactNode): ReactElement<any> | undefined => {
    if (Array.isArray(value)) return value.map(visit).find(Boolean)
    if (!value || typeof value !== 'object' || !('props' in value)) return
    const element = value as ReactElement<any>
    if (element.props['data-testid'] === testId || element.props.id === testId) return element
    return visit(element.props.children)
  }
  const result = visit(node)
  if (!result) throw new Error(`Missing ${testId}`)
  return result
}

it('keeps initial search results still, ignores stationary hover, and scrolls only for keyboard selection', async () => {
  const meetings = [{ meetingId: 'm1', title: 'Recent meeting', startedAt: 1000, parts: [] }]
  vi.stubGlobal('document', { activeElement: null })
  vi.stubGlobal('HTMLButtonElement', class {})
  vi.stubGlobal('window', { yogurt: { search: { query: vi.fn().mockResolvedValue(meetings) } } })
  const render = renderer(() => Search({ onOpen() {}, onNavigate() {}, onSettingsChange() {}, onShortcuts() {}, onClose() {}, sidebarCollapsed: false, onToggleSidebar() {} }))
  const scrollIntoView = vi.fn()
  const scroll = () => { vi.mocked(useEffect).mock.lastCall![0]() }
  let tree = render()
  find(tree, 'search-results').props.ref.current = { querySelector: () => ({ scrollIntoView }) }
  expect(find(tree, 'search-results').props.className).toContain('[overflow-anchor:none]')
  expect(find(tree, 'search-intent-icon').props['data-icon']).toBe('search')
  scroll()
  expect(scrollIntoView).not.toHaveBeenCalled()
  // Recent meetings arrive after the initial commands, without scrolling the commands back into view.
  vi.mocked(useEffect).mock.calls.find(([, deps]) => deps?.length === 6)![0]()
  await Promise.resolve()
  tree = render(); scroll()
  expect(find(tree, 'search-result').props['aria-selected']).toBe(true)
  expect(scrollIntoView).not.toHaveBeenCalled()
  find(tree, 'command-meetings').props.onMouseMove({ movementX: 0, movementY: 0 })
  tree = render(); scroll()
  expect(find(tree, 'search-result').props['aria-selected']).toBe(true)
  expect(find(tree, 'search-intent-icon').props['data-icon']).toBe('search')
  find(tree, 'command-meetings').props.onMouseMove({ movementX: 1, movementY: 0 })
  tree = render(); scroll()
  expect(find(tree, 'command-meetings').props['aria-selected']).toBe(true)
  expect(find(tree, 'search-intent-icon').props.children.type.displayName).toBe('FileText')
  expect(scrollIntoView).not.toHaveBeenCalled()
  find(tree, 'search').props.onKeyDown({ key: 'ArrowDown', nativeEvent: {}, preventDefault() {} })
  tree = render(); scroll()
  expect(find(tree, 'command-chat').props['aria-selected']).toBe(true)
  expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
  scrollIntoView.mockClear()
  find(tree, 'command-meetings').props.onMouseMove({ movementX: 0, movementY: 0 })
  tree = render()
  expect(find(tree, 'command-chat').props['aria-selected']).toBe(true)
  find(tree, 'search-result').props.onMouseMove({ movementX: 0, movementY: 1 })
  tree = render(); scroll()
  expect(find(tree, 'search-result').props['aria-selected']).toBe(true)
  expect(scrollIntoView).not.toHaveBeenCalled()
})

it.each(['darwin', 'win32'])('toggles the meeting panel once per shortcut press on %s', os => {
  const listeners = new Map<string, (e: any) => void>()
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }), addEventListener: (name: string, fn: (e: any) => void) => listeners.set(name, fn), removeEventListener() {},
    yogurt: { os, nav: { onAsk: () => () => {}, takeAsk: vi.fn().mockResolvedValue(false) } } })
  const renderAsk = renderer(() => Ask({ id: 'm1', recording: false, anchor: null, onSource() {} }))
  let tree = renderAsk()
  const click = vi.fn(() => { find(tree, 'chat-open').props.onClick(); tree = renderAsk() })
  const querySelector = vi.fn().mockReturnValue(null)
  vi.stubGlobal('document', { querySelector, getElementById: () => ({ click }) })
  const renderWorkspace = renderer(() => Workspace({ route: '/note/m1', go() {}, search() {}, collapsed: false, sidebarMotion: false, toggleSidebar() {}, children: null }))
  renderWorkspace()
  vi.mocked(useEffect).mock.lastCall![0]()
  const press = (extra = {}) => listeners.get('keydown')!({ code: 'KeyJ', metaKey: os === 'darwin', ctrlKey: os !== 'darwin', preventDefault() {}, ...extra })
  expect(find(tree, 'chat-open').props['aria-expanded']).toBe(false)
  press()
  expect(find(tree, 'chat-open').props['aria-expanded']).toBe(true)
  press({ repeat: true }); press({ isComposing: true }); press({ defaultPrevented: true })
  expect(click).toHaveBeenCalledTimes(1)
  expect(find(tree, 'chat-open').props['aria-expanded']).toBe(true)
  press()
  expect(find(tree, 'chat-open').props['aria-expanded']).toBe(false)
  press()
  expect(find(tree, 'chat-open').props['aria-expanded']).toBe(true)
  querySelector.mockReturnValue({})
  press()
  expect(click).toHaveBeenCalledTimes(3)
})
