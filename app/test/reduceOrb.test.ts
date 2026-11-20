import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const css = readFileSync(new URL('../src/renderer/src/workspace.css', import.meta.url), 'utf8')

it('stops decorative orb rotation and countdown travel under Reduce Motion', () => {
  const reduced = css.lastIndexOf('@media (prefers-reduced-motion:reduce) { .orb-material::before')
  const full = css.indexOf('animation:orb-turn')
  expect(reduced).toBeGreaterThan(full)
  const prompt = readFileSync(new URL('../src/renderer/src/setup.css', import.meta.url), 'utf8')
  expect(prompt).toMatch(/prefers-reduced-motion:\s*reduce\)\s*\{\s*\.call-prompt-countdown\s*\{[^}]*(?:animation|display):\s*none/)
})
