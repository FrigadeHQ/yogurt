import { CalendarDays, Check, ICON_STROKE_WIDTH } from '../src/renderer/src/components/Icons'
import { renderToStaticMarkup } from 'react-dom/server'
import { App } from '../src/renderer/src/App'
import { afterEach, expect, it, vi } from 'vitest'
import { useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { useDialogFocus } from '../src/renderer/src/useDialogFocus'
import { useMeetingDateJump } from '../src/renderer/src/meetingDateJump'
import { Search } from '../src/renderer/src/components/Search'
import { Ask } from '../src/renderer/src/components/Chat'
import { AskContext, scopeLabel } from '../src/renderer/src/components/AskContext'
import { AskConversation } from '../src/renderer/src/components/AskConversation'
import type { ConversationView } from '../src/shared/types'
import { Workspace } from '../src/renderer/src/components/Workspace'
import { FoldersNav } from '../src/renderer/src/components/FoldersNav'
import { toasts } from '../src/renderer/src/components/TrashToast'
import { InlineError } from '../src/renderer/src/components/InlineError'
import { Agenda } from '../src/renderer/src/components/Agenda'

vi.mock('react', async original => ({
  ...await original<typeof import('react')>(), useState: vi.fn(), useRef: vi.fn(), useEffect: vi.fn(), useLayoutEffect: vi.fn(),
  useCallback: (callback: unknown) => callback, useContext: vi.fn(),
}))
vi.mock('motion/react', async original => ({ ...await original<typeof import('motion/react')>(), useDragControls: () => ({ start: vi.fn() }) }))
vi.mock('react-dom', async original => ({ ...await original<typeof import('react-dom')>(), createPortal: (children: ReactNode) => children }))
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); vi.useRealTimers() })

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

it.each([false, true])('returns through a replaced dialog to the original opener (visible %s)', async keyboard => {
  class Target {
    isConnected = true
    focus = vi.fn()
    constructor(readonly dialog: Target | null = null) {}
    matches() { return keyboard }
    closest() { return this.dialog }
  }
  vi.stubGlobal('HTMLElement', Target)
  const opener = new Target(), palette = new Target(), field = new Target(palette), help = new Target()
  const doc = { activeElement: opener, body: new Target(), documentElement: new Target() }
  vi.stubGlobal('document', doc)
  function mount(popup: Target) {
    renderer(() => { useDialogFocus().popupRef(popup as unknown as HTMLDivElement); return null })()
    return vi.mocked(useEffect).mock.calls.at(-1)![0]() as () => void
  }
  const closePalette = mount(palette)
  doc.activeElement = field
  const closeHelp = mount(help)
  field.isConnected = false
  doc.activeElement = new Target(help)
  closePalette()
  await Promise.resolve()
  expect(opener.focus).not.toHaveBeenCalled()
  doc.activeElement = doc.body
  closeHelp()
  await Promise.resolve()
  expect(opener.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true, focusVisible: keyboard })
})

it.each([false, true])('preserves the folder reorder spring and respects reduced motion (%s)', reduced => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: reduced }) })
  const folders = [{ id: 'f1', name: 'Planning', icon: 'calendar' as const, color: 'violet' as const, count: 2, createdAt: 1 }]
  const nav = renderer(() => FoldersNav({ folders, route: '', go() {} }))()
  const item = find(nav, 'folder-reorder-list').props.children[0]
  const row = find(renderer(() => item.type(item.props))(), 'sidebar-folder')
  expect(row.props.dragControls).toBeDefined()
  expect(row.props.onDragStart).toBeTypeOf('function')
  expect(row.props.transition).toEqual(reduced ? { duration: 0 } : { type: 'spring', stiffness: 520, damping: 42 })
})

it('names the Folders heading and New folder tooltip', () => {
  const tree = renderer(() => FoldersNav({ folders: [], route: '', go() {} }))()
  const nav = find(tree, 'sidebar-folders')
  const [heading, tooltip] = find(nav, 'workspace-folder-header').props.children
  expect(heading.type).toBe('h2')
  const toggle = find(heading, 'workspace-folders-toggle').props
  expect(toggle['aria-label']).toBe('Folders')
  expect(toggle.children[0].props.children).toBe('Folders')
  expect(toggle.title).toBeUndefined()
  const plus = find(tooltip, 'folder-create').props
  expect(plus['aria-label']).toBe('New folder')
  expect(plus.title).toBeUndefined()
  expect(find(tooltip, 'ActionTooltipPopup').props.label).toBe(plus['aria-label'])
})

it.each(['ltr', 'rtl'])('peeks after a 100ms dwell within the leading 16px below the titlebar (%s)', dir => {
  vi.useFakeTimers()
  vi.stubGlobal('document', { documentElement: { dir }, activeElement: {}, querySelector: () => null })
  vi.stubGlobal('window', { innerWidth: 720 })
  const go = vi.fn()
  const render = renderer(() => Workspace({ route: '', go, search() {}, shortcuts() {}, dismissDialogs() {}, collapsed: true, sidebarMotion: false, toggleSidebar() {}, children: null }))
  const content = () => find(render(), 'workspace-content').props
  const panel = () => find(render(), 'workspace-sidebar').props
  const pointer = { target: { closest: () => null }, clientX: dir === 'rtl' ? 708 : 12, clientY: 52, pointerType: 'mouse', buttons: 0 }
  for (const event of [
    { ...pointer, clientX: dir === 'rtl' ? 703 : 16 }, { ...pointer, clientY: 51 },
    { ...pointer, pointerType: 'touch' }, { ...pointer, pointerType: 'pen' }, { ...pointer, buttons: 1 },
    { ...pointer, target: { closest: () => ({ tagName: 'BUTTON' }) } },
  ]) {
    content().onPointerMoveCapture(pointer)
    content().onPointerMoveCapture(event)
    vi.runAllTimers()
    expect(panel().inert).toBe(true)
  }
  for (const cancel of ['onPointerLeave', 'onPointerDownCapture', 'onPointerCancel', 'onWheelCapture']) {
    content().onPointerMoveCapture(pointer)
    vi.advanceTimersByTime(40)
    content()[cancel]()
    vi.runAllTimers()
    expect(panel().inert).toBe(true)
  }
  const bar = () => find(render(), 'workspace-window-bar').props
  bar().onPointerEnter()
  vi.runAllTimers()
  expect(panel().inert).toBe(true)
  content().onPointerMoveCapture(pointer)
  vi.advanceTimersByTime(75)
  content().onPointerMoveCapture({ ...pointer, clientX: dir === 'rtl' ? 704 : 15 })
  vi.advanceTimersByTime(24)
  expect(panel().inert).toBe(true)
  vi.advanceTimersByTime(1)
  expect(panel().inert).toBe(false)
  panel().onPointerLeave()
  panel().onPointerEnter()
  vi.runAllTimers()
  expect(panel().inert).toBe(false)
  expect(find(render(), 'workspace').props.onPointerMoveCapture).toBeUndefined()
  panel().onPointerLeave()
  vi.advanceTimersByTime(79)
  expect(panel().inert).toBe(false)
  vi.advanceTimersByTime(1)
  expect(panel().inert).toBe(true)
  content().onPointerMoveCapture(pointer)
  vi.runAllTimers()
  find(render(), 'nav-chat').props.onClick()
  expect(go).toHaveBeenCalledWith('/chat')
  expect(panel().inert).toBe(true)
})

it('peeks on a deliberate Show sidebar hover', () => {
  vi.useFakeTimers()
  const querySelector = vi.fn()
  vi.stubGlobal('document', { activeElement: {}, querySelector })
  const render = renderer(() => Workspace({ route: '', go() {}, search() {}, shortcuts() {}, dismissDialogs() {}, collapsed: true, sidebarMotion: true, toggleSidebar() {}, children: null }))
  const button = () => find(render(), 'sidebar-expand').props
  const panel = () => find(render(), 'workspace-sidebar').props
  const mouse = { pointerType: 'mouse', buttons: 0 }
  for (const event of [{ ...mouse, pointerType: 'touch' }, { ...mouse, pointerType: 'pen' }, { ...mouse, buttons: 1 }]) {
    button().onPointerEnter(event)
    vi.runAllTimers()
    expect(panel().inert).toBe(true)
  }
  for (const stop of ['onPointerLeave', 'onPointerDown', 'onPointerCancel']) {
    button().onPointerEnter(mouse)
    vi.advanceTimersByTime(100)
    button()[stop]()
    vi.runAllTimers()
    expect(panel().inert).toBe(true)
  }
  querySelector.mockReturnValueOnce({})
  button().onPointerEnter(mouse)
  vi.runAllTimers()
  expect(panel().inert).toBe(true)
  button().onPointerEnter(mouse)
  vi.advanceTimersByTime(179)
  expect(panel().inert).toBe(true)
  vi.advanceTimersByTime(1)
  expect(panel().inert).toBe(false)
})

