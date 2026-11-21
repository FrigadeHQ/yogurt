import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { useLayoutEffect, useRef, useState } from 'react'
import { cubicBezier } from 'motion'
import { captureMeetingRows, playMeetingRows, changeMeetingRows, readMeetingRows, useMeetingRowMotion } from '../src/renderer/src/meetingRowMotion'
import { motion, usePopoverPresence } from '../src/renderer/src/motion'
import { useLoadingState } from '../src/renderer/src/useLoadingState'

vi.mock('react', async original => ({
  ...await original<typeof import('react')>(), useCallback: (callback: unknown) => callback, useState: vi.fn(), useLayoutEffect: vi.fn(), useEffect: vi.fn(), useRef: vi.fn(),
}))
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

it('keeps CSS and JS timing in sync and bounds the shared rebound below two percent', () => {
  const css = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')
  for (const token of ['micro', 'base', 'surface'] as const) expect(css).toContain(`--dur-${token}: ${motion[token]}ms`)
  for (const [token, value] of [['out', motion.ease], ['in-out', motion.move], ['soft', motion.soft]]) {
    const actual = css.match(new RegExp(`--ease-${token}: ([^;]+);`))![1]
    expect(actual.replace(/(?<=\D)0\./g, '.')).toBe(value.replace(/(?<=\D)0\./g, '.'))
  }
  const ease = cubicBezier(...motion.softCurve)
  const peak = Math.max(...Array.from({ length: 1001 }, (_, n) => ease(n / 1000)))
  expect(peak).toBeGreaterThan(1)
  expect(peak).toBeLessThanOrEqual(1.02)
  expect(ease(1)).toBe(1)
})

// Exercise retained presence and effect cleanup without launching a browser.
function popover() {
  let last = { value: false, animate: false }, cleanup: (() => void) | void
  const set = (next: unknown) => { last = next as typeof last }
  return (open: boolean, animate = true) => {
    cleanup?.()
    vi.mocked(useState).mockReturnValue([last, set])
    const result = usePopoverPresence(open, animate)
    cleanup = vi.mocked(useLayoutEffect).mock.lastCall![0]()
    return result
  }
}

it('makes closing controls inert immediately and cancels their removal on a fast reopen', () => {
  vi.useFakeTimers()
  const render = popover()
  expect(render(true, true).props.inert).toBe(false)
  const closing = render(false)
  expect(closing.value).toBe(true)
  expect(closing.props).toMatchObject({ inert: true, 'data-motion': undefined, 'data-ending-style': '' })
  vi.advanceTimersByTime(motion.micro / 2)
  const reopened = render(true, true)
  expect(reopened.props['data-ending-style']).toBeUndefined()
  vi.advanceTimersByTime(motion.micro)
  expect(render(true, true).value).toBe(true)
  render(false)
  vi.advanceTimersByTime(motion.micro)
  expect(render(false).value).toBeUndefined()
})

it('retains keyboard popovers for the same exit and keeps context menus instant', () => {
  vi.useFakeTimers()
  const render = popover()
  expect(render(true).props['data-motion']).toBeUndefined()
  expect(render(false).value).toBe(true)
  vi.advanceTimersByTime(motion.micro)
  expect(render(false).value).toBeUndefined()
  expect(render(true, false).props['data-motion']).toBe('instant')
  expect(render(false, false).value).toBeUndefined()
})

it.each([false, true])('holds a shown skeleton normally, but always keeps the short reveal (reduced: %s)', reduced => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  let phase = 'waiting', cleanup: (() => void) | void
  const shownAt = { current: undefined as number | undefined }
  const render = (pending: boolean) => {
    cleanup?.()
    vi.mocked(useState).mockReturnValueOnce([reduced, vi.fn()])
      .mockReturnValueOnce([phase, next => { phase = next as string }])
    vi.mocked(useRef).mockReturnValue(shownAt)
    const result = useLoadingState(pending)
    cleanup = vi.mocked(useLayoutEffect).mock.lastCall![0]()
    return result
  }
  render(true)
  vi.advanceTimersByTime(99)
  expect(phase).toBe('waiting')
  vi.advanceTimersByTime(1)
  expect(render(true)).toBe('skeleton')
  render(false)
  if (!reduced) {
    vi.advanceTimersByTime(199)
    expect(phase).toBe('skeleton')
    vi.advanceTimersByTime(1)
  }
  expect(render(false)).toBe('revealing')
  vi.advanceTimersByTime(motion.micro - 1)
  expect(phase).toBe('revealing')
  vi.advanceTimersByTime(1)
  expect(render(false)).toBe('ready')
})

