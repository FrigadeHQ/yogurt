import { afterEach, expect, it, vi } from 'vitest'
import { useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { Search } from '../src/renderer/src/components/Search'
import { Ask } from '../src/renderer/src/components/Chat'
import { AskConversation } from '../src/renderer/src/components/AskConversation'
import type { ConversationView } from '../src/shared/types'
import { Workspace } from '../src/renderer/src/components/Workspace'
import { FoldersNav } from '../src/renderer/src/components/FoldersNav'

vi.mock('react', async original => ({
  ...await original<typeof import('react')>(), useState: vi.fn(), useRef: vi.fn(), useEffect: vi.fn(), useLayoutEffect: vi.fn(),
}))
vi.mock('motion/react', async original => ({ ...await original<typeof import('motion/react')>(), useDragControls: () => ({ start: vi.fn() }) }))
vi.mock('react-dom', async original => ({ ...await original<typeof import('react-dom')>(), createPortal: (children: ReactNode) => children }))
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
    vi.mocked(useLayoutEffect).mockClear()
    return component()
  }
}

it.each(['/meetings', '/note/m1'])('keeps the original folder reorder animation across sidebar toggles on %s', route => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) })
  const folders = [{ id: 'f1', name: 'Planning', icon: 'calendar' as const, color: 'violet' as const, count: 2, createdAt: 1 }]
  let collapsed = false
  const nav = renderer(() => FoldersNav({ folders, route, collapsed, go() {} }))
  let item: ReactElement<any>
  const row = renderer(() => (item.type as Function)(item.props))
  const render = () => {
    item = find(nav(), 'folder-reorder-list').props.children[0]
    const element = find(row(), 'sidebar-folder')
    expect(element.props.layout).toBeUndefined()
    expect(element.props.dragControls).toBeDefined()
    expect(element.props.onDragStart).toBeTypeOf('function')
    return element
  }
  expect(render().props.transition).toMatchObject({ type: 'spring' })
  for (const next of [true, false, true, false]) {
    collapsed = next
    expect(render().props.transition).toEqual({ type: 'spring', stiffness: 520, damping: 42 })
  }
})
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

it.each([false, true])('keeps the composer clip inside the growing shape through open, close and reversal (narrow: %s)', narrow => {
  const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height, top: y, left: x, right: x + width, bottom: y + height })
  const to = narrow ? rect(16, 16, 328, 640) : rect(760, 200, 420, 440)
  // Exercise a button outside the final panel, anchored on either side.
  const from = narrow ? rect(20, 700, 140, 30) : rect(1040, 670, 140, 30)
  const box = rect(to.x + 1, to.y + 1, to.width - 2, to.height - 2)
  const node = (bounds: ReturnType<typeof rect>, computed: Record<string, string>) => ({
    getBoundingClientRect: () => bounds, computed,
    animate: vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => ({
      playState: 'running', cancel() { this.playState = 'idle' }, finished: new Promise<void>(() => {}),
    })),
  })
  const button = { ...node(from, { opacity: '1', borderRadius: '6px' }), focus: vi.fn() }
  const shell = node(to, { left: '-1px', top: '-1px', width: `${to.width}px`, height: `${to.height}px`, borderRadius: '12px', opacity: '1' })
  const body = node(box, { clipPath: 'none', opacity: '1' })
  const input = { focus: vi.fn() }
  const dialog = { ...node(to, { opacity: '1' }), style: { setProperty() {} }, show() {}, showModal() {}, close() {}, querySelector: () => input }
  const anchor = { getBoundingClientRect: () => to } as HTMLElement
  vi.stubGlobal('window', { matchMedia: (query: string) => ({ matches: query.includes('max-width') && narrow }), addEventListener() {}, removeEventListener() {} })
  vi.stubGlobal('innerHeight', 800)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('getComputedStyle', (element: { computed: Record<string, string> }) => element.computed)
  const render = renderer(() => Ask({ id: 'morph', recording: false, anchor, onSource() {} }))
  let tree = render()
  find(tree, 'chat-open').props.ref.current = button
  find(tree, 'chat-open').props.onClick()
  tree = render()
  const panel = find(tree, 'chat-panel')
  panel.props.ref.current = dialog
  panel.props.children[0].props.ref.current = shell
  panel.props.children[1].props.ref.current = body
  // The conversation mounts before its ID resolves; clipping must not postpone the editable composer.
  expect(panel.props.children[1].props.children[1].props).toMatchObject({ id: '', panel: true, pendingDraftKey: 'meeting/morph' })
  vi.mocked(useLayoutEffect).mock.lastCall![0]()
  expect(input.focus).toHaveBeenCalledWith({ preventScroll: true })

  const lerp = (a: string, b: string, p: number) => parseFloat(a) + (parseFloat(b) - parseFloat(a)) * p
  const clip = (value: string) => {
    const n = value.match(/-?\d+(?:\.\d+)?/g)!.map(Number)
    return n.length === 2 ? [n[0], n[0], n[0], n[0], n[1]] : n
  }
  const check = (expand: boolean) => {
    const [shape, shapeTiming] = shell.animate.mock.calls.at(-2)!
    const [crop, cropTiming] = body.animate.mock.calls.at(-2)!
    expect(shapeTiming.duration).toBe(cropTiming.duration)
    expect(shapeTiming.easing).toBe(cropTiming.easing)
    expect(cropTiming.fill).toBe(expand ? 'backwards' : 'forwards')
    expect(shapeTiming.fill).toBe('both')
    expect(shape[1].width).toBe(expand ? 'calc(100% + 2px)' : `${from.width}px`)
    expect(shape.every(frame => !frame.transform)).toBe(true)
    const at = (p: number) => {
      const used = (frame: Keyframe, key: string) => String(frame[key]).includes('100%') ? `${to[key as 'width' | 'height']}px` : String(frame[key])
      const bounds = Object.fromEntries(['left', 'top', 'width', 'height', 'borderRadius'].map(key => [key, lerp(used(shape[0], key), used(shape[1], key), p)]))
      const start = clip(String(crop[0].clipPath)), end = clip(String(crop[1].clipPath))
      const inset = start.map((value, i) => value + (end[i] - value) * p)
      return { bounds, inset }
    }
    // All intermediate rectangles AND rounded corners agree, not just the two endpoints.
    for (let frame = 0; frame <= 100; frame++) {
      const { bounds, inset: [top, right, bottom, left, radius] } = at(frame / 100)
      expect(box.left + left).toBeCloseTo(to.left + 1 + bounds.left + 1)
      expect(box.top + top).toBeCloseTo(to.top + 1 + bounds.top + 1)
      expect(box.right - right).toBeCloseTo(to.left + 1 + bounds.left + bounds.width - 1)
      expect(box.bottom - bottom).toBeCloseTo(to.top + 1 + bounds.top + bounds.height - 1)
      expect(radius).toBeCloseTo(bounds.borderRadius - 1)
    }
    // A fast toggle resumes from the same on-screen bounds and radius.
    const { bounds, inset } = at(.4)
    Object.assign(shell.computed, Object.fromEntries(Object.entries(bounds).map(([key, value]) => [key, `${value}px`])))
    body.computed.clipPath = `inset(${inset.slice(0, 4).map(n => `${n}px`).join(' ')} round ${inset[4]}px)`
  }
  check(true)
  find(tree, 'chat-open').props.onClick()
  check(false)
  find(tree, 'chat-open').props.onClick()
  check(true)
  for (const element of [shell, body, button, dialog]) {
    for (const result of element.animate.mock.results) result.value.playState = 'finished'
  }
  Object.assign(shell.computed, { left: '-1px', top: '-1px', width: `${to.width}px`, height: `${to.height}px`, borderRadius: '12px' })
  body.computed.clipPath = 'none'
  find(tree, 'chat-open').props.onClick()
  check(false)
})