it.each([
  { dir: 'ltr', crossing: 25 }, { dir: 'ltr', crossing: 450 }, { dir: 'rtl', crossing: 450 },
])('keeps a button peek through a $crossing ms crossing in $dir and closes on the page', ({ dir, crossing }) => {
  vi.useFakeTimers()
  vi.stubGlobal('document', { documentElement: { dir }, activeElement: {}, querySelector: () => null })
  vi.stubGlobal('window', { innerWidth: 720 })
  const render = renderer(() => Workspace({ route: '', go() {}, search() {}, shortcuts() {}, dismissDialogs() {}, collapsed: true, sidebarMotion: true, toggleSidebar() {}, children: null }))
  const props = (name: string) => find(render(), name).props
  const move = (clientX: number, clientY: number) => props('workspace').onPointerMoveCapture({ clientX, clientY })
  props('workspace-sidebar').ref.current = { offsetLeft: dir === 'rtl' ? 512 : 0, offsetWidth: 208, offsetTop: 52, contains: () => false }
  props('sidebar-expand').ref.current = { getBoundingClientRect: () => ({ left: 88, right: 116 }) }
  props('sidebar-expand').onPointerEnter({ pointerType: 'mouse', buttons: 0 })
  vi.advanceTimersByTime(180)
  expect(props('workspace-sidebar').inert).toBe(false)

  // Cross the native title bar beyond the 124px window bar before entering the moving panel.
  props('workspace-window-bar').onPointerLeave()
  move(150, 47)
  vi.advanceTimersByTime(crossing)
  expect(props('workspace-sidebar').inert).toBe(false)
  move(dir === 'rtl' ? 550 : 170, 64)
  vi.advanceTimersByTime(100)
  expect(props('workspace-sidebar').inert).toBe(false)
  props('workspace-sidebar').onPointerEnter()

  // Native window chrome can interrupt renderer events on the way back to the button.
  props('workspace').onPointerLeave()
  vi.advanceTimersByTime(300)
  expect(props('workspace-sidebar').inert).toBe(false)
  props('workspace').onPointerEnter()
  move(101, 27)
  vi.advanceTimersByTime(100)
  expect(props('workspace-sidebar').inert).toBe(false)

  // Re-entering cancels dismissal. Further moves on the page don't extend its 80ms delay.
  move(350, 110)
  vi.advanceTimersByTime(50)
  move(dir === 'rtl' ? 550 : 170, 110)
  vi.advanceTimersByTime(100)
  expect(props('workspace-sidebar').inert).toBe(false)
  move(350, 110)
  vi.advanceTimersByTime(79)
  move(365, 110)
  expect(props('workspace-sidebar').inert).toBe(false)
  vi.advanceTimersByTime(1)
  expect(props('workspace-sidebar').inert).toBe(true)
})

it.each(['edge', 'button'])('keeps a %s peek open across the titlebar and docks directly from it', trigger => {
  vi.useFakeTimers()
  vi.stubGlobal('document', { documentElement: { dir: 'ltr' }, activeElement: {}, querySelector: () => null })
  let collapsed = true
  const toggleSidebar = vi.fn()
  const render = renderer(() => Workspace({ route: '', go() {}, search() {}, shortcuts() {}, dismissDialogs() {}, collapsed, sidebarMotion: true, toggleSidebar, children: null }))
  const panel = () => find(render(), 'workspace-sidebar')
  const mouse = { pointerType: 'mouse', buttons: 0 }
  if (trigger === 'button') find(render(), 'sidebar-expand').props.onPointerEnter(mouse)
  else find(render(), 'workspace-content').props.onPointerMoveCapture({ ...mouse, target: { closest: () => null }, clientX: 12, clientY: 200 })
  vi.runAllTimers()
  panel().props.onPointerLeave()
  find(render(), 'workspace-window-bar').props.onPointerEnter()
  vi.runAllTimers()
  expect(panel().props.inert).toBe(false)
  const footer = find(panel(), 'workspace-sidebar-footer')
  expect(find(footer, 'CornerMenu').props.visible).toBe(true)
  find(render(), 'sidebar-expand').props.onClick({ detail: 1 })
  expect(toggleSidebar).toHaveBeenCalledExactlyOnceWith(true)
  // The panel stays exposed even before the parent commits its docked width.
  expect(panel().props.inert).toBe(false)
  collapsed = false
  expect(panel().props.inert).toBe(false)
  expect(find(render(), 'workspace').props['data-peeking']).toBe(false)
  expect(find(render(), 'sidebar-collapse').props.onPointerEnter).toBeUndefined()
})

it('opens a keyboard peek, respects a child menu and returns Escape focus to its opener', () => {
  const opener = { isConnected: true, focus: vi.fn() }
  const search = { focus: vi.fn() }, listeners = new Map<string, Function>()
  const querySelector = vi.fn()
  vi.stubGlobal('document', { activeElement: opener, querySelector, addEventListener() {}, removeEventListener() {} })
  vi.stubGlobal('window', { addEventListener: (name: string, fn: Function) => listeners.set(name, fn), removeEventListener() {} })
  const render = renderer(() => Workspace({ route: '', go() {}, search() {}, shortcuts() {}, dismissDialogs() {}, collapsed: true, sidebarMotion: false, toggleSidebar() {}, children: null }))
  find(render(), 'sidebar-expand').props.onKeyDown({ key: 'ArrowDown', preventDefault() {} })
  const tree = render(), panel = find(tree, 'workspace-sidebar').props
  expect(panel.inert).toBe(false)
  expect(find(tree, 'sidebar-expand').props['aria-expanded']).toBe(true)
  panel.ref.current = { querySelector: () => search, contains: () => false }
  const cleanup = vi.mocked(useEffect).mock.calls.find(([, deps]) => deps?.includes('keyboard'))![0]() as () => void
  expect(search.focus).toHaveBeenCalledWith({ preventScroll: true })
  querySelector.mockReturnValueOnce({})
  const escape = { key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() }
  listeners.get('keydown')!(escape)
  expect(escape.preventDefault).not.toHaveBeenCalled()
  listeners.get('keydown')!(escape)
  expect(find(render(), 'workspace-sidebar').props.inert).toBe(true)
  expect(opener.focus).toHaveBeenCalledWith({ preventScroll: true })
  cleanup()
})

it('remembers the folders disclosure and opens a newly created folder even from a closed section', () => {
  const stored = new Map<string, string>()
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => stored.get(key), setItem: (key: string, value: string) => stored.set(key, value) } })
  const go = vi.fn()
  const mount = () => renderer(() => FoldersNav({ folders: [], route: '', go }))
  let render = mount()
  const toggle = () => find(render(), 'workspace-folders-toggle').props
  const panel = () => find(render(), toggle()['aria-controls']).props
  const caret = () => find(render(), 'workspace-folder-caret')
  const openCaret = caret()
  expect(openCaret.type).toBe('svg')
  expect(toggle()['aria-expanded']).toBe(true)
  expect(find(render(), 'workspace-folder-header').props['data-empty']).toBe(true)
  toggle().onClick()
  expect(caret().type).toBe(openCaret.type)
  expect(caret().props.children.props.d).toBe(openCaret.props.children.props.d)
  render = mount()
  expect(toggle()['aria-expanded']).toBe(false)
  expect(panel().inert).toBe(true)
  const create = () => find(render(), 'folder-create').props.onClick()
  create()
  find(render(), 'FolderName').props.onDone()
  expect(toggle()['aria-expanded']).toBe(false)
  expect(go).not.toHaveBeenCalled()
  create()
  find(render(), 'FolderName').props.onDone({ id: 'new' })
  expect(go).toHaveBeenCalledExactlyOnceWith('/folder/new')
  render = mount()
  expect(toggle()['aria-expanded']).toBe(true)
  expect(panel().inert).toBe(false)
})

it.each([0, 1, 99, 100, 1234])('shows the capped count and describes the full count for a folder with %i meetings', count => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) })
  const folders = [{ id: 'f', name: 'Planning', count, icon: 'folder' as const, color: 'default' as const, createdAt: 1 }]
  const nav = renderer(() => FoldersNav({ folders, route: '/folder/f', go() {} }))()
  const item = find(nav, 'folder-reorder-list').props.children[0]
  const row = renderer(() => item.type(item.props))()
  expect(find(row, 'sidebar-folder-open').props).toMatchObject({ 'aria-current': 'page', 'aria-label': 'Planning',
    'aria-description': count === 1 ? '1 meeting' : `${count.toLocaleString('en-US')} meetings` })
  expect(find(row, 'sidebar-folder-count').props.children.props).toMatchObject({ dir: 'ltr', children: count > 99 ? '99+' : count })
  expect(find(row, 'sidebar-folder-more').props['aria-haspopup']).toBe('menu')
})

it.each(['button', 'right-click', 'keyboard'])('opens the same folder actions via %s', method => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) })
  vi.stubGlobal('getComputedStyle', () => ({ direction: 'ltr' }))
  const folders = [{ id: 'f', name: 'Planning', count: 1, icon: 'folder' as const, color: 'default' as const, createdAt: 1 }]
  const nav = renderer(() => FoldersNav({ folders, route: '', go() {} }))()
  const item = find(nav, 'folder-reorder-list').props.children[0]
  const render = renderer(() => item.type(item.props))
  const row = find(render(), 'sidebar-folder')
  row.props.ref.current = { getBoundingClientRect: () => ({ left: 10, bottom: 70, width: 188 }) }
  const opener = find(row, 'sidebar-folder-open').props
  if (method === 'button') {
    const more = find(row, 'sidebar-folder-more')
    expect(more.type).toBe('button')
    expect(more.props.tabIndex).not.toBe(-1)
    more.props.onClick()
  } else if (method === 'right-click') opener.onContextMenu({ preventDefault() {} })
  else opener.onKeyDown({ key: 'F10', shiftKey: true, preventDefault() {} })
  const result = render()
  expect(find(result, 'sidebar-folder-more').props['aria-expanded']).toBe(true)
  const menu = find(result, 'sidebar-folder-menu')
  for (const action of ['appearance', 'rename', 'up', 'down', 'delete']) {
    expect(find(menu, 'sidebar-folder-' + action).props.role).toBe('menuitem')
  }
})

function find(node: ReactNode, testId: string): ReactElement<any> {
  const visit = (value: ReactNode): ReactElement<any> | undefined => {
    if (Array.isArray(value)) return value.map(visit).find(Boolean)
    if (!value || typeof value !== 'object' || !('props' in value)) return
    const element = value as ReactElement<any>
    if ((typeof element.type === 'function' && element.type.name === testId) || element.props['data-testid'] === testId || element.props.id === testId || element.props['aria-label'] === testId || element.props.className === testId) return element
    return visit(element.props.children)
  }
  const result = visit(node)
  if (!result) throw new Error(`Missing ${testId}`)
  return result
}


afterEach(() => { vi.mocked(toasts.add).mockRestore?.() })

function watchRetryToast() {
  return vi.spyOn(toasts, 'add').mockReturnValue('test-toast')
}

