import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const css = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')

it('keeps small floating labels legible even over the opposite background in each theme', () => {
  const palettes = [...css.matchAll(/:root:not\(\.widget\)\s*\{([^}]+)\}/g)]
  const tints = [...css.matchAll(/--floating-tint:\s*([\d.]+)%/g)].map(match => Number(match[1]) / 100)
  expect(palettes).toHaveLength(2)
  expect(tints).toHaveLength(2)
  const luminance = (rgb: number[]) => {
    const [r, g, b] = rgb.map(n => n / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4)
    return .2126 * r + .7152 * g + .0722 * b
  }
  for (const [i, [, palette]] of palettes.entries()) {
    const rgb = (token: string) => palette.match(new RegExp('--' + token + ':\\s*#([a-f0-9]{6});', 'i'))![1]
      .match(/../g)!.map(channel => parseInt(channel, 16))
    const backdrop = i === 0 ? 0 : 255
    const fill = rgb('float').map(channel => channel * tints[i] + backdrop * (1 - tints[i]))
    const [lo, hi] = [luminance(rgb('muted')), luminance(fill)].sort((a, b) => a - b)
    expect((hi + .05) / (lo + .05)).toBeGreaterThanOrEqual(4.5)
  }
})
