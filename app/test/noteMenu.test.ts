import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import { NoteMenu, summaryAction } from '../src/renderer/src/components/NoteMenu'
import { LOCALES, setLanguage } from '../src/shared/i18n'

vi.mock('../src/renderer/src/motion', () => ({ usePopoverPresence: () => ({ value: 'keyboard', props: {} }) }))
afterEach(() => setLanguage('en'))
const available = { hasSummary: true, hasContent: false, recording: false, busy: false, downloading: false, trashed: false }

it('shows the correct action for existing summaries and source content, hiding empty notes and Trash', () => {
  expect(summaryAction(available)).toEqual({ label: 'Edit or regenerate summary', reason: undefined })
  expect(summaryAction({ ...available, hasSummary: false, hasContent: true })?.label).toBe('Generate summary')
  for (const recording of [true, false]) for (const busy of [true, false]) for (const downloading of [true, false]) {
    expect(summaryAction({ ...available, hasSummary: false, recording, busy, downloading })).toBeUndefined()
    expect(summaryAction({ ...available, hasContent: true, recording, busy, downloading, trashed: true })).toBeUndefined()
  }
})

it('explains disabled actions, prioritizing recording and model download over queued writing', () => {
  expect(summaryAction({ ...available, recording: true, busy: true, downloading: true })?.reason).toBe('Available after recording')
  expect(summaryAction({ ...available, busy: true, downloading: true })?.reason).toBe('Waiting for Yogurt AI to download')
  expect(summaryAction({ ...available, busy: true })?.reason).toBe('Writing the summary')
})

it('renders a focusable but unavailable menu item with a separate accessible description in every locale', () => {
  for (const locale of LOCALES) {
    setLanguage(locale.id)
    for (const wait of ['recording', 'busy', 'downloading'] as const) {
      const generation = summaryAction({ ...available, [wait]: true })!
      const html = renderToStaticMarkup(createElement(NoteMenu, {
        recording: wait === 'recording', generation, hasSummary: true, edited: false, rewriteOpen: false,
        setRewriteOpen() {}, onWriteAgain() {}, onRename() {}, onDelete() {}, hasTranscript: false, onEdit() {},
      }))
      const item = html.match(/<button[^>]*data-testid="note-write-again"[^>]*>/)![0]
      expect(item).toContain('role="menuitem"')
      expect(item).toContain('aria-disabled="true"')
      expect(item).toContain('aria-description=')
      expect(item).not.toMatch(/\sdisabled=/)
      expect(item).not.toContain('tabindex="-1"')
      if (locale.id !== 'en') expect(generation.reason).not.toMatch(/^(Available after recording|Writing the summary|Waiting for Yogurt AI to download)$/)
    }
  }
})
