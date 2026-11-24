import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const css = ['styles.css', 'workspace.css'].map(file =>
  readFileSync(new URL(`../src/renderer/src/${file}`, import.meta.url), 'utf8')).join('\n')

it('uses one fixed toast stack across workspace routes, panel widths, sidebar states and reduced motion', () => {
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]*\.app-toast-viewport[^{}]*)\{([^{}]*)\}/g)]
  expect(rules.map(rule => rule[1].trim())).toEqual(['.app-toast-viewport'])
  expect(rules[0][2]).toMatch(/position:\s*fixed;/)
  expect(rules[0][2]).toContain('bottom:max(20px,anchor(--note-footer top,0px) + 12px,anchor(--ask-composer top,0px) + 12px)')
  expect(rules[0][2]).toMatch(/inset-inline-end:\s*20px;/)
  expect(rules[0][2]).not.toMatch(/(?:translate|transform):/)
})

it('takes its position from the footer and docked composer without reserving space in the page', () => {
  expect(css).toMatch(/\.note-footer\s*\{[^}]*anchor-name:--note-footer;/)
  expect(css).toMatch(/\.ask-conversation:not\(\.ask-landing\) \.ask-composer\s*\{[^}]*anchor-name:--ask-composer;/)
  expect(css).not.toContain('--toast-clearance')
})
