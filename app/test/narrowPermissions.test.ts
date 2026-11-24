import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const css = readFileSync(new URL('../src/renderer/src/setup.css', import.meta.url), 'utf8')

it('fits both permission choices at 320 CSS pixels', () => {
  const narrow = css.match(/@media\s*\(max-width:\s*(?:[3-5]\d\d|600)px\)\s*\{\s*\.ob\s*\{([^}]+)\}/)
  expect(narrow?.[1]).toMatch(/grid-template-columns:\s*(?:minmax\(0,\s*1fr\)|1fr)/)
  expect(css).toMatch(/\.ob-actions\s*\{[^}]*flex-wrap:\s*wrap/)
})