it.each(['send', 'load', 'resolve'] as const)('keeps an early Enter through loading, without duplicate requests or a lost draft (%s failure)', async failure => {
  let id = '', loadError = false
  let loaded!: (view: ConversationView) => void, loadFailed!: (error: Error) => void, rejected!: (error: Error) => void
  const get = vi.fn(() => new Promise<ConversationView>((resolve, reject) => { loaded = resolve; loadFailed = reject }))
  const ask = vi.fn(() => new Promise<string>((_resolve, reject) => { rejected = reject }))
  const draft = vi.fn().mockResolvedValue(undefined)
  const body = {}
  vi.stubGlobal('document', { body, activeElement: body })
  vi.stubGlobal('window', { yogurt: {
    conversations: { get, ask, draft, onChange: () => () => {} },
    meetings: { onChange: () => () => {} }, folders: { onChange: () => () => {} },
  } })
  const render = renderer(() => AskConversation({ id, loadError, pendingDraftKey: `meeting/early-${failure}`, panel: true, onSelect() {}, onDeleted() {}, onSource() {} }))
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }
  const drain = () => vi.mocked(useEffect).mock.calls.find(([, deps]) => deps?.length === 2 && deps[1] === loadError)![0]()
  const enter = (tree: ReactNode) => find(tree, 'chat-input').props.onKeyDown({ key: 'Enter', nativeEvent: {}, preventDefault() {} })
  let tree = render()
  const focus = vi.fn()
  find(tree, 'chat-input').props.ref.current = { focus }
  find(tree, 'chat-input').props.onChange({ target: { value: 'Who owns the next step?', selectionStart: 23 } })
  tree = render()
  enter(tree)
  tree = render()
  expect(find(tree, 'chat-input').props.readOnly).toBe(true)
  expect(focus).toHaveBeenCalledWith({ preventScroll: true })
  enter(tree)
  expect(ask).not.toHaveBeenCalled()
  if (failure === 'resolve') {
    loadError = true
    tree = render(); drain(); tree = render()
  } else {
    id = `early-${failure}`
    tree = render()
    vi.mocked(useEffect).mock.calls.find(([, deps]) => deps?.length === 1 && deps[0] === id)![0]()
    if (failure === 'load') loadFailed(new Error('read failed'))
    else loaded({ id, title: '', draft: '', chips: [], draftChips: [], firstChips: null, turns: [], waitsForMeeting: false, waitsForModel: false })
    await flush()
    tree = render(); drain(); tree = render(); drain()
    if (failure === 'send') {
      enter(tree)
      expect(ask).toHaveBeenCalledExactlyOnceWith(id, 'Who owns the next step?')
      rejected(new Error('request failed'))
      await flush()
    } else expect(ask).not.toHaveBeenCalled()
    tree = render()
  }
  expect(find(tree, 'chat-input').props.readOnly).toBe(false)
  expect(find(tree, 'chat-input').props.value).toBe('Who owns the next step?')
  if (failure === 'send') {
    expect(find(tree, 'chat-send').props.disabled).toBe(false)
    enter(tree)
    expect(ask).toHaveBeenCalledTimes(2)
  }
})
