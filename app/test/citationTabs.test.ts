import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { SourceCitationCard } from '../src/renderer/src/components/SourceCitation'
import type { LibrarySource } from '../src/shared/types'

vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useId: () => 'card', useState: (value: unknown) => [value, vi.fn()], useRef: () => ({ current: null }), useLayoutEffect: vi.fn() }))
vi.mock('../src/renderer/src/motion', async original => ({ ...await original<typeof import('../src/renderer/src/motion')>(), useReducedMotion: () => true }))
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap(child => isValidElement(child) ? [child as ReactElement<Record<string, unknown>>, ...elements((child.props as { children?: ReactNode }).children)] : [])
}
const source = (n: number): LibrarySource => ({ n, meetingId: `meeting-${n}`, title: `Quarterly release planning and budget review ${n}`, startedAt: 1, atMs: n * 60000, excerpt: 'The pilot will launch Thursday.' })
const render = (sources: LibrarySource[]) => elements(SourceCitationCard({ source: sources[0], additionalSources: sources.slice(1), sentence: 'The pilot will launch Thursday.', triggerId: null, open: true, animate: false, onOpen: vi.fn() }))
describe('source tabs', () => {
  it.each([1, 2, 3, 5])('keeps all %i sources with no more than three tabs', count => {
    const sources = Array.from({ length: count }, (_, i) => source(i + 1)), tree = render(sources)
    const tabs = tree.filter(e => e.props.role === 'tab'), panels = tree.filter(e => e.props.role === 'tabpanel')
    expect(tabs).toHaveLength(count === 1 ? 0 : Math.min(count, 3))
    expect(tree.filter(e => e.props['data-testid'] === 'citation-open')).toHaveLength(count)
    if (count === 1) return
    expect(tabs.map(e => e.props.tabIndex)).toEqual(count === 2 ? [0, -1] : [0, -1, -1])
    expect(panels.map(e => e.props.inert)).toEqual(count === 2 ? [false, true] : [false, true, true])
    for (const [i, tab] of tabs.entries()) {
      expect(tab.props['aria-controls']).toEqual(panels[i].props.id)
      expect(panels[i].props['aria-labelledby']).toEqual(tab.props.id)
      expect(tab.props.title).toEqual(tab.props['aria-label'])
    }
    if (count === 5) {
      expect(tabs[2].props.children).toBe('+3')
      expect(tabs[2].props['data-overflow']).toBe(true)
      expect(elements(panels[2]).filter(e => e.props['data-testid'] === 'citation-open')).toHaveLength(3)
      for (const s of sources.slice(2)) expect(tabs[2].props['aria-label']).toContain(s.title)
    } else expect(tabs.map(e => e.props['aria-label'])).toEqual(sources.map(s => s.title))
  })
  it('uses moment labels for multiple moments of the same meeting and retains its full name', () => {
    const first = source(1), second = { ...source(2), meetingId: first.meetingId, title: first.title }
    const tabs = render([first, second]).filter(e => e.props.role === 'tab')
    expect(tabs.map(e => e.props.children)).toEqual(['1:00', '2:00'])
    expect(tabs[1].props['aria-label']).toBe(`${first.title} · 2:00`)
  })
})
