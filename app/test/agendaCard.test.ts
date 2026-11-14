import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { autoUpdate, computePosition } from '@floating-ui/dom'
import { agendaCardSide, agendaCardSpace } from '../src/shared/agendaCard'
import { positionAgendaCard } from '../src/renderer/src/useAgendaCard'

vi.mock('@floating-ui/dom', async original => ({
  ...await original<typeof import('@floating-ui/dom')>(), autoUpdate: vi.fn(), computePosition: vi.fn(),
}))
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

const column = { top: 50, bottom: 750, left: 800, right: 1100 }
const list = { top: 270, bottom: 720, left: 820, right: 1080 }
const viewport = { width: 1100, height: 760 }
const row = (top: number, bottom: number) => ({ top, bottom, left: 820, right: 1080 })

it.each([false, true])('tracks scrolling immediately and only animates flips without reduced motion (reduced: %s)', async reduced => {
  let update = () => {}, top = 650
  const stop = vi.fn(), cancel = vi.fn(), animate = vi.fn(() => ({ cancel }))
  vi.mocked(autoUpdate).mockImplementation((_row, _el, callback) => { update = callback; return stop })
  vi.mocked(computePosition).mockImplementation(async (_row, _el, { placement = 'bottom' } = {}) => ({
    x: 8, y: placement === 'top' ? top - 212 : top + 72, placement, strategy: 'absolute', middlewareData: {},
  }))
  vi.stubGlobal('innerWidth', viewport.width)
  vi.stubGlobal('innerHeight', viewport.height)
  vi.stubGlobal('getComputedStyle', () => ({ paddingTop: '16', paddingBottom: '16', rowGap: '16', marginTop: '0', marginBottom: '0' }))
  const content = { style: {}, children: [{ getBoundingClientRect: () => ({ height: 100 }) }], querySelector: () => null }
  const tip = { style: {} }
  const el = { style: { top: '0px', visibility: 'hidden' }, dataset: { side: '' }, animate,
    getBoundingClientRect: () => ({ top: parseFloat(el.style.top) }),
    querySelector: (selector: string) => selector === '.agenda-inspector-arrow' ? tip : content,
  }
  const cleanup = positionAgendaCard(el as unknown as HTMLElement,
    { isConnected: true, getBoundingClientRect: () => row(top, top + 60) } as HTMLElement,
    { getBoundingClientRect: () => list } as HTMLElement,
    { getBoundingClientRect: () => ({ ...column, x: column.left, y: column.top, width: 300, height: 700 }) } as HTMLElement,
    vi.fn(), reduced)
  try {
    for (const [rowTop, side, flips] of [[650, 'top', 0], [618, 'top', 0], [280, 'bottom', 1], [650, 'top', 2]] as const) {
      top = rowTop
      update()
      await Promise.resolve()
      expect(el.dataset.side).toBe(side)
      expect(el.style.top).toBe(`${side === 'top' ? top - 212 : top + 72}px`)
      expect(animate).toHaveBeenCalledTimes(reduced ? 0 : flips)
    }
  } finally { cleanup() }
  expect(stop).toHaveBeenCalledOnce()
})

it('left-aligns a single agenda-card action with the icon column and keeps the 16px divider rhythm', () => {
  const css = readFileSync(new URL('../src/renderer/src/workspace.css', import.meta.url), 'utf8')
  expect(css).toMatch(/\.agenda-inspector \.agenda-inspector-actions:has\(>:only-child\) \{ justify-content:flex-start; \}/)
  // Rows with two or more actions retain the shared right alignment.
  expect(css).toMatch(/\.agenda-inspector-actions \{[^}]*justify-content:flex-end;/)
  expect(css).toMatch(/\.agenda-inspector \.agenda-inspector-footer \{ gap:16px; \}/)
  expect(css).toMatch(/\.agenda-inspector-footer \{[^}]*padding-top:16px;/)
})

describe('agenda card placement', () => {
  it('opens above a bottom row, below a top row, with 8px insets and 12px row clearance', () => {
    const bottom = agendaCardSpace(column, list, row(650, 710), viewport)
    expect(bottom).toEqual({ visible: true, top: 580, bottom: 20, width: 284 })
    expect(agendaCardSide(bottom)).toBe('top')
    expect(agendaCardSide(agendaCardSpace(column, list, row(280, 330), viewport))).toBe('bottom')
  })
  it('uses the visible window intersection and never produces a negative size', () => {
    expect(agendaCardSpace({ top: -100, bottom: 900, left: -20, right: 1200 }, list, row(280, 330), viewport))
      .toEqual({ visible: true, top: 260, bottom: 410, width: 1084 })
    const space = agendaCardSpace({ top: 300, bottom: 310, left: 900, right: 910 }, list, row(290, 320), viewport)
    expect(space).toMatchObject({ top: 0, bottom: 0, width: 0 })
  })
  it('keeps a partially visible row and dismisses one that leaves either list edge', () => {
    expect(agendaCardSpace(column, list, row(250, 280), viewport).visible).toBe(true)
    expect(agendaCardSpace(column, list, row(710, 740), viewport).visible).toBe(true)
    expect(agendaCardSpace(column, list, row(230, 270), viewport).visible).toBe(false)
    expect(agendaCardSpace(column, list, row(720, 760), viewport).visible).toBe(false)
  })
  it('uses the roomier side immediately on first open, with a stable bottom tie', () => {
    expect(agendaCardSide({ top: 301, bottom: 300 })).toBe('top')
    expect(agendaCardSide({ top: 300, bottom: 301 })).toBe('bottom')
    expect(agendaCardSide({ top: 300, bottom: 300 })).toBe('bottom')
  })
  it('requires more than 24px advantage to flip in either direction', () => {
    expect(agendaCardSide({ top: 300, bottom: 324 }, 'top')).toBe('top')
    expect(agendaCardSide({ top: 300, bottom: 325 }, 'top')).toBe('bottom')
    expect(agendaCardSide({ top: 324, bottom: 300 }, 'bottom')).toBe('bottom')
    expect(agendaCardSide({ top: 325, bottom: 300 }, 'bottom')).toBe('top')
  })
  it('does not flicker when scrolling back and forth near equal space', () => {
    let side = agendaCardSide({ top: 330, bottom: 300 })
    for (const top of [300, 290, 310, 288, 302, 276]) side = agendaCardSide({ top, bottom: 300 }, side)
    expect(side).toBe('top')
    side = agendaCardSide({ top: 275, bottom: 300 }, side)
    expect(side).toBe('bottom')
    for (const top of [290, 310, 324]) side = agendaCardSide({ top, bottom: 300 }, side)
    expect(side).toBe('bottom')
  })
})
