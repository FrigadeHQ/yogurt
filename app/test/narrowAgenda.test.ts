import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const css = readFileSync(new URL('../src/renderer/src/workspace.css', import.meta.url), 'utf8')

it('scrolls the agenda header and events together within the narrow grid row', () => {
  const narrow = css.slice(css.indexOf('@container (max-width:520px)')).split(/^}/m)[0]
  expect(narrow).toMatch(/\.native-agenda\s*\{[^}]*overflow-y:\s*auto/)
  expect(narrow).toMatch(/\.agenda-scroll\s*\{[^}]*overflow:\s*visible/)
})
