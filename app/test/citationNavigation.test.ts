import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import { expect, it, vi } from 'vitest'
import { SourceCitationCard } from '../src/renderer/src/components/SourceCitation'
import { AUDIO_SPEAKER } from '../src/shared/audioUpload'
import type { LibrarySource } from '../src/shared/types'

vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useId: () => 'card', useState: (value: unknown) => [value, vi.fn()], useRef: () => ({ current: null }), useLayoutEffect: vi.fn() }))
vi.mock('../src/renderer/src/motion', async original => ({ ...await original<typeof import('../src/renderer/src/motion')>(), useReducedMotion: () => true }))

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap(child => isValidElement(child)
    ? [child as ReactElement<Record<string, unknown>>, ...elements((child.props as { children?: ReactNode }).children)] : [])
}

it('opens each source at the supporting uploaded-audio line, including a zero timestamp', () => {
  const sentence = 'The export is limited to forty accounts.'
  const make = (n: number, atMs: number): LibrarySource => ({ n, meetingId: `meeting-${n}`, title: 'Release review', startedAt: 1, atMs: 300000,
    excerpt: `Audio: ${sentence}`, transcript: { speakers: [], lines: [{ text: sentence, startMs: atMs, track: 'them', speaker: AUDIO_SPEAKER }] } })
  const first = make(1, 90000), second = make(2, 0), onOpen = vi.fn()
  const card = SourceCitationCard({ source: first, additionalSources: [second], sentence, triggerId: null, open: true, animate: false, onOpen })
  const buttons = elements(card).filter(e => e.props['data-testid'] === 'citation-open')
  expect(buttons).toHaveLength(2)
  for (const button of buttons) (button.props.onClick as () => void)()
  expect(onOpen.mock.calls).toEqual([[sentence, first, 90000], [sentence, second, 0]])
})