it.each([
  ['darwin', true, 'Appears while you record with Yogurt in the background.', false],
  ['darwin', false, 'Show Yogurt in the menu bar to hide the pill.', true],
  ['win32', true, 'Appears while you record with Yogurt in the background.', undefined],
  ['win32', false, 'Appears while you record with Yogurt in the background.', undefined],
  ['linux', true, 'Appears while you record with Yogurt in the background.', undefined],
])('describes the pill switch on %s with menu bar visibility %s', async (os, showInMenuBar, description, disabled) => {
  const { Settings } = await import('../src/renderer/src/screens/Settings')
  const settings = { get: async () => ({ showInMenuBar, showRecordingPill: true }) }
  vi.stubGlobal('window', { yogurt: { os, settings, capabilities: {} } })
  const draw = renderer(() => Settings({ revision: 17 }))
  draw()
  vi.mocked(useEffect).mock.calls.find(([, deps]) => deps?.includes(17))![0]()
  await Promise.resolve()
  const tree = draw()
  const toggle = find(tree, 'recording-pill-toggle')
  expect(find(tree, toggle.props['aria-describedby']).props.children).toBe(description)
  expect(toggle.props['aria-disabled']).toBe(disabled)
})

it('gives a library read failure a quiet message and keeps its working retry', async () => {
  const { LibraryEmpty } = await import('../src/renderer/src/screens/Home')
  const props = { testId: 'past-empty', title: 'Your notes will show up here', description: 'Record a meeting.', icon: null }
  const retry = vi.fn()
  const normal = LibraryEmpty(props)
  const error = LibraryEmpty({ ...props, retry })
  const { ReadError } = await import('../src/renderer/src/components/InlineError')
  expect(error.type).toBe(ReadError)
  const failed = ReadError(error.props)
  expect(find(normal, 'empty-tile')).toBeTruthy()
  expect(failed.props.role).toBe('alert')
  expect(() => find(failed, 'empty-tile')).toThrow()
  find(failed, 'workspace-button').props.onClick()
  expect(retry).toHaveBeenCalledOnce()
})

it('uses the standard secondary button for inline recovery', () => {
  const retry = vi.fn()
  const row = InlineError({ testId: 'read-error', retry })
  const button = find(row, 'workspace-button')
  expect(button.type).toBe('button')
  button.props.onClick()
  expect(retry).toHaveBeenCalledOnce()
})

it('keeps a failed preference actionable when another preference saves', async () => {
  const { Settings } = await import('../src/renderer/src/screens/Settings')
  const toast = watchRetryToast()
  const close = vi.spyOn(toasts, 'close').mockImplementation(() => {})
  const reminder = vi.fn().mockRejectedValueOnce(new Error('read only')).mockResolvedValue(undefined)
  const settings = { get: async () => ({ myName: 'Meeting host', recordingReminder: true, theme: 'system' }), setRecordingReminder: reminder, setTheme: vi.fn().mockResolvedValue(undefined) }
  vi.stubGlobal('window', { yogurt: { settings, capabilities: {} } })
  try {
    const draw = renderer(() => Settings({ revision: 17 }))
    draw()
    vi.mocked(useEffect).mock.calls.find(([, deps]) => deps?.includes(17))![0]()
    await Promise.resolve()
    find(draw(), 'recording-reminder-toggle').props.onClick()
    await vi.waitFor(() => expect(toast).toHaveBeenCalled())
    const failed = toast.mock.lastCall![0]
    close.mockClear()
    find(draw(), 'settings-theme').props.onChange({ target: { value: 'light' } })
    await vi.waitFor(() => expect(settings.setTheme).toHaveBeenCalledWith('light'))
    expect(close).not.toHaveBeenCalledWith(failed.id)
    await (failed.actionProps!.onClick as Function)()
    expect(reminder.mock.calls).toEqual([[false], [false]])
  } finally { close.mockRestore() }
})

it.each([false, true])('retries the last requested AI access setting (reopen Settings: %s)', async reopen => {
  const { Settings } = await import('../src/renderer/src/screens/Settings')
  const toast = watchRetryToast()
  let saved = { enabled: true, command: 'test', clients: [] }
  let reject!: (reason: Error) => void
  const set = vi.fn(async (enabled: boolean) => (saved = { ...saved, enabled }))
    .mockImplementationOnce(() => new Promise((_, no) => { reject = no }))
  vi.stubGlobal('window', { yogurt: { capabilities: {}, mcp: { status: async () => saved, onClients: () => () => {}, set } } })
  const panel = find(renderer(() => Settings({}))(), 'AiApps')
  const mount = async () => {
    const render = renderer(() => (panel.type as Function)(panel.props))
    render()
    const cleanups = vi.mocked(useEffect).mock.calls.map(([effect]) => effect())
    await Promise.resolve()
    return { render, unmount: () => cleanups.forEach(cleanup => cleanup?.()) }
  }
  let view = await mount()
  const toggle = () => find(view.render(), 'ai-apps-toggle').props
  const pending = toggle().onClick()
  expect(toggle()['aria-checked']).toBe(true)
  expect(toggle().disabled).toBe(true)
  reject(new Error('write failed'))
  await pending
  expect(toggle()['aria-checked']).toBe(true)
  expect(() => find(view.render(), 'ai-apps-retry')).toThrow('Missing')
  const notice = toast.mock.lastCall?.[0]
  expect(notice).toMatchObject({ title: "Couldn't save your changes", timeout: 0, actionProps: { children: 'Try again' } })
  if (reopen) {
    view.unmount()
    view = await mount()
    expect(toggle()['aria-checked']).toBe(true)
  }
  try {
    await (notice!.actionProps!.onClick as Function)()
    expect(toggle()['aria-checked']).toBe(false)
    expect(set.mock.calls).toEqual([[false], [false]])
  } finally { view.unmount() }
})

it('offers letting AI apps make changes only once they can read, off until turned on', async () => {
  const { Settings } = await import('../src/renderer/src/screens/Settings')
  let saved = { enabled: false, changes: false, command: 'test', clients: [] as string[] }
  const setChanges = vi.fn(async (changes: boolean) => (saved = { ...saved, changes }))
  vi.stubGlobal('window', { yogurt: { capabilities: {}, mcp: { status: async () => saved, onClients: () => () => {}, set: vi.fn(), setChanges } } })
  const panel = find(renderer(() => Settings({}))(), 'AiApps')
  const mount = async () => {
    const render = renderer(() => (panel.type as Function)(panel.props))
    render()
    vi.mocked(useEffect).mock.calls.map(([effect]) => effect())
    await Promise.resolve()
    return render
  }
  let render = await mount()
  expect(() => find(render(), 'ai-apps-changes-toggle')).toThrow('Missing')
  saved = { ...saved, enabled: true }
  render = await mount()
  const toggle = () => find(render(), 'ai-apps-changes-toggle').props
  expect(toggle()['aria-checked']).toBe(false)
  await toggle().onClick()
  expect(setChanges).toHaveBeenCalledWith(true)
  expect(toggle()['aria-checked']).toBe(true)
})

it.each([false, true])('opens a pending command-search question as a draft when recording prevents an answer (Meta: %s)', async metaKey => {
  vi.stubGlobal('document', { activeElement: null })
  vi.stubGlobal('HTMLButtonElement', class {})
  const draft = vi.fn().mockResolvedValue(undefined), onNavigate = vi.fn()
  const conversations = { current: async () => 'draft-id', ask: async () => ({ waitsForMeeting: true }), draft }
  vi.stubGlobal('window', { yogurt: { capabilities: { calendar: false }, conversations } })
  const render = renderer(() => Search({ onOpen() {}, onNavigate, onSettingsChange() {}, onShortcuts() {}, onClose() {}, sidebarCollapsed: false, onToggleSidebar() {} }))
  find(render(), 'search-input').props.onChange({ target: { value: 'What did we decide?' } })
  find(render(), 'search').props.onKeyDown({ key: 'Enter', metaKey, nativeEvent: {}, preventDefault() {} })
  await vi.waitFor(() => expect(onNavigate).toHaveBeenCalledExactlyOnceWith('/chat/draft-id'))
  expect(draft).toHaveBeenCalledExactlyOnceWith('draft-id', 'What did we decide?')
})

it.each([
  [true, 'December 12', new Date(2026, 11, 12), 2025],
  [false, 'December 12', new Date(2026, 11, 12), 2025],
  [false, 'November 11, 2025', new Date(2025, 10, 11), 2025],
] as const)('opens the requested day with or without Agenda (calendar %s, query %s)', async (calendar, query, target, filterYear) => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 10, 14, 12))
  vi.stubGlobal('document', { activeElement: null })
  vi.stubGlobal('HTMLButtonElement', class {})
  vi.stubGlobal('window', { yogurt: { capabilities: { calendar }, search: { query: vi.fn().mockResolvedValue([]) } } })
  const onNavigate = vi.fn()
  const render = renderer(() => Search({ onOpen() {}, onNavigate, onSettingsChange() {}, onShortcuts() {}, onClose() {}, sidebarCollapsed: false, onToggleSidebar() {} }))
  find(render(), 'search-input').props.onChange({ target: { value: query } })
  render()
  vi.mocked(useEffect).mock.calls.find(([, deps]) => deps?.length === 6)![0]()
  await vi.runAllTimersAsync()
  const tree = render()
  expect(find(tree, 'search-date').props.children[1].props.title).toContain(String(filterYear))
  const row = find(tree, 'command-agenda-date')
  expect(row.props['aria-selected']).toBe(true)
  expect(row.props.children[0].type).toBe(CalendarDays)
  expect(row.props.children[1].props.children[0]).toBe('Go to ' + target.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }))
  find(tree, 'search').props.onKeyDown({ key: 'Enter', nativeEvent: {}, preventDefault() {} })
  expect(onNavigate).toHaveBeenCalledExactlyOnceWith('', target.getTime())
})

it.each([0, 3200])('returns a scrolled list to zero and leaves focus alone if already there (scrollTop %s)', scrollTop => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 10, 24, 12))
  vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) })
  const heading = { focus: vi.fn() }
  const root = Object.assign(new EventTarget(), { scrollTop, clientHeight: 500, scrollHeight: 3700, querySelector: vi.fn(() => heading) })
  const next = vi.fn()
  renderer(() => {
    useMeetingDateJump({ at: new Date(2026, 11, 12).getTime() }, {
      cards: [{ startedAt: new Date(2026, 10, 20).getTime() }], root: root as unknown as HTMLElement, more: true, failed: 'page', next,
    }, true)
    return null
  })()
  for (const [effect] of vi.mocked(useLayoutEffect).mock.calls) effect()
  expect(root.scrollTop).toBe(0)
  expect(next).not.toHaveBeenCalled()
  if (scrollTop) expect(root.querySelector).toHaveBeenCalledWith('h1')
  expect(heading.focus).toHaveBeenCalledTimes(scrollTop ? 1 : 0)
})

