import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const css = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')

it('keeps level-two note headings larger than level three', () => {
  const size = (level: number) => Number(css.match(new RegExp('\\.note-prose h' + level + ' \\{ font-size: ([\\d.]+)px'))![1])
  expect(size(1)).toBeGreaterThan(size(2))
  expect(size(2)).toBeGreaterThan(size(3))
})
