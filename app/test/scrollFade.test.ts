import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('uses the same fade for notes and transcript with no vertical space outside the note scroll viewport', () => {
  const read = (path: string) => readFileSync(new URL(`../src/renderer/src/${path}`, import.meta.url), 'utf8')
  const css = read('workspace.css')
  const frame = css.match(/^\.note-reading-frame \{([^}]+)\}/m)![1]
  expect(frame).toContain('margin:0 calc(')
  expect(frame).toContain('padding:0 2px')
  expect(css).toContain('.note-reading-clip { height:100%;overflow:hidden;border-radius:10px; }')
  expect(css).toContain('.main-window .note-reading-clip>.note-notes-pane { height:100%;')
  // Both panes use the approved shared default: moving the viewport must not change Transcript's fade.
  expect(read('components/NoteReadingPane.tsx')).toContain('<ScrollFade enabled={active}><section')
  expect(read('components/Transcript.tsx')).toContain('<ScrollFade enabled={active && loaded}><ol')
  expect(read('components/ScrollFade.tsx')).toContain('size = 20')
})

it('keeps note text, generation rim and footer controls at their existing insets', () => {
  const css = readFileSync(new URL('../src/renderer/src/workspace.css', import.meta.url), 'utf8')
  // Moving 8px margin + 2px padding inside the scroller keeps the original 22px/40px text offsets.
  expect(css).toContain('.note-reading-frame .note-notes-body { max-width:none;padding-block:22px 40px;padding-inline:12px 8px; }')
  expect(css).toContain('.note-summary-rim { inset:8px 0;')
  expect(css).toContain('.note-reading-frame::before { inset:8px 0; }')
  expect(css).toMatch(/\.note-summary-status \{[^}]*bottom:18px;/)
  expect(css).toMatch(/\.note-latest \{[^}]*bottom:18px;/)
})