it('keeps search subtle and mentions and tabs fading on the short token for either input method', () => {
  const styles = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')
  const workspace = readFileSync(new URL('../src/renderer/src/workspace.css', import.meta.url), 'utf8')
  const search = styles.match(/\.search-panel\.dialog-motion,\.search-panel\.dialog-motion\[data-ending-style\] \{([^}]+)\}/)![1]
  expect(search).toContain('transition:opacity var(--dur-micro) var(--ease-out)')
  expect(search).toContain('transform var(--dur-micro) var(--ease-out)')
  expect(styles).toContain('.search-panel.dialog-motion[data-starting-style],.search-panel.dialog-motion[data-ending-style] { transform:scale(.99); }')
  expect(workspace.match(/\.ask-picker \{([^}]+)\}/)![1]).toContain('animation:ask-fade var(--dur-micro) var(--ease-out)')
  expect(workspace).not.toContain('.ask-picker { animation:none; }')
  expect(styles).toContain('::view-transition-new(root) { animation:note-panel-in var(--dur-micro) var(--ease-out)')
})

it('keeps the anchored panel curve monotonic with a shorter close', () => {
  expect(motion.base).toBe(180)
  expect(motion.askExit).toBe(150)
  const ease = cubicBezier(...motion.out)
  let previous = 0
  for (let n = 0; n <= 1000; n++) {
    const progress = ease(n / 1000)
    expect(progress).toBeGreaterThanOrEqual(previous)
    expect(progress).toBeLessThanOrEqual(1)
    previous = progress
  }
  const styles = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')
  const surface = styles.match(/\.chat-morph-surface \{([^}]+)\}/)![1]
  // Animated left/top and width/height must not be overconstrained by right/bottom in RTL.
  expect(surface).toContain('inset:var(--ask-top) auto auto var(--ask-left)')
  expect(surface).toContain('width:calc(100% + 2px);height:calc(100% + 2px)')
  expect(surface).not.toContain('transform')
  expect(surface).not.toContain('pointer-events:none')
  expect(styles).toMatch(/\.chat-panel-viewport \{[^}]*container-type:size/)
  const contents = styles.match(/\.chat-panel-contents \{([^}]+)\}/)![1]
  expect(contents).toContain('width:100cqw;height:100cqh')
  for (const edge of ['left', 'top']) {
    expect(styles).toContain(`@property --ask-${edge} { syntax:"<length>";inherits:true;initial-value:-1px; }`)
    expect(contents).toContain(`${edge}:calc(-1px - var(--ask-${edge}))`)
  }
})

