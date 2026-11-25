import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const css = ['styles.css', 'workspace.css'].map(file =>
  readFileSync(new URL(`../src/renderer/src/${file}`, import.meta.url), 'utf8')).join('\n')

it('anchors the fixed stack to the window or the bottom inline-start corner of docked Ask', () => {
  const normal = css.match(/^\.app-toast-viewport \{([^}]+)\}/m)![1]
  expect(normal).toContain('position:fixed;inset-inline-end:20px;')
  expect(normal).toContain('bottom:max(20px,12px + max(anchor(--note-footer top,0px),anchor(--ask-composer top,0px),anchor(--transcript-player top,0px)))')
  expect(css).toContain('.chat-panel[open]:not([aria-modal=true]) { anchor-name:--docked-ask; }')
  const beside = css.match(/\[data-beside-ask\] \.app-toast-viewport \{([^}]+)\}/)![1]
  expect(beside).toContain('inset-inline-end:calc(anchor(--docked-ask start) + 12px)')
  expect(beside).toContain('bottom:anchor(--docked-ask bottom)')
})

it('clears the footer, docked composer and visible player without reserving space in the page', () => {
  expect(css).toMatch(/\.note-footer\s*\{[^}]*anchor-name:--note-footer;/)
  expect(css).toMatch(/\.ask-conversation:not\(\.ask-landing\) \.ask-composer\s*\{[^}]*anchor-name:--ask-composer;/)
  expect(css).toMatch(/\.transcript-player-dock:not\(\[data-hidden=true\]\) > \.transcript-player\s*\{[^}]*anchor-name:--transcript-player;/)
  expect(css).not.toContain('--toast-clearance')
})