it('jumps a mounted agenda to the day and week, closes details, and keeps arrows and repeated jumps working', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 10, 14, 12))
  const day = vi.fn(async (at: number) => ({ status: 'granted', events: [{ id: 'example', title: 'Example event', start: at, end: at + 60_000, attendees: [], url: null }] }))
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {}, yogurt: {
    calendar: { day, onChange: () => () => {} }, meetings: { onChange: () => () => {} },
  } })
  let jumpTo: { at: number } | undefined
  const render = renderer(() => Agenda({ revision: 0, onStart: async () => {}, onOpen() {}, jumpTo })) as () => ReturnType<typeof Agenda>
  const applyJump = () => vi.mocked(useLayoutEffect).mock.calls.find(([, deps]) => deps?.length === 1 && deps[0] === jumpTo)![0]()
  render()
  jumpTo = { at: new Date(2028, 10, 11).getTime() }
  render(); applyJump()
  let tree = render()
  expect(find(tree, 'agenda-month').props.children).toBe('November 2028')
  expect(find(tree, 'Saturday, November 11').props['aria-pressed']).toBe(true)
  expect(find(tree, 'Choose agenda date').props.children.map((button: ReactElement<any>) => button.props['aria-label'])).toEqual([
    'Sunday, November 5', 'Monday, November 6', 'Tuesday, November 7', 'Wednesday, November 8',
    'Thursday, November 9', 'Friday, November 10', 'Saturday, November 11',
  ])
  const cleanup = vi.mocked(useEffect).mock.calls.find(([, deps]) => deps?.length === 3 && typeof deps[0] === 'function')![0]()
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  tree = render()
  expect(day).toHaveBeenLastCalledWith(new Date(2028, 10, 11, 12).getTime())
  find(tree, 'coming-up').props.children[0].props.onInspect({ focus() {} }, false)
  expect(render().props.children.at(-1)).toBeTruthy()
  // A fresh request for the same day must close its event card too.
  jumpTo = { ...jumpTo }; render(); applyJump()
  tree = render()
  expect(tree.props.children.at(-1)).toBeFalsy()
  find(tree, 'Next day').props.onClick()
  tree = render()
  expect(find(tree, 'Sunday, November 12').props['aria-pressed']).toBe(true)
  expect(find(tree, 'Choose agenda date').props.children[0].props['aria-label']).toBe('Sunday, November 12')
  jumpTo = { ...jumpTo }; render(); applyJump()
  tree = render()
  expect(find(tree, 'Saturday, November 11').props['aria-pressed']).toBe(true)
  find(tree, 'Previous day').props.onClick()
  expect(find(render(), 'Friday, November 10').props['aria-pressed']).toBe(true)
  vi.mocked(useEffect).mock.calls.find(([, deps]) => deps?.length === 2 && deps.every(value => typeof value === 'number'))![0]()
  const remount = renderer(() => Agenda({ revision: 0, onStart: async () => {}, onOpen() {} }))
  expect(find(remount(), 'Friday, November 10').props['aria-pressed']).toBe(true)
  const arrival = renderer(() => Agenda({ revision: 0, onStart: async () => {}, onOpen() {}, jumpTo: { at: new Date(2030, 0, 1).getTime() } }))
  expect(find(arrival(), 'Tuesday, January 1').props['aria-pressed']).toBe(true)
  cleanup?.()
})

it.each(['dark', 'mode'])('executes the ranked result when Enter beats a slow search for %s', async term => {
  vi.useFakeTimers()
  vi.stubGlobal('document', { activeElement: null })
  vi.stubGlobal('HTMLButtonElement', class {})
  const meeting = { meetingId: 'm1', title: 'Dark mode planning', startedAt: 1, parts: [], attendees: [], preview: '', confident: true }
  const query = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 300)); return [meeting] })
  const setTheme = vi.fn().mockResolvedValue(undefined), onOpen = vi.fn()
  vi.stubGlobal('window', { yogurt: { capabilities: {}, settings: { get: async () => ({ theme: 'light' }), setTheme }, search: { query } } })
  const render = renderer(() => Search({ onOpen, onNavigate() {}, onSettingsChange() {}, onShortcuts() {}, onClose() {}, sidebarCollapsed: false, onToggleSidebar() {} }))
  render()
  vi.mocked(useEffect).mock.calls[1][0]()
  await Promise.resolve()
  const question = 'What happened?'
  find(render(), 'search-input').props.onChange({ target: { value: question } })
  render()
  vi.mocked(useEffect).mock.calls.find(([, deps]) => deps?.[0] === question && deps.length > 1)![0]()
  await vi.runAllTimersAsync()
  find(render(), 'search-input').props.onChange({ target: { value: term } })
  const tree = render()
  expect(find(tree, 'search-ask').props['aria-selected']).toBe(true)
  vi.mocked(useEffect).mock.calls.find(([, deps]) => deps?.[0] === term && deps.length > 1)![0]()
  find(tree, 'search').props.onKeyDown({ key: 'Enter', nativeEvent: {}, preventDefault() {} })
  await vi.runAllTimersAsync()
  if (term === 'dark') {
    expect(setTheme).toHaveBeenCalledExactlyOnceWith('dark')
    expect(onOpen).not.toHaveBeenCalled()
  } else {
    expect(onOpen).toHaveBeenCalledExactlyOnceWith('m1')
    expect(setTheme).not.toHaveBeenCalled()
  }
})

it('offers another read when a palette query fails', async () => {
  vi.stubGlobal('document', { activeElement: null })
  const query = vi.fn().mockRejectedValueOnce(new Error('read failed')).mockResolvedValue([])
  vi.stubGlobal('window', { yogurt: { capabilities: { calendar: true }, search: { query } } })
  const render = renderer(() => Search({ onOpen() {}, onNavigate() {}, onSettingsChange() {}, onShortcuts() {}, onClose() {}, sidebarCollapsed: false, onToggleSidebar() {} }))
  render()
  vi.mocked(useEffect).mock.calls.find(([, deps]) => deps?.length === 6)![0]()
  await new Promise(resolve => setTimeout(resolve, 0))
  await find(render(), 'search-retry').props.onClick()
  expect(query).toHaveBeenCalledTimes(2)
})


it('keeps initial search results still, ignores stationary hover, and scrolls only for keyboard selection', async () => {
  const meetings = ['m1', 'm2', 'm3'].map(meetingId => ({ meetingId, title: 'Recent meeting', startedAt: 1000, parts: [], attendees: [], preview: meetingId + ' notes' }))
  vi.stubGlobal('document', { activeElement: null })
  vi.stubGlobal('HTMLButtonElement', class {})
  vi.stubGlobal('window', { yogurt: { capabilities: { calendar: true }, search: { query: vi.fn().mockResolvedValue(meetings) } } })
  const render = renderer(() => Search({ onOpen() {}, onNavigate() {}, onSettingsChange() {}, onShortcuts() {}, onClose() {}, sidebarCollapsed: false, onToggleSidebar() {} }))
  const scrollIntoView = vi.fn()
  const scroll = () => { vi.mocked(useEffect).mock.lastCall![0]() }
  let tree = render()
  find(tree, 'search-results').props.ref.current = { querySelector: () => ({ scrollIntoView }) }
  expect(find(tree, 'search-results').props.className).toContain('[overflow-anchor:none]')
  scroll()
  expect(scrollIntoView).not.toHaveBeenCalled()
  // Receiving the recent meetings does not move the list.
  vi.mocked(useEffect).mock.calls.find(([, deps]) => deps?.length === 6)![0]()
  await Promise.resolve()
  tree = render(); scroll()
  expect(find(tree, 'search-result').props['aria-selected']).toBe(true)
  expect(scrollIntoView).not.toHaveBeenCalled()
  find(tree, 'search-m2').props.onMouseMove({ movementX: 0, movementY: 0 })
  tree = render(); scroll()
  expect(find(tree, 'search-result').props['aria-selected']).toBe(true)
  find(tree, 'search-m2').props.onMouseMove({ movementX: 1, movementY: 0 })
  tree = render(); scroll()
  expect(find(tree, 'search-m2').props['aria-selected']).toBe(true)
  expect(find(tree, 'search-preview').props.children.props.children).toBe('m2 notes')
  expect(scrollIntoView).not.toHaveBeenCalled()
  find(tree, 'search').props.onKeyDown({ key: 'ArrowDown', nativeEvent: {}, preventDefault() {} })
  tree = render(); scroll()
  expect(find(tree, 'search-m3').props['aria-selected']).toBe(true)
  expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
  scrollIntoView.mockClear()
  find(tree, 'search-m2').props.onMouseMove({ movementX: 0, movementY: 0 })
  tree = render()
  expect(find(tree, 'search-m3').props['aria-selected']).toBe(true)
  find(tree, 'search-result').props.onMouseMove({ movementX: 0, movementY: 1 })
  tree = render(); scroll()
  expect(find(tree, 'search-result').props['aria-selected']).toBe(true)
  expect(scrollIntoView).not.toHaveBeenCalled()
})

