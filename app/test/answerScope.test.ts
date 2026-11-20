import { afterEach, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { WorkspaceFolders } from '../src/renderer/src/folders'
import { AnswerScope, AskContext, ContextIcon } from '../src/renderer/src/components/AskContext'
import { AskConversation } from '../src/renderer/src/components/AskConversation'
import type { ContextTarget } from '../src/shared/askContext'
import type { ConversationTurn, ConversationView } from '../src/shared/types'

const folder: ContextTarget = { kind: 'folder', id: 'planning', title: 'Planning' }
const meeting: ContextTarget = { kind: 'meeting', id: 'release', title: 'Release review' }
afterEach(() => vi.unstubAllGlobals())

it('shows the current folder icon and color in the picker and the selected scope', () => {
  const saved = { id: folder.id, name: folder.title, icon: 'flag' as const, color: 'teal' as const, count: 0, createdAt: 1 }
  for (const child of [createElement(ContextIcon, { target: folder }), createElement(AskContext, { chips: [folder] })]) {
    const html = renderToStaticMarkup(createElement(WorkspaceFolders.Provider, { value: [saved] }, child))
    expect(html).toContain('data-folder-icon="flag"')
    expect(html).toContain('data-folder-color="teal"')
    const missing = renderToStaticMarkup(createElement(WorkspaceFolders.Provider, { value: [] }, child))
    expect(missing).toContain('data-folder-icon="folder"')
  }
})

it.each([
  [[], 'Searched all meetings'],
  [[folder], 'Searched Planning'],
  [[folder, meeting], 'Searched Planning and 1 other'],
  [[folder, meeting, { ...meeting, id: 'next' }], 'Searched Planning and 2 others'],
] as [ContextTarget[], string][])('labels the searched scope %j', (chips, expected) => {
  const html = renderToStaticMarkup(createElement(AnswerScope, { chips }))
  expect(html.replace(/<[^>]*>/g, '')).toBe(expected)
  if (chips.length > 1) {
    expect(html).toContain('title="Planning\nRelease review')
    expect(html).toContain('class="ask-scope-name">Planning</span>')
    expect(html).toContain('class="ask-scope-others"')
  }
})

it.each([false, true])('shows saved scopes on finished answers, without inventing legacy scope or showing it mid-stream (panel: %s)', panel => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) })
  const initial: ConversationView = { id: 'scope', title: '', draft: '', chips: [folder], draftChips: [], firstChips: [], waitsForMeeting: false, waitsForModel: false,
    turns: [{ id: 1, question: 'What changed?', answer: 'The release is ready.', status: 'done', sources: [] }] }
  const render = (scope: ContextTarget[] | undefined, status: ConversationTurn['status']) => {
    initial.turns[0] = { ...initial.turns[0], scope, status }
    return renderToStaticMarkup(createElement(AskConversation, { id: initial.id, initial, panel, onSelect() {}, onDeleted() {}, onSource() {} }))
  }
  expect(render(undefined, 'done')).not.toContain('chat-answer-scope')
  expect(render([], 'done')).toContain('Searched all meetings')
  expect(render([folder], 'done')).toContain('chat-answer-scope')
  expect(render([folder], 'answering')).not.toContain('chat-answer-scope')
})
