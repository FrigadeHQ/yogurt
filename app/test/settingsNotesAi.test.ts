import { expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NotesAiSetting } from '../src/renderer/src/screens/Settings'

const row = (on: boolean, onChange = vi.fn()) =>
  renderToStaticMarkup(createElement(NotesAiSetting, { on, disabled: false, onChange }))

it('shows the notes-model description with the switch off in normal mode', () => {
  const html = row(false)
  expect(html).toContain('Notes &amp; AI')
  expect(html).toContain('Summaries and Ask use a notes model downloaded to this computer.')
  expect(html).toMatch(/role="switch"[^>]*aria-checked="false"/)
})

it('shows the transcription-only description with the switch on', () => {
  const html = row(true)
  expect(html).toContain('Transcription only. No notes model is downloaded')
  expect(html).toContain('Turning it off downloads the notes model.')
  expect(html).toMatch(/role="switch"[^>]*aria-checked="true"/)
})