it('keeps row glyphs stable across keyboard selection', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('document', { activeElement: null })
  vi.stubGlobal('HTMLButtonElement', class {})
  vi.stubGlobal('window', { yogurt: {
    capabilities: { calendar: true },
    settings: { get: async () => ({ theme: 'light' }) },
    meetings: { onChange: () => () => {} },
    search: {
      people: async () => [{ name: 'Sample attendee', email: 'participant@example.test' }],
      query: async () => [{ meetingId: 'm1', title: 'Planning', startedAt: 1000, parts: [], attendees: [], preview: '' }],
    },
  } })
  const folders = [{ id: 'f1', name: 'Planning', icon: 'calendar' as const, color: 'violet' as const, count: 1, createdAt: 1 }]
  const render = renderer(() => Search({ folder: folders[0], folders, onOpen() {}, onNavigate() {}, onSettingsChange() {}, onShortcuts() {}, onClose() {}, sidebarCollapsed: false, onToggleSidebar() {} }))
  render()
  vi.mocked(useEffect).mock.calls[1][0]()
  vi.mocked(useEffect).mock.calls[2][0]()
  await Promise.resolve()
  const icons = new Map<string, unknown>()
  const inspect = (node: ReactNode) => {
    if (Array.isArray(node)) { node.forEach(inspect); return }
    if (!node || typeof node !== 'object' || !('props' in node)) return
    const { props } = node as ReactElement<any>
    if (props.role === 'option') {
      const icon = props.children[0]
      if (icons.has(props.id)) expect(icon.type).toBe(icons.get(props.id))
      icons.set(props.id, icon.type)
      if (props.id === 'search-m1') expect(icon.props.className).toBe('search-meeting-dot')
      else if (icon.props.appearance) expect(icon.props.appearance).toBe(folders[0])
      else {
        expect(icon.props).toMatchObject({ size: 16, 'aria-hidden': 'true' })
        expect(renderToStaticMarkup(icon)).toContain(`stroke-width="${ICON_STROKE_WIDTH}"`)
      }
    }
    inspect(props.children)
  }
  for (const query of ['', 'plan', 'planning', 'November 11, 2028', 'att', 'Sample attendee', 'theme', 'what was decided?']) {
    find(render(), 'search-input').props.onChange({ target: { value: query } })
    render()
    vi.mocked(useEffect).mock.calls.find(([, deps]) => deps?.length === 6)![0]()
    await vi.runAllTimersAsync()
    const tree = render()
    inspect(tree)
    if (query === 'Sample attendee') expect(find(tree, 'search-person-filter')).toBeDefined()
    if (query === 'November 11, 2028') expect(find(tree, 'search-date')).toBeDefined()
    find(tree, 'search').props.onKeyDown({ key: 'ArrowDown', nativeEvent: {}, preventDefault() {} })
    inspect(render())
  }
  expect([...icons.keys()]).toEqual(expect.arrayContaining(['search-m1', 'search-ask', 'command-agenda-date', 'command-folder-f1', 'command-theme-light', 'search-person-email%3Aparticipant%40example.test']))
})

it.each(['/chat', '/chat/saved'])('focuses Ask without a conversation lookup or navigation on %s', async route => {
  const current = vi.fn().mockResolvedValue('other'), go = vi.fn(), focus = vi.fn()
  const keydown = vi.fn(), onAsk = vi.fn(), takeAsk = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
  vi.stubGlobal('window', { addEventListener: keydown, yogurt: { os: 'win32', conversations: { current }, nav: { onAsk, takeAsk } } })
  vi.stubGlobal('document', { querySelectorAll: () => [], getElementById: (id: string) => id === 'library-question' ? { focus } : null })
  renderer(() => Workspace({ route, go, search() {}, shortcuts() {}, dismissDialogs() {}, collapsed: false, sidebarMotion: false, toggleSidebar() {}, children: null }))()
  vi.mocked(useEffect).mock.lastCall![0]()
  keydown.mock.calls[0][1]({ code: 'KeyJ', ctrlKey: true, preventDefault() {} })
  onAsk.mock.calls[0][0]()
  await Promise.resolve()
  expect(focus.mock.calls).toEqual([[{ preventScroll: true }], [{ preventScroll: true }]])
  expect(current).not.toHaveBeenCalled()
  expect(go).not.toHaveBeenCalled()
})

it.each(['darwin', 'win32'])('toggles the meeting panel once per shortcut press on %s', os => {
  const listeners = new Map<string, (e: any) => void>()
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }), addEventListener: (name: string, fn: (e: any) => void) => listeners.set(name, fn), removeEventListener() {},
    yogurt: { os, nav: { onAsk: () => () => {}, takeAsk: vi.fn().mockResolvedValue(false) } } })
  const renderAsk = renderer(() => Ask({ id: 'm1', recording: false, anchor: null, onSource() {} }))
  let tree = renderAsk()
  const click = vi.fn(() => { find(tree, 'chat-open').props.onClick(); tree = renderAsk() })
  let open: { dataset: { testid?: string } }[] = []
  vi.stubGlobal('document', { querySelectorAll: () => open, getElementById: () => ({ click }) })
  const frames: (() => void)[] = []
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => frames.push(fn))
  vi.stubGlobal('cancelAnimationFrame', () => {})
  const dismissDialogs = vi.fn(() => { open = [] })
  const renderWorkspace = renderer(() => Workspace({ route: '/note/m1', go() {}, search() {}, shortcuts() {}, dismissDialogs, collapsed: false, sidebarMotion: false, toggleSidebar() {}, children: null }))
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
  // a confirmation or form keeps ⌘J
  open = [{ dataset: {} }]
  press()
  expect(click).toHaveBeenCalledTimes(3)
  // Keyboard shortcuts closes, then Ask toggles (#175)
  open = [{ dataset: { testid: 'shortcuts-dialog' } }]
  press()
  expect(dismissDialogs).toHaveBeenCalledTimes(1)
  expect(click).toHaveBeenCalledTimes(3)
  frames.shift()!()
  expect(click).toHaveBeenCalledTimes(4)
  expect(find(tree, 'chat-open').props['aria-expanded']).toBe(false)
})

it.each([[false, false], [true, false], [false, true], [true, true]])('clips the suggestions and composer with the moving surface (narrow %s, reduced motion %s)', async (narrow, reduced) => {
  const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height, top: y, left: x, right: x + width, bottom: y + height })
  const to = narrow ? rect(16, 16, 328, 640) : rect(760, 200, 420, 440)
  // Exercise a button outside the final panel, anchored on either side.
  const from = narrow ? rect(20, 700, 140, 30) : rect(1040, 670, 140, 30)
  const node = (bounds: ReturnType<typeof rect>, computed: Record<string, string>) => ({
    getBoundingClientRect: () => bounds, computed, style: { overflow: '' },
    animate: vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => {
      let finish!: () => void
      const finished = new Promise<void>(resolve => { finish = resolve })
      return { playState: 'running', cancel() { this.playState = 'idle' }, finished, finish }
    }),
  })
  const button = { ...node(from, { opacity: '1', borderRadius: '6px' }), focus: vi.fn() }
  const shell = node(to, { left: '-1px', top: '-1px', width: `${to.width}px`, height: `${to.height}px`, borderRadius: '12px', opacity: '1' })
  const body = node(to, { opacity: '1' })
  const input = { focus: vi.fn() }
  const dialog = { ...node(to, { opacity: '1' }), style: { setProperty() {} }, show: vi.fn(), showModal: vi.fn(), close() {}, querySelector: () => input }
  const anchor = { getBoundingClientRect: () => to } as HTMLElement
  const viewport = { matches: narrow, addEventListener: vi.fn() }
  vi.stubGlobal('window', { matchMedia: (query: string) => query.includes('max-width') ? viewport : { matches: reduced }, addEventListener() {}, removeEventListener() {} })
  vi.stubGlobal('innerHeight', 800)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('getComputedStyle', (element: { computed: Record<string, string> }) => element.computed)
  const render = renderer(() => Ask({ id: 'morph', recording: false, anchor, onSource() {} }))
  let tree = render()
  for (const [effect] of vi.mocked(useEffect).mock.calls) effect()
  find(tree, 'chat-open').props.ref.current = button
  find(tree, 'chat-open').props.onClick()
  tree = render()
  const panel = find(tree, 'chat-panel')
  panel.props.ref.current = dialog
  const surface = find(panel, 'chat-morph-surface')
  surface.props.ref.current = shell
  find(surface, 'chat-panel-contents').props.ref.current = body
  const conversation = find(surface, 'AskConversation')
  expect(surface.props['aria-hidden']).toBeUndefined()
  expect(conversation.props).toMatchObject({ id: '', panel: true, pendingDraftKey: 'meeting/morph' })
  const dispose = vi.mocked(useLayoutEffect).mock.lastCall![0]() as () => void
  expect(input.focus).toHaveBeenCalledWith({ preventScroll: true })
  const view = renderer(() => AskConversation(conversation.props))()
  expect(find(view, 'chat-suggestions')).toBeDefined()
  expect(find(view, 'chat-box').type).toBe('form')

  const toggle = () => find(tree, 'chat-open').props.onClick()
  if (reduced) {
    expect(dialog.animate.mock.lastCall?.[0]).toEqual([{ opacity: 0 }, { opacity: 1 }])
    toggle()
    expect(dialog.animate.mock.lastCall?.[0].at(-1)).toEqual({ opacity: 0 })
    expect(dialog.animate.mock.lastCall?.[1].duration).toBe(120)
    expect(shell.animate).not.toHaveBeenCalled()
    expect(shell.style.overflow).toBe('')
    // Cross the modal breakpoint before the close fade finishes.
    viewport.matches = !narrow
    viewport.addEventListener.mock.calls[0][1]()
    dispose()
    render()
    vi.mocked(useLayoutEffect).mock.lastCall![0]()
    await Promise.resolve()
    expect(narrow ? dialog.show : dialog.showModal).not.toHaveBeenCalled()
    expect(find(render(), 'chat-open').props['aria-expanded']).toBe(false)
    expect(button.focus).toHaveBeenCalledWith({ preventScroll: true })
    return
  }
  const collapsed = { '--ask-left': `${from.left - to.left - 1}px`, '--ask-top': `${from.top - to.top - 1}px`, width: `${from.width}px`, height: `${from.height}px`, borderRadius: '6px' }
  const expanded = { '--ask-left': '-1px', '--ask-top': '-1px', width: 'calc(100% + 2px)', height: 'calc(100% + 2px)', borderRadius: '12px' }
  const shape = () => shell.animate.mock.calls.at(-2)!
  expect(shape()[0]).toEqual([collapsed, expanded])
  expect(shape()[1].duration).toBe(180)
  expect(shell.style.overflow).toBe('clip')
  expect(body.animate.mock.calls.flatMap(([frames]) => frames).every(frame => Object.keys(frame).every(k => k === 'opacity'))).toBe(true)
  const first = shell.animate.mock.results.at(-2)!.value

  // Reverse from the painted bounds. A late completion from the first opening cannot release the new clip.
  const midway = { left: '40px', top: '80px', width: '210px', height: '140px', borderRadius: '8px' }
  Object.assign(shell.computed, midway)
  toggle()
  const resumed = { '--ask-left': midway.left, '--ask-top': midway.top, width: midway.width, height: midway.height, borderRadius: midway.borderRadius }
  expect(shape()[0]).toEqual([resumed, collapsed])
  expect(shape()[1].duration).toBe(150)
  toggle()
  expect(shape()[0]).toEqual([resumed, expanded])
  first.finish()
  await Promise.resolve()
  expect(shell.style.overflow).toBe('clip')
  shell.animate.mock.results.at(-2)!.value.finish()
  await Promise.resolve()
  expect(shell.style.overflow).toBe('')
  for (const el of [shell, body, button]) {
    for (const result of el.animate.mock.results) result.value.playState = 'finished'
  }
  toggle()
  expect(shape()[0]).toEqual([expanded, collapsed])
  expect(shell.style.overflow).toBe('clip')
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
  const drain = () => vi.mocked(useEffect).mock.calls.find(([, deps]) => deps?.length === 3 && deps[1] === loadError && deps[2] === false)![0]()
  const enter = (tree: ReactNode) => find(tree, 'chat-input').props.onKeyDown({ key: 'Enter', nativeEvent: {}, preventDefault() {} })
  let tree = render()
  const focus = vi.fn()
  find(tree, 'chat-input').props.ref.current = { focus, closest: () => null }
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
  if (failure === 'load') {
    await find(tree, 'conversation-load-retry').props.onClick()
    expect(get).toHaveBeenCalledTimes(2)
  }
  if (failure === 'send') {
    expect(find(tree, 'chat-send').props.disabled).toBe(false)
    enter(tree)
    expect(ask).toHaveBeenCalledTimes(2)
  }
})

