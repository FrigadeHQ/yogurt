import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { useLayoutEffect, useRef, useState } from 'react'
import { cubicBezier } from 'motion'
import { motion, usePopoverPresence } from '../src/renderer/src/motion'
import { useLoadingState } from '../src/renderer/src/useLoadingState'

vi.mock('react', async original => ({
  ...await original<typeof import('react')>(), useState: vi.fn(), useLayoutEffect: vi.fn(), useEffect: vi.fn(), useRef: vi.fn(),
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
  let last = { value: false, pointer: false }, cleanup: (() => void) | void
  const set = (next: unknown) => { last = next as typeof last }
  return (open: boolean, pointer: boolean) => {
    cleanup?.()
    vi.mocked(useState).mockReturnValue([last, set])
    const result = usePopoverPresence(open, pointer)
    cleanup = vi.mocked(useLayoutEffect).mock.lastCall![0]()
    return result
  }
}

it('makes closing controls inert immediately and cancels their removal on a fast reopen', () => {
  vi.useFakeTimers()
  const render = popover()
  expect(render(true, true).props.inert).toBe(false)
  const closing = render(false, false)
  expect(closing.value).toBe(true)
  expect(closing.props).toMatchObject({ inert: true, 'data-pointer': true, 'data-ending-style': '' })
  vi.advanceTimersByTime(motion.micro / 2)
  const reopened = render(true, true)
  expect(reopened.props['data-ending-style']).toBeUndefined()
  vi.advanceTimersByTime(motion.micro)
  expect(render(true, true).value).toBe(true)
  render(false, false)
  vi.advanceTimersByTime(motion.micro)
  expect(render(false, false).value).toBeUndefined()
})

it('does not retain keyboard popovers for an exit animation', () => {
  vi.useFakeTimers()
  const render = popover()
  expect(render(true, false).props['data-pointer']).toBe(false)
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
})

it('collapses sidebar controls immediately and expands children on the sidebar duration and curve', () => {
  const css = readFileSync(new URL('../src/renderer/src/workspace.css', import.meta.url), 'utf8')
  const source = readFileSync(new URL('../src/renderer/src/components/Workspace.tsx', import.meta.url), 'utf8')
  expect(source).toContain('duration: sidebarMotion ? motion.surface / 1000 : 0, ease: motion.out')
  // The page snaps to its final layout: the search field must not keep the outgoing sidebar width.
  expect(css).toContain('.sidebar-collapsed .workspace-sidebar-inner { width:55px; }')
  expect(css).toContain('.workspace:is([data-sidebar-motion=false],.sidebar-collapsed) :is(.workspace-nav>span,.workspace-nav>small,.workspace-search>span,.workspace-search>kbd,.workspace-folder-label,.workspace-wordmark,.workspace-brand) { transition:none; }')
  const children = css.slice(css.indexOf('.workspace-sidebar .workspace-nav>span'), css.indexOf('.sidebar-titlebar'))
  for (const transition of children.matchAll(/transition:([^;]+);/g)) {
    if (transition[1] === 'none' || transition[1] === 'none!important') continue
    expect(transition[1]).not.toContain('--dur-micro')
    for (const property of transition[1].split(',')) expect(property).toMatch(/var\(--dur-surface\) var\(--ease-out\)$/)
  }
  expect(children).toContain('@media (prefers-reduced-motion:reduce)')
  expect(children).toContain('transition:none!important')
})
