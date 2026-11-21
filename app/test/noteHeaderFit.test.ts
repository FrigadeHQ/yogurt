import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { Children, isValidElement, type ReactNode } from 'react'
import type { Meeting } from '../src/shared/types'
import { NoteDate } from '../src/renderer/src/components/NoteDate'

vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (value: unknown) => [value, vi.fn()], useRef: () => ({ current: null }), useCallback: (fn: unknown) => fn,
}))
vi.mock('../src/renderer/src/motion', () => ({ usePopoverPresence: () => ({}) }))
vi.mock('../src/renderer/src/useNoteCalendar', () => ({ useNoteCalendar: () => ({}) }))
afterEach(() => vi.unstubAllGlobals())

type ChipChild = { className?: string; children?: ReactNode; ref?: (el: HTMLElement) => (() => void) | undefined }
function findName(node: ReactNode): ChipChild | undefined {
  if (!isValidElement<ChipChild>(node)) return
  if (node.props.className === 'note-date-chip-name') return node.props
  return Children.toArray(node.props.children).map(findName).find(Boolean)
}

it('ellipsizes the linked name to fit Resume and Copy at 764px and returns their space on wrap', () => {
  // Border boxes from the 2× screenshot. The full name occupies 132px of the 227.5px date chip.
  const box = (width: number) => ({ getBoundingClientRect: () => ({ width }), getClientRects: () => [1] })
  const anchor = box(227.5), people = box(151.5), folder = box(119)
  const actions = box(248), row = { ...box(764), querySelector: () => actions }
  const chips = { children: [anchor, people, folder], closest: () => row }
  const button = { ...box(227.5), parentElement: anchor, closest: () => chips, children: [] }
  const name = { ...box(132), closest: () => button, style: { maxInlineSize: '' } }
  let resize!: () => void
  const disconnect = vi.fn()
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback }
    observe() {}
    disconnect = disconnect
  })
  vi.stubGlobal('getComputedStyle', (el: unknown) => ({ columnGap: el === row ? '12px' : '8px', font: '13px system-ui' }))
  vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ measureText: () => ({ width: 8 }) }) }) })

  const eventTitle = 'BOWLS AND DOMION'
  const date = NoteDate({ m: { startedAt: Date.now(), eventId: 'linked', eventTitle } as Meeting })
  const renderedName = findName(date)
  expect(renderedName).toBeDefined()
  const cleanup = renderedName?.ref?.(name as unknown as HTMLElement)
  const used = () => Math.min(132, parseFloat(name.style.maxInlineSize) || 132)
  const rowWidth = () => 514 - (132 - used()) + 12 + 248
  expect(rowWidth()).toBe(764) // previously 774px
  expect(used()).toBe(122)

  row.getBoundingClientRect = () => ({ width: 450 })
  resize()
  expect(used()).toBe(68)
  row.getBoundingClientRect = () => ({ width: 400 })
  resize()
  expect(used()).toBe(64) // retain eight characters before other chips wrap
  // With the recording controls and two chips, the same rule uses the new widths.
  row.getBoundingClientRect = () => ({ width: 530 })
  chips.children = [anchor, folder]
  actions.getBoundingClientRect = () => ({ width: 214 })
  resize()
  expect(used()).toBe(81.5)
  chips.children = [anchor]
  resize()
  expect(used()).toBe(132)
  cleanup?.()
  expect(disconnect).toHaveBeenCalledOnce()
})

it('anchors wrapped actions to the inline end in both writing directions', () => {
  const css = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')
  const actions = css.match(/\.note-header-actions \{([^}]+)\}/)?.[1]
  expect(actions).toContain('margin-inline-start:auto')
  expect(actions).toContain('justify-content:flex-end')
})
