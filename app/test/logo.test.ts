import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { MARK, MARK_FIT, WORD } from '../src/shared/logo'
import { Logo, Wordmark } from '../src/renderer/src/components/Logo'

const svg = (name: string) => readFileSync(join(import.meta.dirname, '../build', name), 'utf8')
const paths = (text: string) => [...text.matchAll(/ d="([^"]+)"/g)].map(m => m[1])

it('uses the approved Glug and Close outlines in the renderer and packaging', () => {
  const hash = (path: string) => createHash('sha256').update(path).digest('hex')
  expect(hash(MARK)).toBe('19159fb8ef9c8643e694ad107584ead5ec7d5231360dedbb18823915acf37b2e')
  expect(hash(WORD)).toBe('9243304490ba2a40ad48dcbfb207a55c2c6ace84839ce56e43474b8d563070a1')
  expect(paths(svg('logo.svg'))).toEqual([MARK])
  expect(paths(svg('wordmark.svg'))).toEqual([WORD])
  expect(paths(svg('icon.svg'))).toEqual([MARK])
  const lockup = renderToStaticMarkup(createElement(Wordmark, { height: 22 }))
  expect(paths(lockup)).toEqual([MARK, WORD])
  expect(lockup).toContain('viewBox="0 0 786.465752994 177.905"')
  expect(lockup).toContain('translate(-24.470906765 -0.0254777349527) scale(0.470594360865)')
  expect(lockup).toContain('translate(209.465752994 0.905) scale(1)')
})

it('keeps the small mark in its square and fills 58% of the Mac tile', () => {
  const corner = renderToStaticMarkup(createElement(Logo, { size: 18, className: 'corner-brand' }))
  expect(paths(corner)).toEqual([MARK])
  expect(corner).toContain('width="18" height="18"')
  expect(corner).toContain('fill="currentColor"')
  expect(corner).toContain(MARK_FIT)
  const icon = svg('icon.svg')
  expect(icon).toContain(MARK_FIT)
  const transform = icon.match(/<g transform="translate\(([^ ]+) ([^)]+)\) scale\(([^)]+)\)" fill="#fff"/)!
  const [, x, y, scale] = transform.map(Number)
  const [, dx, dy, fit] = MARK_FIT.match(/translate\(([^ ]+) ([^)]+)\) scale\(([^)]+)\)/)!.map(Number)
  expect(363 * fit * scale / 236).toBeCloseTo(.58, 6)
  expect(x + (dx + 233.5 * fit) * scale).toBeCloseTo(128, 0)
  expect(y + (dy + 162.5614 * fit) * scale).toBeCloseTo(128, 0)
})
