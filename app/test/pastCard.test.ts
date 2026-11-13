import { expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { MeetingCard } from '../src/shared/types'
import { PastCard } from '../src/renderer/src/screens/Home'

vi.mock('../src/renderer/src/components/FolderPicker', () => ({
  FolderPicker: () => null,
  FolderChip: ({ rowFolders, children }: { rowFolders: MeetingCard['folders']; children: ReactNode }) => rowFolders?.length ? children : createElement('button', { 'data-testid': 'row-suggestion' }, 'Suggested folder'),
}))
const meeting: MeetingCard = { id: 'meeting', title: 'Planning', state: 'done', startedAt: 1, endedAt: 60001, attendees: [], folders: [], preview: '', eventId: null, app: null, language: null, titleSource: 'user' }
const render = (props: Partial<Parameters<typeof PastCard>[0]> = {}) => renderToStaticMarkup(createElement(PastCard, { c: meeting, me: '', onOpen() {}, ...props }))

it('places the suggestion beside the meeting button without nesting interactive controls', () => {
  const html = render()
  expect(html).toContain('data-testid="row-suggestion"')
  expect(html.indexOf('</button>')).toBeLessThan(html.indexOf('data-testid="row-suggestion"'))
  let depth = 0
  for (const [tag] of html.matchAll(/<\/?button\b[^>]*>/g)) {
    depth += tag.startsWith('</') ? -1 : 1
    expect(depth).toBeLessThanOrEqual(1)
  }
  expect(depth).toBe(0)
})

it('does not offer suggestions for filed meetings, trash, loading rows or lists without folder pills', () => {
  const folder = { id: 'folder', name: 'Planning', icon: 'folder' as const, color: 'violet' as const, count: 1 }
  for (const props of [{ c: { ...meeting, folders: [folder] } }, { fixed: true }, { loading: true }, { showFolders: false }]) {
    expect(render(props)).not.toContain('data-testid="row-suggestion"')
  }
  expect(render({ c: { ...meeting, folders: [folder] } })).toContain('data-testid="past-note-folder"')
})
