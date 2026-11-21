import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { CalendarDays, CircleAlert, Ellipsis, Info, List, Moon, Palette, Sun, Target, TriangleAlert, Video } from '../src/renderer/src/components/Icons'

it('paints every dot interior even when a display magnifies the icon', () => {
  const glyphs = { Ellipsis: [Ellipsis, 3], List: [List, 3], CalendarDays: [CalendarDays, 5],
    CircleAlert: [CircleAlert, 1], TriangleAlert: [TriangleAlert, 1], Info: [Info, 1],
    Palette: [Palette, 6], Sun: [Sun, 8], Moon: [Moon, 2], Video: [Video, 1] } as const
  for (const [name, [Icon, count]] of Object.entries(glyphs)) {
    const html = renderToStaticMarkup(createElement(Icon))
    const discs = [...html.matchAll(/<circle\b[^>]*>/g)].map(([circle]) => circle)
      .filter(circle => Number(circle.match(/\br="([^"]+)"/)?.[1]) <= 3)
    expect(discs, name).toHaveLength(count)
    for (const disc of discs) {
      expect(disc, name).toContain('fill="currentColor"')
      expect(disc, name).toContain('stroke="none"')
    }
  }
})

it('keeps the three rings of the Goals target open', () => {
  const html = renderToStaticMarkup(createElement(Target))
  const paths = [...html.matchAll(/<path d="([^"]+)"/g)].map(([, d]) => d)
  expect(paths).toHaveLength(3)
  expect(paths.every(d => d.endsWith('Z'))).toBe(true)
  expect(html).not.toContain('fill="currentColor"')
})
