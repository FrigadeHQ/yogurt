import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const css = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')

it('keeps the hover fill for open popups and pressed buttons while an expanded sidebar rests', () => {
  const rule = css.match(/\.ghost-btn:hover:not\(:disabled\)[^{]+\{[^}]+\}/)?.[0]
  expect(rule).toContain('background:var(--control-hover)')
  expect(rule).toContain('.ghost-btn:is(:where([aria-haspopup])[aria-expanded=true],[aria-pressed=true]):not(:disabled)')
  expect(rule).not.toContain('.ghost-btn:is([aria-expanded=true]')
})

it('keeps the sidebar toggle exposed as an expanded disclosure without a popup state', () => {
  const workspace = readFileSync(new URL('../src/renderer/src/components/Workspace.tsx', import.meta.url), 'utf8')
  const toggle = workspace.match(/<button className="ghost-btn workspace-icon workspace-sidebar-toggle[^]*?<\/button>/)?.[0]
  expect(toggle).toContain('aria-expanded={!collapsed}')
  expect(toggle).not.toContain('aria-haspopup')
  expect(css).toMatch(/\.ghost-btn\s*\{[^}]*background:transparent/)
})

it('replaces the transcript find trigger with the search field while find is open', () => {
  const find = readFileSync(new URL('../src/renderer/src/components/TranscriptFind.tsx', import.meta.url), 'utf8')
  const trigger = find.match(/<button [^]*?className="ghost-btn transcript-find-trigger"[^]*?<\/button>/)?.[0]
  expect(trigger).toContain('aria-expanded={open}')
  expect(trigger).toContain('aria-hidden={open}')
  expect(trigger).toContain('tabIndex={open ? -1 : 0}')
  expect(css).toMatch(/\.transcript-find\[data-open=true\] \.transcript-find-trigger\s*\{[^}]*opacity:0;pointer-events:none/)
  expect(css).toMatch(/\.transcript-find\[data-open=true\] \.transcript-find-clip\s*\{[^}]*opacity:1;pointer-events:auto/)
})
