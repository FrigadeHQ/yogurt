import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const css = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')

it('allows the edit-loss warning to wrap within the dialog', () => {
  const warning = css.match(/\.summary-regenerate-warning\s*\{([^}]+)\}/)![1]
  expect(warning).not.toMatch(/white-space:\s*nowrap/)
})