function mentionComposer(panel: boolean, draft = 'Keep this question') {
  vi.stubGlobal('document', { body: {} })
  const context = vi.fn().mockResolvedValue(undefined), save = vi.fn().mockResolvedValue(undefined)
  const targets = vi.fn().mockResolvedValue([
    { kind: 'folder', id: 'folder', title: 'Planning' },
    { kind: 'meeting', id: 'attached', title: 'Already attached' },
    { kind: 'meeting', id: 'meeting', title: 'Planning review' },
  ])
  const removeContext = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('window', { yogurt: { conversations: { context, removeContext, draft: save, targets } } })
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { callback(); return 0 })
  const initial: ConversationView = { id: `mention-${panel}`, title: '', draft, chips: [{ kind: 'meeting', id: 'attached', title: 'Already attached' }], draftChips: [], firstChips: null, turns: [], waitsForMeeting: false, waitsForModel: false }
  const render = renderer(() => AskConversation({ id: initial.id, initial, panel, onSelect() {}, onDeleted() {}, onSource() {} }))
  const prefix = panel ? 'chat' : 'chat-page'
  const input = () => find(render(), `${prefix}-input`).props
  const popup = () => find(render(), 'ask-box-actions').props.children[0].props
  const caret = { closest: () => null, selectionStart: 5, selectionEnd: 9, focus: vi.fn(), setSelectionRange: vi.fn() }
  input().ref.current = caret
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }
  const lookup = async () => {
    render()
    const cleanup = vi.mocked(useEffect).mock.calls.find(([, deps]) => deps?.length === 4)![0]()
    await flush()
    return cleanup
  }
  const type = (value: string) => input().onChange({ target: { value, selectionStart: value.length } })
  const key = (props: any, key: string) => props.onKeyDown({ key, nativeEvent: {}, preventDefault() {}, stopPropagation() {} })
  return { render, prefix, input, popup, caret, lookup, type, key, flush, context, removeContext, save, targets, initial }
}

it.each([false, true])('keeps the scope selector open after picking and restores the saved caret on close (panel: %s)', async panel => {
  const c = mentionComposer(panel)
  c.popup().onOpenChange(true)
  expect(c.popup().open).toBe(true)
  expect(c.input().value).toBe('Keep this question')
  expect(c.input()['aria-expanded']).toBe(false)
  expect(c.save).not.toHaveBeenCalled()
  expect(find(c.render(), 'ask-selector-positioner').props.side).toBe(panel ? 'top' : 'bottom')
  await c.lookup()
  expect(c.targets).toHaveBeenCalledWith('')
  let search = find(c.render(), 'Search meetings and folders').props
  expect(search.placeholder).toBe('Search…')
  expect(search.role).toBe('combobox')
  expect(search['aria-controls']).toBe(`${c.prefix}-contexts`)
  expect(search['aria-activedescendant']).toBe(`${c.prefix}-context-0`)
  // Arrow order follows the displayed groups, even when the service returns folders first.
  expect(find(c.render(), `${c.prefix}-context-0`).props.children[1].props.children).toBe('Already attached')
  expect(find(c.render(), `${c.prefix}-context-0`).props['aria-selected']).toBe(true)
  expect(find(c.render(), `${c.prefix}-context-1`).props.children[1].props.children).toBe('Planning review')
  search.onChange({ target: { value: 'Plan' } })
  await c.lookup()
  expect(c.targets).toHaveBeenLastCalledWith('Plan')
  search = find(c.render(), 'Search meetings and folders').props
  c.key(search, 'ArrowDown')
  c.key(find(c.render(), 'Search meetings and folders').props, 'ArrowDown')
  search = find(c.render(), 'Search meetings and folders').props
  expect(search['aria-activedescendant']).toBe(`${c.prefix}-context-2`)
  find(c.render(), `${c.prefix}-context-2`).props.onClick()
  await c.flush()
  expect(c.context).toHaveBeenCalledExactlyOnceWith(c.initial.id, [...c.initial.chips, { kind: 'folder', id: 'folder', title: 'Planning' }])
  expect(c.input().value).toBe('Keep this question')
  expect(c.save).not.toHaveBeenCalled()
  expect(c.popup().open).toBe(true)
  expect(c.caret.focus).not.toHaveBeenCalled()
  c.key(find(c.render(), 'Search meetings and folders').props, 'Escape')
  expect(c.popup().open).toBe(false)
  c.popup().children[1].props.children.props.children.props.finalFocus()
  expect(c.caret.focus).toHaveBeenCalled()
  expect(c.caret.setSelectionRange).toHaveBeenCalledWith(5, 9)
})

it('leaves the selector and draft intact if attaching fails, and dismisses without saving on Escape or outside press', async () => {
  const c = mentionComposer(true)
  c.context.mockRejectedValue(new Error('write failed'))
  c.popup().onOpenChange(true)
  await c.lookup()
  find(c.render(), `${c.prefix}-context-2`).props.onClick()
  await c.flush()
  expect(c.popup().open).toBe(true)
  expect(c.input().value).toBe('Keep this question')
  expect(find(c.render(), 'chat-send-error').props.role).toBe('alert')
  expect(c.save).not.toHaveBeenCalled()
  c.key(find(c.render(), 'Search meetings and folders').props, 'Escape')
  expect(c.popup().open).toBe(false)
  c.popup().onOpenChange(true)
  c.popup().onOpenChange(false, { reason: 'outside-press' })
  expect(c.popup().open).toBe(false)
  expect(c.input().value).toBe('Keep this question')
})

it.each([false, true])('follows caret selection between mentions without taking focus or editing the draft (panel: %s)', async panel => {
  const c = mentionComposer(panel, '')
  c.type('@First\n@Second')
  await c.lookup()
  expect(c.targets).toHaveBeenLastCalledWith('Second')
  c.save.mockClear()
  c.input().onSelect({ currentTarget: { value: c.input().value, selectionStart: 6 } })
  await c.lookup()
  expect(c.targets).toHaveBeenLastCalledWith('First')
  expect(c.input()['aria-controls']).toBe(`${c.prefix}-contexts`)
  expect(c.input()['aria-activedescendant']).toBe(`${c.prefix}-context-0`)
  expect(find(c.render(), 'ask-picker ask-mention').props.id).toBe(`${c.prefix}-contexts`)
  expect(c.caret.focus).not.toHaveBeenCalled()
  expect(c.save).not.toHaveBeenCalled()
  c.input().onSelect({ currentTarget: { value: c.input().value, selectionStart: 0 } })
  expect(c.input()['aria-expanded']).toBe(false)
})

it.each([false, true])('dismisses empty inline searches on space until a new @, and still inserts inline matches (panel: %s)', async panel => {
  const c = mentionComposer(panel, '')
  c.targets.mockResolvedValue([])
  c.type('@missing')
  await c.lookup()
  expect(c.input()['aria-expanded']).toBe(true)
  c.type('@missing ')
  expect(c.input()['aria-expanded']).toBe(false)
  c.type('@missing and now I am typing')
  expect(c.input()['aria-expanded']).toBe(false)
  c.input().onClick({ currentTarget: { value: c.input().value, selectionStart: 8 } })
  expect(c.input()['aria-expanded']).toBe(false)
  expect(c.input().value).toBe('@missing and now I am typing')
  c.type('@')
  expect(c.input()['aria-expanded']).toBe(false)
  c.type('@missing and now I am typing @')
  expect(c.input()['aria-expanded']).toBe(true)
  const target = { kind: 'meeting', id: 'next', title: 'Next meeting' }
  c.targets.mockResolvedValue([target])
  c.type('@missing and now I am typing @Next')
  await c.lookup()
  c.type('@missing and now I am typing @Next ')
  expect(c.input()['aria-expanded']).toBe(true)
  await c.lookup()
  c.key(c.input(), 'Enter')
  await c.flush()
  expect(c.context).toHaveBeenCalledWith(c.initial.id, [...c.initial.chips, target])
  expect(c.input().value).toBe('@missing and now I am typing ')
  expect(c.input()['aria-expanded']).toBe(false)
})

