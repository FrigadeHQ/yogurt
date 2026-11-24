import { afterEach, expect, it, vi } from 'vitest'
import { createElement, useEffect, type ChangeEvent, type ComponentProps } from 'react'
import { jsxDEV } from 'react/jsx-dev-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import { AskRecordingWait, watchRecordingWait } from '../src/renderer/src/askAvailability'
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
    expect(html).not.toContain('ask-border')
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

it('keeps the landing input labeled without repeating its heading as a placeholder', () => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) })
  const initial: ConversationView = { id: 'landing-copy', title: '', chips: [], draft: '', draftChips: [], firstChips: null,
    turns: [], waitsForMeeting: false, waitsForModel: false }
  const html = renderToStaticMarkup(createElement(AskConversation, { id: initial.id, initial, home: true, onSelect() {}, onDeleted() {}, onSource() {} }))
  expect(html).toContain('class="ask-home-title">Ask about your meetings</h1>')
  const input = html.match(/<textarea[^>]*>/)?.[0]
  expect(input).toContain('aria-label="Ask about your meetings"')
  expect(input).not.toContain('placeholder=')
})

it('keeps the latest recording event when a slower initial read arrives', async () => {
  let snapshot!: (waiting: boolean) => void, publish!: (waiting: boolean) => void
  const update = vi.fn(), off = vi.fn()
  const stop = watchRecordingWait({
    onRecordingWait(cb) { publish = cb; return off },
    waitsForMeeting: () => new Promise(resolve => { snapshot = resolve }),
  }, update)
  publish(true)
  publish(false)
  snapshot(true)
  await Promise.resolve()
  expect(update.mock.calls).toEqual([[true], [false]])
  stop()
  expect(off).toHaveBeenCalledOnce()
})

it.each([true, false])('keeps a blocked field focusable and preserves the draft through recording stop (panel %s)', panel => {
  const ask = vi.fn(), draft = vi.fn()
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }), yogurt: { os: 'darwin', conversations: { ask, draft } } })
  const initial: ConversationView = { id: 'draft', title: '', chips: [], draft: 'Keep this question', draftChips: [], firstChips: null,
    turns: [], waitsForMeeting: true, waitsForModel: false }
  const ui = createElement(AskConversation, { id: initial.id, initial, panel, home: !panel, onSelect() {}, onDeleted() {}, onSource() {} })
  const locked = renderToStaticMarkup(createElement(AskRecordingWait.Provider, { value: true }, ui))
  const input = locked.match(/<textarea[^>]*>/)![0]
  expect(input).toContain('aria-disabled="true"')
  expect(input).toContain('aria-description="Available after recording"')
  expect(input).toContain('readOnly=""')
  expect(input).not.toContain(' disabled=')
  expect(locked).toMatch(/data-testid="chat(?:-page)?-send"[^>]*disabled=/)
  const form = vi.mocked(jsxDEV).mock.calls.filter(([type]) => type === 'form').at(-1)![1] as ComponentProps<'form'>
  form.onSubmit!({ preventDefault() {} } as Parameters<NonNullable<typeof form.onSubmit>>[0])
  expect(ask).not.toHaveBeenCalled()
  expect(draft).not.toHaveBeenCalled()
  const unlocked = renderToStaticMarkup(createElement(AskRecordingWait.Provider, { value: false }, ui))
  expect(unlocked).toContain('Keep this question')
  expect(unlocked.match(/<textarea[^>]*>/)![0]).not.toMatch(/aria-disabled|readOnly|aria-description/)
  expect(unlocked).not.toMatch(/data-testid="chat(?:-page)?-send"[^>]*disabled=/)
})

it.each([['darwin', true, true], ['darwin', false, false], ['win32', true, false], ['linux', true, false]] as const)(
  'uses the conversation wait while the first recording snapshot is pending (%s, wait %s)', (os, waitsForMeeting, locked) => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }), yogurt: { os } })
    const initial: ConversationView = { id: 'call', title: '', chips: [], draft: '', draftChips: [], firstChips: null,
      turns: [], waitsForMeeting, waitsForModel: false }
    const ui = createElement(AskConversation, { id: initial.id, initial, panel: true, recording: true, onSelect() {}, onDeleted() {}, onSource() {} })
    const input = renderToStaticMarkup(ui).match(/<textarea[^>]*>/)![0]
    expect(input.includes('aria-disabled="true"')).toBe(locked)
    expect(input.includes('readOnly=""')).toBe(locked)
  })
