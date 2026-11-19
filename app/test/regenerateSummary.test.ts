import { createElement, useLayoutEffect, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import { RegenerateForm } from '../src/renderer/src/components/RegenerateForm'
import { LOCALES, setLanguage, t } from '../src/shared/i18n'
import { REWRITE_NOTE_MAX } from '../src/shared/rewriteNote'

const state = vi.hoisted(() => ({ note: '', setNote: vi.fn(), withTranscript: false, setWithTranscript: vi.fn() }))
// the note is the string state, "Edit using the transcript too" the boolean one
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: (init: unknown) => typeof init === 'boolean' ? [state.withTranscript, state.setWithTranscript] : [state.note, state.setNote], useLayoutEffect: vi.fn() }))
afterEach(() => { state.note = ''; state.withTranscript = false; vi.clearAllMocks(); setLanguage('en') })
const props = { hasSummary: true, active: true, edited: false, disabled: false, hasTranscript: false, onClose() {}, onSubmit() {}, onEdit() {} }

function form(edited = false, disabled = false, hasTranscript = false) {
  const onSubmit = vi.fn(), onClose = vi.fn(), onEdit = vi.fn()
  const tree = RegenerateForm({ hasSummary: true, active: true, edited, disabled, hasTranscript, onSubmit, onClose, onEdit })
  const find = (node: any, type: string, testId?: string): ReactElement<any> | undefined => {
    if (!node || typeof node !== 'object') return
    if (node.type === type && (!testId || node.props['data-testid'] === testId)) return node
    for (const child of [node.props?.children].flat()) { const found = find(child, type, testId); if (found) return found }
  }
  return { tree, onSubmit, onClose, onEdit, input: find(tree, 'input', 'note-regenerate-input')!, close: find(tree, 'button')!, edit: find(tree, 'button', 'note-edit-confirm')!, transcript: find(tree, 'input', 'note-edit-transcript') }
}

it('submits an optional trimmed note, closes without submitting, and respects disabled generation', () => {
  for (const note of ['', '  ', '  shorter in Spanish  ']) {
    state.note = note
    const f = form(), preventDefault = vi.fn()
    f.tree.props.onSubmit({ preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(f.onSubmit).toHaveBeenCalledWith(note.trim())
    f.close.props.onClick()
    expect(f.onClose).toHaveBeenCalledOnce()
    expect(f.onSubmit).toHaveBeenCalledOnce()
  }
  const disabled = form(false, true)
  disabled.tree.props.onSubmit({ preventDefault() {} })
  expect(disabled.onSubmit).not.toHaveBeenCalled()
})

it('limits a single-line field and does not submit while an input method is composing', () => {
  const f = form(), preventDefault = vi.fn()
  expect(f.input.props.maxLength).toBe(REWRITE_NOTE_MAX)
  expect(f.input.props.autoFocus).toBe(true)
  f.input.props.onChange({ target: { value: 'shorter' } })
  expect(state.setNote).toHaveBeenCalledWith('shorter')
  f.input.props.onKeyDown({ key: 'Enter', nativeEvent: { isComposing: true }, preventDefault })
  expect(preventDefault).toHaveBeenCalledOnce()
})

it('shows the edit warning only when needed and translates every new label', () => {
  for (const locale of LOCALES) {
    setLanguage(locale.id)
    for (const key of ['Note for the summary', 'Add a note, like shorter or in Spanish', 'Regenerate', 'Edit or regenerate summary', 'Edit summary', 'Edit using the transcript too', 'Slower, and depends on the notes model: a long meeting may not fit it and is then read in parts.', 'Regenerate replaces your edits to the summary. Edit keeps them.', 'Summary edited', "The summary changed since, so it wasn't undone."]) {
      if (locale.id !== 'en') expect(t(key), locale.id).not.toBe(key)
    }
    const render = (edited: boolean) => renderToStaticMarkup(createElement(RegenerateForm, { ...props, edited }))
    expect(render(true)).toContain('data-testid="note-confirm"')
    expect(render(false)).not.toContain('data-testid="note-confirm"')
    expect(render(true)).not.toContain('type="checkbox"')
  }
})

it('clears a note on reopening while preserving its text during the exit', () => {
  RegenerateForm({ ...props, active: false })
  vi.mocked(useLayoutEffect).mock.calls.at(-1)![0]()
  expect(state.setNote).not.toHaveBeenCalled()
  RegenerateForm(props)
  vi.mocked(useLayoutEffect).mock.calls.at(-1)![0]()
  expect(state.setNote).toHaveBeenCalledWith('')
  expect(state.setWithTranscript).toHaveBeenCalledWith(false)
})

it('labels the optional-note form for first generation when no summary exists', () => {
  const html = renderToStaticMarkup(createElement(RegenerateForm, { ...props, hasSummary: false, hasTranscript: true }))
  expect(html).toContain('Generate summary')
  expect(html).not.toContain('Regenerate summary')
  // nothing to edit yet
  expect(html).not.toContain('note-edit-confirm')
  expect(html).not.toContain('type="checkbox"')
})

it('edits only with a note, reading the transcript only when there is one and it is ticked', () => {
  state.note = ''
  expect(form().edit.props.disabled).toBe(true)
  state.note = '  add the budget  '
  const f = form()
  expect(f.edit.props.disabled).toBe(false)
  // Edit is not the form's submit: Return still regenerates, as before
  expect(f.edit.props.type).toBe('button')
  f.edit.props.onClick()
  expect(f.onEdit).toHaveBeenCalledWith('add the budget', false)
  expect(f.onSubmit).not.toHaveBeenCalled()
  // no transcript lines: no tick box, and a stale tick reads nothing
  expect(f.transcript).toBeUndefined()
  state.withTranscript = true
  const stale = form()
  stale.edit.props.onClick()
  expect(stale.onEdit).toHaveBeenCalledWith('add the budget', false)
  const read = form(false, false, true)
  read.transcript!.props.onChange({ target: { checked: false } })
  expect(state.setWithTranscript).toHaveBeenCalledWith(false)
  read.edit.props.onClick()
  expect(read.onEdit).toHaveBeenCalledWith('add the budget', true)
  const disabled = form(false, true, true)
  expect(disabled.edit.props.disabled).toBe(true)
  disabled.edit.props.onClick()
  expect(disabled.onEdit).not.toHaveBeenCalled()
})

it('warns that reading the transcript is slower only once it is ticked, and that only Regenerate replaces edits', () => {
  const render = (o: Partial<typeof props>) => renderToStaticMarkup(createElement(RegenerateForm, { ...props, ...o }))
  expect(render({ hasTranscript: true })).toContain('Edit using the transcript too')
  expect(render({ hasTranscript: true })).not.toContain('note-edit-transcript-warning')
  state.withTranscript = true
  expect(render({ hasTranscript: true })).toContain('a long meeting may not fit it')
  expect(render({ hasTranscript: false })).not.toContain('note-edit-transcript-warning')
  expect(render({ edited: true })).toContain('Regenerate replaces your edits to the summary. Edit keeps them.')
})