it.each([false, true].flatMap(panel => [false, true].flatMap(inline => [
  { query: '', meetings: 8, folders: 5, shown: 5, firstNew: 3 },
  { query: '', meetings: 8, folders: 1, shown: 4, firstNew: 3 },
  { query: '', meetings: 8, folders: 0, shown: 5, firstNew: 5 },
  { query: 'Plan', meetings: 8, folders: 5, shown: 10, firstNew: 6 },
  { query: 'Plan', meetings: 12, folders: 0, shown: 10, firstNew: 10 },
  { query: 'Plan', meetings: 2, folders: 5, shown: 6, firstNew: 6 },
  { query: '', meetings: 2, folders: 2, shown: 4, firstNew: -1 },
].map(example => ({ panel, inline, ...example })))))(
  'caps and expands $meetings meetings/$folders folders for "$query" (panel: $panel, inline: $inline)',
  async ({ panel, inline, query, meetings, folders, shown, firstNew }) => {
    const c = mentionComposer(panel, '')
    const matches = [
      ...Array.from({ length: meetings }, (_, i) => ({ kind: 'meeting', id: `m${i}`, title: `Plan meeting ${i}` })),
      ...Array.from({ length: folders }, (_, i) => ({ kind: 'folder', id: `f${i}`, title: `Plan folder ${i}` })),
    ]
    c.targets.mockResolvedValue(matches)
    if (inline) c.type(`@${query}`)
    else { c.popup().onOpenChange(true); find(c.render(), 'Search meetings and folders').props.onChange({ target: { value: query } }) }
    await c.lookup()
    const control = () => inline ? c.input() : find(c.render(), 'Search meetings and folders').props
    const offset = !inline && !query ? 1 : 0
    const count = meetings + folders - shown
    if (!count) {
      expect(() => find(c.render(), `${c.prefix}-context-${offset + shown}`)).toThrow('Missing')
      return
    }
    const more = find(c.render(), `${c.prefix}-context-${offset + shown}`).props
    expect(more.children[1].props.children).toBe(`${count} more ${count === 1 ? 'result' : 'results'}`)
    expect(() => find(c.render(), `${c.prefix}-context-${offset + shown + 1}`)).toThrow('Missing')
    if (panel) more.onClick()
    else {
      c.key(control(), 'ArrowUp')
      expect(control()['aria-activedescendant']).toBe(`${c.prefix}-context-${offset + shown}`)
      c.key(control(), 'Enter')
    }
    expect(c.context).not.toHaveBeenCalled()
    expect(control()['aria-activedescendant']).toBe(`${c.prefix}-context-${offset + firstNew}`)
    expect(find(c.render(), `${c.prefix}-context-${offset + firstNew}`).props.children[1].props.children).toBe(matches[firstNew].title)
    expect(find(c.render(), `${c.prefix}-context-${offset + matches.length - 1}`).props.children[1].props.children).toBe(matches.at(-1)!.title)
    expect(() => find(c.render(), `${c.prefix}-context-${offset + matches.length}`)).toThrow('Missing')
    c.key(control(), 'Enter')
    await c.flush()
    expect(c.context).toHaveBeenCalledWith(c.initial.id, [...c.initial.chips, matches[firstNew]])
  },
)

it.each([true, false])('focuses the first available Share action when a summary exists: %s', async hasEnhanced => {
  const { ShareMenu } = await import('../src/renderer/src/components/ShareMenu')
  vi.stubGlobal('document', new EventTarget())
  const render = renderer(() => ShareMenu({ id: 'note', shown: 'mine', status: 'idle', hasEnhanced, beforeUse: async () => true }))
  find(render(), 'share-button').props.onClick({ detail: 0 })
  const menu = find(render(), 'share-menu')
  const items = menu.props.children.filter((item: ReactElement<any>) => item.props.role === 'menuitem')
  expect(items.map((item: ReactElement<any>) => item.props['data-testid'])).toEqual(['share-copy-summary', 'share-copy-notes', 'share-copy-transcript', 'share-export'])
  const focused = vi.fn()
  for (const item of items) item.props.ref({ disabled: item.props.disabled, focus: () => focused(item.props['data-testid']) })
  const cleanup = vi.mocked(useEffect).mock.calls.find(([, deps]) => deps?.includes('keyboard'))![0]()
  expect(focused).toHaveBeenCalledExactlyOnceWith(hasEnhanced ? 'share-copy-summary' : 'share-copy-notes')
  if (typeof cleanup === 'function') cleanup()
})

it('retains an export error and reopens the file save action on retry', async () => {
  vi.useFakeTimers()
  const toast = watchRetryToast()
  const { ShareMenu } = await import('../src/renderer/src/components/ShareMenu')
  const save = vi.fn().mockResolvedValueOnce('failed').mockResolvedValueOnce('saved')
  vi.stubGlobal('window', { yogurt: { share: { save } } })
  const render = renderer(() => ShareMenu({ id: 'note', shown: 'mine', status: 'idle', hasEnhanced: false, beforeUse: async () => true }))
  find(render(), 'share-button').props.onClick({ detail: 0 })
  find(render(), 'share-export').props.onClick()
  await vi.advanceTimersByTimeAsync(2100)
  expect(() => find(render(), 'share-export-retry')).toThrow('Missing')
  const notice = toast.mock.lastCall?.[0]
  expect(notice).toMatchObject({ title: "Couldn't save the file", timeout: 0, actionProps: { children: 'Try again' } })
  await (notice!.actionProps!.onClick as Function)()
  expect(save.mock.calls).toEqual([['note', 'mine'], ['note', 'mine']])
})


it('collapses expanded results for a new search and each new button opening', async () => {
  const c = mentionComposer(false)
  c.targets.mockResolvedValue(Array.from({ length: 20 }, (_, i) => ({ kind: 'meeting', id: String(i), title: `Plan ${i}` })))
  c.popup().onOpenChange(true)
  await c.lookup()
  find(c.render(), `${c.prefix}-context-6`).props.onClick()
  find(c.render(), 'Search meetings and folders').props.onChange({ target: { value: 'Plan' } })
  await c.lookup()
  expect(find(c.render(), `${c.prefix}-context-10`).props.children[1].props.children).toBe('10 more results')
  find(c.render(), `${c.prefix}-context-10`).props.onClick()
  c.popup().onOpenChange(false)
  c.popup().onOpenChange(true)
  await c.lookup()
  expect(find(c.render(), `${c.prefix}-context-6`).props.children[1].props.children).toBe('15 more results')
})


it.each([false, true])('uses a ghost scope button only for All meetings (panel: %s)', panel => {
  const c = mentionComposer(panel)
  const scope = () => find(c.render(), 'ask-scope').props
  expect(scope().className.split(' ')).not.toContain('ghost-btn')
  expect(find(c.render(), 'ask-scope-clear').props['aria-label']).toBe('Clear meetings')
  c.initial.chips = []
  expect(scope()['aria-label']).toBe('Choose meetings or folders')
  expect(scope().className.split(' ')).toContain('ghost-btn')
})

it.each([0, 1, 2, 5])('labels a scope of %s items without truncating its count', count => {
  const chips = Array.from({ length: count }, (_, i) => ({ kind: 'meeting' as const, id: String(i), title: 'A very long meeting title '.repeat(20) }))
  const label = scopeLabel(chips)
  expect(label.name).toBe(count ? chips[0].title.trim() : 'All meetings')
  expect(label.others).toBe(count > 1 ? `and ${count - 1} more` : '')
  const contents = AskContext({ chips })
  expect(find(contents, 'ask-scope-name').props.children).toBe(label.name)
  if (count > 1) expect(find(contents, 'ask-scope-others').props.children[1].props).toMatchObject({ dir: 'ltr', children: `+${count - 1}` })
})

it('caps selected scope at three, reveals the rest, and gives query matches the full list', async () => {
  const c = mentionComposer(true)
  c.initial.chips = Array.from({ length: 5 }, (_, i) => ({ kind: i ? 'meeting' : 'folder', id: String(i), title: `Scope ${i}` }))
  c.popup().onOpenChange(true)
  await c.lookup()
  expect(find(c.render(), 'In this chat').props.children[1]).toHaveLength(3)
  expect(find(c.render(), `${c.prefix}-context-3`).props.children[1].props.children).toBe('and 2 more')
  expect(find(c.render(), `${c.prefix}-context-4`).props.children[1].props.children).toBe('Already attached')
  find(c.render(), `${c.prefix}-context-3`).props.onClick()
  expect(find(c.render(), 'In this chat').props.children[1]).toHaveLength(5)
  c.targets.mockResolvedValue([c.initial.chips[0]])
  find(c.render(), 'Search meetings and folders').props.onChange({ target: { value: 'Scope' } })
  await c.lookup()
  expect(() => find(c.render(), 'In this chat')).toThrow('Missing')
  const row = find(c.render(), `${c.prefix}-context-0`).props
  expect(row['aria-selected']).toBe(true)
  expect(row.children[1].props.children).toBe('Scope 0')
  expect(() => find(c.render(), `${c.prefix}-context-1`)).toThrow('Missing')
  row.onClick(); await c.flush()
  expect(c.removeContext).toHaveBeenCalledExactlyOnceWith(c.initial.id, c.initial.chips[0])
  expect(c.popup().open).toBe(true)
})

it.each(['picker', 'pill'])('clears saved and draft scope from the %s and keeps history', async control => {
  const c = mentionComposer(false)
  c.initial.firstChips = [...c.initial.chips]
  c.initial.draftChips = [{ kind: 'folder', id: 'pending', title: 'Pending' }]
  const scope = [...c.initial.chips, ...c.initial.draftChips]
  c.popup().onOpenChange(true)
  await c.lookup()
  find(c.render(), control === 'picker' ? 'text-action ask-picker-clear' : 'ask-scope-clear').props.onClick()
  await c.flush()
  expect(c.removeContext.mock.calls).toEqual(scope.map(chip => [c.initial.id, chip]))
  expect(c.popup().open).toBe(true)
  c.initial.chips = []; c.initial.draftChips = []
  expect(scopeLabel(c.initial.chips).name).toBe('All meetings')
  expect(() => find(c.render(), 'ask-scope-clear')).toThrow('Missing')
  expect(() => find(c.render(), 'In this chat')).toThrow('Missing')
  expect(c.initial.firstChips).toEqual([scope[0]])
})

