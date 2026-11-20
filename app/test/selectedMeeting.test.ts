import { afterEach, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PastCard } from '../src/renderer/src/screens/Home'
import type { MeetingCard } from '../src/shared/types'

afterEach(() => vi.unstubAllGlobals())

it('marks each selected meeting inside its identity tile', () => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) })
  const c: MeetingCard = { eventId: null, app: null, language: null, titleSource: 'user', id: 'm1', title: 'Planning', state: 'done', startedAt: 1, endedAt: 2, attendees: [], preview: '' }
  const row = (selected: boolean) => renderToStaticMarkup(createElement(PastCard, { c, me: '', selected, onOpen() {} }))
  expect(row(true)).toMatch(/meeting-identity[^<]*>\s*<svg[^>]*data-testid="meeting-selected"/)
  expect(row(false)).not.toContain('meeting-selected')
})