it('moves the sidebar and page together with the original timing and child layout', () => {
  const css = readFileSync(new URL('../src/renderer/src/workspace.css', import.meta.url), 'utf8')
  const source = readFileSync(new URL('../src/renderer/src/components/Workspace.tsx', import.meta.url), 'utf8')
  expect(source).toContain('duration: sidebarMotion ? 0.2 : 0, ease: [0.22, 1, 0.36, 1]')
  for (const component of ['Gap', 'Container']) {
    expect(source).toMatch(new RegExp(`<Sidebar\\.${component}[^>]+transition=\\{sidebarTransition\\}`))
  }
  expect(css).toContain('.workspace-sidebar::after { content:"";position:absolute;inset-block:52px 0;inset-inline-end:-1px;')
  expect(css).not.toContain('.workspace-sidebar-gap::after')
  expect(css).toContain('.workspace-sidebar-inner { display:flex;flex-direction:column;height:100%;min-height:0; }')
  expect(css).not.toContain('.sidebar-collapsed .workspace-sidebar-inner')
  expect(css).toContain('.workspace[data-sidebar-motion=true] .workspace-toolbar { transition:padding-inline-start 200ms cubic-bezier(.22,1,.36,1); }')
  expect(css).toMatch(/@media \(prefers-reduced-motion:reduce\)\s*\{\s*\.accordion\.workspace-folder-panel,\.accordion\.workspace-folder-panel>\* \{ transition:none;/)
  const styles = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')
  for (const animation of ['icon-lift', 'icon-write', 'icon-turn']) expect(css + styles).not.toContain(animation)
})

// DOM geometry is supplied here; the browser owns interpolation and hit testing.
function rowScene(ids: string[]) {
  const elements = new Map<string, ReturnType<typeof element>>()
  function element(id: string, top: number) {
    const attributes = [{ name: 'id' }, { name: 'data-testid' }, { name: 'data-row-id' }]
    const animation = { cancel: vi.fn(), onfinish: undefined as (() => void) | undefined }
    const el = { dataset: { rowId: id }, top, attributes, inert: false, style: {},
      classList: { add: vi.fn() }, setAttribute: vi.fn(), removeAttribute: vi.fn(), remove: vi.fn(),
      querySelectorAll: () => [], getBoundingClientRect: () => ({ top: el.top, left: 20, width: 400, height: 57 }),
      animate: vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => animation), cloneNode: (): unknown => element(id, el.top), animation }
    return el
  }
  for (const [i, id] of ids.entries()) elements.set(id, element(id, i * 57))
  const root = { scrollTop: 0, scrollLeft: 0, querySelectorAll: () => [...elements.values()],
    getBoundingClientRect: () => ({ top: 0, left: 0 }), append: vi.fn() }
  return { root: root as unknown as HTMLElement, elements, append: root.append }
}
const cardsFor = (...ids: string[]) => ids.map(id => ({ id, startedAt: 0 })) as import('../src/shared/types').MeetingCard[]

it('animates only marked removals and restores, leaving first load, paging and filtering still', () => {
  const scene = rowScene(['a', 'b'])
  for (const next of [cardsFor('a', 'b', 'c'), cardsFor('b'), cardsFor()]) {
    expect(captureMeetingRows(scene.root, next, new Map())).toBeUndefined()
  }
  expect(captureMeetingRows(rowScene([]).root, cardsFor('a'), new Map())).toBeUndefined()
  const pending = new Map([['a', false]])
  expect(captureMeetingRows(scene.root, cardsFor('a', 'b'), pending)).toBeUndefined()
  expect(pending.size).toBe(0)
})

it('collapses a bulk removal together, leaves failed rows live and strips all copied identities', () => {
  const scene = rowScene(['a', 'b', 'c', 'd'])
  const snapshot = captureMeetingRows(scene.root, cardsFor('c', 'd'), new Map([['a', false], ['b', false], ['c', false]]))!
  expect(snapshot.removed).toHaveLength(2)
  for (const { element: copy } of snapshot.removed) {
    expect(copy.inert).toBe(true)
    expect(copy.style.pointerEvents).toBe('none')
    expect(copy.setAttribute).toHaveBeenCalledWith('aria-hidden', 'true')
    for (const attr of ['id', 'data-testid', 'data-row-id', 'draggable']) expect(copy.removeAttribute).toHaveBeenCalledWith(attr)
  }
  scene.elements.delete('a'); scene.elements.delete('b')
  scene.elements.get('c')!.top = 0; scene.elements.get('d')!.top = 57
  const stop = playMeetingRows(scene.root, snapshot)
  expect(scene.elements.get('c')!.animate).toHaveBeenCalledWith([{ transform: 'translateY(114px)' }, { transform: 'translateY(0)' }], { duration: motion.micro, easing: motion.ease })
  expect(scene.elements.get('d')!.animate).toHaveBeenCalledTimes(1)
  expect(scene.append).toHaveBeenCalledTimes(2)
  expect(snapshot.removed[1].shift).toBe(-57)
  stop()
  expect(scene.elements.get('c')!.animation.cancel).toHaveBeenCalledOnce()
  for (const { element: copy } of snapshot.removed) expect(copy.remove).toHaveBeenCalledOnce()
})

it('reveals restored rows in their sorted position with the base timing and no text scaling', () => {
  const scene = rowScene(['a', 'c'])
  const snapshot = captureMeetingRows(scene.root, cardsFor('a', 'b', 'c'), new Map([['b', true]]))!
  const restored = rowScene(['b']).elements.get('b')!
  restored.top = 57; scene.elements.set('b', restored); scene.elements.get('c')!.top = 114
  playMeetingRows(scene.root, snapshot)
  expect(restored.animate).toHaveBeenCalledWith([{ opacity: 0, clipPath: 'inset(0 0 100% 0)' }, { opacity: 1, clipPath: 'inset(0)' }], { duration: motion.base, easing: motion.ease })
  expect(scene.elements.get('c')!.animate.mock.calls[0][0]).toEqual([{ transform: 'translateY(-57px)' }, { transform: 'translateY(0)' }])
  expect(scene.elements.get('a')!.animate).not.toHaveBeenCalled()
})

it('captures the visible position before interrupting a row movement', () => {
  const scene = rowScene(['a', 'b', 'c'])
  scene.elements.get('c')!.top = 87
  const snapshot = captureMeetingRows(scene.root, cardsFor('a', 'c'), new Map([['b', false]]))!
  scene.elements.delete('b'); scene.elements.get('c')!.top = 57
  playMeetingRows(scene.root, snapshot)
  expect(scene.elements.get('c')!.animate.mock.calls[0][0]).toEqual([{ transform: 'translateY(30px)' }, { transform: 'translateY(0)' }])
})

it('waits for a complete bulk mutation without swallowing its error or delaying its result for motion', async () => {
  let finish!: () => void
  const result = changeMeetingRows('trash', ['a', 'b'], () => new Promise<string>(resolve => { finish = () => resolve('done') }))
  const ready = vi.fn()
  const waiting = readMeetingRows(async () => undefined).then(ready)
  await Promise.resolve()
  expect(ready).not.toHaveBeenCalled()
  finish()
  expect(await result).toBe('done')
  await waiting
  expect(ready).toHaveBeenCalledOnce()
  await expect(changeMeetingRows('restore', ['a'], async () => { throw new Error('failed') })).rejects.toThrow('failed')
  await readMeetingRows(async () => undefined)
})

it.each(['meetings', 'folder/planning', 'trash'])('routes mutation intent to %s and clears it on scope changes', async scope => {
  const pending = { current: new Map<string, boolean>() }, snapshot = { current: undefined }, stop = { current: vi.fn() }
  vi.mocked(useState).mockReturnValueOnce([false, vi.fn()])
  vi.mocked(useRef).mockReturnValueOnce(pending).mockReturnValueOnce(snapshot).mockReturnValueOnce(stop)
  vi.mocked(useLayoutEffect).mockClear()
  useMeetingRowMotion({ current: null }, scope)
  const cleanup = vi.mocked(useLayoutEffect).mock.calls[0][0]()
  await changeMeetingRows('trash', ['a', 'b'], async () => {})
  expect([...pending.current]).toEqual([['a', scope === 'trash'], ['b', scope === 'trash']])
  await changeMeetingRows('restore', ['a'], async () => {})
  expect(pending.current.get('a')).toBe(scope !== 'trash')
  await changeMeetingRows('trash', ['failed'], async () => 'failed', () => [])
  expect(pending.current.has('failed')).toBe(false)
  await expect(changeMeetingRows('restore', ['rejected'], async () => { throw new Error('failed') })).rejects.toThrow('failed')
  expect(pending.current.has('rejected')).toBe(false)
  await changeMeetingRows('delete', ['b'], async () => {})
  expect(pending.current.get('b')).toBe(false)
  if (typeof cleanup === 'function') cleanup()
  expect(pending.current.size).toBe(0)
  expect(stop.current).toHaveBeenCalledOnce()
})

it('reduced motion cancels active rows immediately and performs no measurement or animation', () => {
  const scene = rowScene(['a', 'b']), measure = vi.spyOn(scene.root, 'querySelectorAll')
  const pending = { current: new Map([['a', false]]) }, snapshot = { current: undefined }, stop = { current: vi.fn() }
  vi.mocked(useState).mockReturnValueOnce([true, vi.fn()])
  vi.mocked(useRef).mockReturnValueOnce(pending).mockReturnValueOnce(snapshot).mockReturnValueOnce(stop)
  vi.mocked(useLayoutEffect).mockClear()
  const prepare = useMeetingRowMotion({ current: scene.root }, 'meetings')
  vi.mocked(useLayoutEffect).mock.calls[1][0]()
  expect(stop.current).toHaveBeenCalledOnce()
  expect(pending.current.size).toBe(0)
  prepare(cardsFor('b'))
  expect(measure).not.toHaveBeenCalled()
  expect(scene.elements.get('b')!.animate).not.toHaveBeenCalled()
})

it('retries a read begun before a mutation so partial bulk results cannot reach the list', async () => {
  let finishRead!: () => void
  const read = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishRead = () => resolve(['partial']) })).mockResolvedValue(['complete'])
  const result = readMeetingRows(read)
  await changeMeetingRows('trash', ['a', 'b'], async () => {})
  finishRead()
  expect(await result).toEqual(['complete'])
  expect(read).toHaveBeenCalledTimes(2)
})