it('retries a failed player track while keeping the healthy track mounted', async () => {
  const { Player } = await import('../src/renderer/src/components/Player')
  const hook = vi.spyOn(await import('react'), 'useImperativeHandle').mockImplementation(() => {})
  try {
    const openTranscript = vi.fn()
    const player = Player({ id: 'test', tracks: ['me', 'them'], openTranscript })!
    const render = renderer(() => (player.type as Function)(player.props))
    find(render(), 'player-audio-them').props.onError({ currentTarget: { error: { code: 2 } } })
    expect(find(render(), 'player-audio-me').key).toBe('me')
    find(render(), 'player-retry').props.onClick()
    expect(find(render(), 'player-audio-them').key).toBe('them')
    expect(find(render(), 'player-audio-me').key).toBe('me')
    for (const track of ['me', 'them']) {
      find(render(), 'player-audio-' + track).props.onError({ currentTarget: { error: { code: 4 } } })
    }
    const link = find(render(), 'player-open-transcript')
    expect(link.type).toBe('a')
    expect(link.props.href).toBe('#transcript-lines')
    expect(find(render(), 'player-retry').props.className).toBe('workspace-button')
    link.props.onClick({ preventDefault() {} })
    expect(openTranscript).toHaveBeenCalledOnce()
  } finally { hook.mockRestore() }
})


it('adds only pending scope after a chat starts and disables toggles during an answer', async () => {
  const c = mentionComposer(true)
  c.initial.firstChips = [...c.initial.chips]
  c.popup().onOpenChange(true)
  await c.lookup()
  find(c.render(), `${c.prefix}-context-1`).props.onClick()
  await c.flush()
  expect(c.context).toHaveBeenCalledWith(c.initial.id, [{ kind: 'meeting', id: 'meeting', title: 'Planning review' }])
  c.initial.turns = [{ id: 1, question: 'Question', answer: '', status: 'answering', sources: [] }]
  const row = find(c.render(), `${c.prefix}-context-0`).props
  expect(row.disabled).toBe(true)
  row.onClick(); await c.flush()
  expect(c.removeContext).not.toHaveBeenCalled()
})


it('toggles query matches repeatedly without closing (mouse)', async () => {
  const c = mentionComposer(false)
  c.initial.chips = []
  const target = { kind: 'folder' as const, id: 'planning', title: 'Planning' }
  c.targets.mockResolvedValue([target])
  c.context.mockImplementation(async (_id, chips) => { c.initial.chips = chips })
  c.removeContext.mockImplementation(async () => { c.initial.chips = [] })
  c.popup().onOpenChange(true)
  find(c.render(), 'Search meetings and folders').props.onChange({ target: { value: 'Plan' } })
  await c.lookup()
  for (const checked of [true, false, true]) {
    find(c.render(), `${c.prefix}-context-0`).props.onClick()
    await c.flush()
    expect(find(c.render(), `${c.prefix}-context-0`).props['aria-selected']).toBe(checked)
    expect(c.popup().open).toBe(true)
    expect(c.input().value).toBe('Keep this question')
  }
  c.popup().onOpenChange(false)
  c.popup().children[1].props.children.props.children.props.finalFocus()
  expect(c.caret.setSelectionRange).toHaveBeenCalledWith(5, 9)
})

it('Enter picks a query match and closes the picker, back to the question', async () => {
  const c = mentionComposer(false)
  c.initial.chips = []
  const target = { kind: 'folder' as const, id: 'planning', title: 'Planning' }
  c.targets.mockResolvedValue([target])
  c.context.mockImplementation(async (_id, chips) => { c.initial.chips = chips })
  c.popup().onOpenChange(true)
  find(c.render(), 'Search meetings and folders').props.onChange({ target: { value: 'Plan' } })
  await c.lookup()
  c.key(find(c.render(), 'Search meetings and folders').props, 'Enter')
  await c.flush()
  expect(c.context).toHaveBeenCalledWith(expect.anything(), [target])
  expect(c.popup().open).toBe(false)
  expect(c.input().value).toBe('Keep this question')
})

it('keeps checked scope and reports failed removal without closing', async () => {
  const c = mentionComposer(true)
  c.removeContext.mockRejectedValue(new Error('write failed'))
  c.popup().onOpenChange(true)
  await c.lookup()
  find(c.render(), `${c.prefix}-context-0`).props.onClick()
  await c.flush()
  expect(find(c.render(), `${c.prefix}-context-0`).props['aria-selected']).toBe(true)
  expect(find(c.render(), 'chat-send-error').props.role).toBe('alert')
  expect(c.popup().open).toBe(true)
  expect(c.input().readOnly).toBe(false)
})


it('uses a required native clock and keeps incomplete times out of the upload', async () => {
  const { AudioUploadWhen } = await import('../src/renderer/src/components/AudioUploadWhen')
  const at = +new Date(2025, 0, 3, 8), onChange = vi.fn()
  const fields = renderer(() => AudioUploadWhen({ at, durationMs: 60000, onChange }))
  const render = () => find(fields(), 'Start time').props
  expect(render()).toMatchObject({ type: 'time', required: true })
  const field = { value: '', setCustomValidity: vi.fn() }
  render().onChange({ currentTarget: field })
  render().onBlur({ currentTarget: field })
  expect(render()['aria-invalid']).toBe(true)
  expect(find(fields(), 'upload-time-error').props.id).toBe(render()['aria-describedby'])
  expect(onChange).not.toHaveBeenCalled()
  field.value = '23:59'
  render().onChange({ currentTarget: field })
  expect(onChange).toHaveBeenLastCalledWith(+new Date(2025, 0, 3, 23, 59))
  expect(render()['aria-invalid']).toBeUndefined()
})


it('prefills a reopened picker and anchors it to the composer without sideways fallback', async () => {
  const c = mentionComposer(false)
  find(c.render(), 'ask-scope').props.onPointerEnter()
  await c.flush()
  c.popup().onOpenChange(true)
  expect(find(c.render(), `${c.prefix}-context-1`).props.children[1].props.children).toBe('Planning review')
  const positioner = find(c.render(), 'ask-selector-positioner').props
  expect(positioner.anchor).toBe(find(c.render(), `${c.prefix}-box`).props.ref)
  expect(positioner.collisionAvoidance).toEqual({ fallbackAxisSide: 'none' })
  expect(positioner.align).toBe('start')
  expect(positioner.sideOffset).toBe(6)
})

it('checks an inline match already in scope and consumes its mention without adding it twice', async () => {
  const c = mentionComposer(false, '')
  c.targets.mockResolvedValue([c.initial.chips[0]])
  c.type('@Already')
  await c.lookup()
  const row = find(c.render(), `${c.prefix}-context-0`).props
  expect(row.children[2].type).toBe(Check)
  c.key(c.input(), 'Enter')
  await c.flush()
  expect(c.context).not.toHaveBeenCalled()
  expect(c.removeContext).not.toHaveBeenCalled()
  expect(c.input().value).toBe('')
  expect(c.input()['aria-expanded']).toBe(false)
})

it.each([false, true])('keeps Copy on the current answer without revealing older controls during streaming (panel: %s)', panel => {
  vi.stubGlobal('document', { body: {} })
  vi.stubGlobal('window', { yogurt: { conversations: {} } })
  const initial: ConversationView = { id: 'copy-visibility', title: '', draft: '', chips: [], draftChips: [], firstChips: [], waitsForMeeting: false, waitsForModel: false,
    turns: [1, 2, 3].map(id => ({ id, question: 'What changed?', answer: 'The release is ready.', status: 'done', sources: [], createdAt: id })) }
  const render = renderer(() => AskConversation({ id: initial.id, initial, panel, onSelect() {}, onDeleted() {}, onSource() {} }))
  const turns = () => find(render(), 'ask-thread-content').props.children.props.children[0] as ReactElement<any>[]
  expect(turns().map(turn => turn.props.showCopy)).toEqual([false, false, true])
  initial.turns[2].status = 'answering'
  expect(turns().map(turn => turn.props.showCopy)).toEqual([false, false, true])
  initial.turns[2].status = 'waiting'
  expect(turns().map(turn => turn.props.showCopy)).toEqual([false, false, true])
  initial.turns[2].status = 'failed'
  initial.turns[2].answer = ''
  expect(turns().map(turn => turn.props.showCopy)).toEqual([false, false, true])
})

it('hands the same shell from the Mac launch to a read error, checking and the ready workspace', async () => {
  vi.useFakeTimers()
  let checking!: (s: { phase: string }) => void
  vi.stubGlobal('window', { innerWidth: 1100, yogurt: { platform: 'darwin',
    setup: { state: vi.fn().mockRejectedValue(new Error('read')), onState: (update: typeof checking) => { checking = update; return () => {} } },
    onboarding: { plan: async () => ({ steps: [], intro: false }) },
  } })
  const render = renderer(App)
  let tree = render()
  expect(find(tree, 'MacLaunch').props.active).toBe(true)
  const shell = find(tree, 'app-shell')
  expect(shell.props.inert).toBe(true)
  const [readSetup, readPlan] = vi.mocked(useEffect).mock.calls.slice(2, 4)
  readSetup[0](); readPlan[0]()
  await Promise.resolve()
  tree = render()
  expect(find(tree, 'MacLaunch').props.active).toBe(false)
  expect(find(tree, 'ReadError').props.testId).toBe('setup-read-error')
  checking({ phase: 'checking' })
  expect(find(render(), 'MacLaunch').props.active).toBe(true)
  checking({ phase: 'ready' })
  render()
  vi.mocked(useEffect).mock.calls[4][0]() // readiness releases the launch hold
  vi.runAllTimers()
  tree = render()
  expect(find(tree, 'app-shell').type).toBe(shell.type)
  expect(find(tree, 'app-shell').props.inert).toBeUndefined()
  expect(find(tree, 'MacLaunch').props.active).toBe(false)
  const workspace = find(tree, 'Workspace')
  expect(workspace.props.route).toBe('')
})
