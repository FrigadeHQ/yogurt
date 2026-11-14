import { afterEach, expect, it, vi } from 'vitest'
import { createElement, useEffect, type ChangeEvent, type ComponentProps } from 'react'
import { jsxDEV } from 'react/jsx-dev-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import { AskConversation } from '../src/renderer/src/components/AskConversation'
import type { ConversationTurn, ConversationView } from '../src/shared/types'

vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useEffect: vi.fn() }))
vi.mock('react/jsx-dev-runtime', async original => {
  const runtime = await original<typeof import('react/jsx-dev-runtime')>()
  return { ...runtime, jsxDEV: vi.fn(runtime.jsxDEV) }
})
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

it('keeps both composers busy through thinking and streaming, then releases on every terminal state', () => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) })
  const cases: [ConversationTurn['status'], string, boolean][] = [
    ['waiting', '', true], ['answering', '', true], ['answering', 'The first words', true],
    ['done', 'The answer', false], ['stopped', 'Partial answer', false], ['failed', '', false],
  ]
  for (const panel of [false, true]) for (const [status, answer, busy] of cases) {
    const initial: ConversationView = { id: 'composer-test', title: '', chips: [], draft: 'A follow-up', draftChips: [], firstChips: [],
      turns: [{ id: 1, question: 'What was decided?', status, answer, sources: [] }], waitsForMeeting: false, waitsForModel: false }
    const html = renderToStaticMarkup(createElement(AskConversation, { id: initial.id, initial, panel, onSelect() {}, onDeleted() {}, onSource() {} }))
    const form = html.match(/<form class="ask-box"[^>]*>/)?.[0]
    expect(form).toBeTruthy()
    expect(form!.includes('data-busy="true"')).toBe(busy)
    expect(form).not.toContain('data-thinking')
    expect(html).toContain('class="ask-border" aria-hidden="true"')
    expect(html).toContain('A follow-up')
  }
})


it('renders the panel input editable and autofocusable while its conversation is still loading', () => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) })
  const html = renderToStaticMarkup(createElement(AskConversation, { id: '', pendingDraftKey: 'meeting/cold-open', panel: true, onSelect() {}, onDeleted() {}, onSource() {} }))
  const input = html.match(/<textarea[^>]*data-testid="chat-input"[^>]*>/)?.[0]
  expect(input).toBeTruthy()
  expect(input).toContain('autofocus=""')
  expect(input).not.toContain('disabled')
  expect(input).not.toContain('readOnly')
  expect(html).toMatch(/data-testid="chat-send"[^>]*disabled=""/)
})

it('retains typing across pending-ID handoff and failed persistence without carrying it into a new conversation', async () => {
  const draft = vi.fn().mockRejectedValue(new Error('write failed'))
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }), yogurt: {
    conversations: { draft, get: vi.fn().mockResolvedValue({ draft: 'Older saved draft' }), onChange: () => () => {} },
    meetings: { onChange: () => () => {} }, folders: { onChange: () => () => {} },
  } })
  const render = (id: string) => {
    renderToStaticMarkup(createElement(AskConversation, { id, pendingDraftKey: 'meeting/pending-draft', panel: true, onSelect() {}, onDeleted() {}, onSource() {} }))
    return vi.mocked(jsxDEV).mock.calls.filter(([type]) => type === 'textarea').at(-1)![1] as ComponentProps<'textarea'>
  }
  const pending = render('')
  pending.onChange!({ target: { value: 'Keep these first keystrokes', selectionStart: 26 } } as ChangeEvent<HTMLTextAreaElement>)
  expect(draft).not.toHaveBeenCalled()
  expect(render('').value).toBe('Keep these first keystrokes')
  expect(render('resolved-draft').value).toBe('Keep these first keystrokes')
  const load = vi.mocked(useEffect).mock.calls.filter(([, deps]) => deps?.length === 1 && deps[0] === 'resolved-draft').at(-1)![0]
  const cleanup = load()
  expect(draft).toHaveBeenCalledWith('resolved-draft', 'Keep these first keystrokes')
  await Promise.resolve()
  await Promise.resolve()
  expect(render('resolved-draft').value).toBe('Keep these first keystrokes')
  expect(render('new-conversation').value).toBe('')
  if (typeof cleanup === 'function') cleanup()
})
