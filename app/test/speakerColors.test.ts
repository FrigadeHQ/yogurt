import { expect, it } from 'vitest'
import { SPEAKER_COLORS, speakerColor, speakerOrder } from '../src/shared/speakerColors'

it('assigns named speakers in first appearance order, keeping repeats and unknown voices neutral', () => {
  const order = speakerOrder([], [null, '', 'Ada', 'Bo', 'Ada', 'Cy', 'Dee', 'Eli', 'Fay', 'Gia', 'Hal'])
  expect(order).toEqual(['Ada', 'Bo', 'Cy', 'Dee', 'Eli', 'Fay', 'Gia', 'Hal'])
  expect(order.map(name => speakerColor('them', name, order))).toEqual([0, 1, 2, 3, 4, 5, 6, 0])
  expect(speakerColor('me', 'Ada', order)).toBeUndefined()
  expect(speakerColor('them', null, order)).toBeUndefined()
  expect(speakerColor('them', 'Unknown', order)).toBeUndefined()
})

it('keeps assignments after reload, hidden lines and later attribution of an earlier speaker', () => {
  const saved = JSON.stringify(speakerOrder([], ['Ada', 'Bo']))
  const reloaded = speakerOrder(JSON.parse(saved), ['Cy', 'Ada', 'Bo'])
  expect(reloaded).toEqual(['Ada', 'Bo', 'Cy'])
  expect(speakerColor('them', 'Bo', reloaded)).toBe(1)
})

it('uses the seven folder inks on the note and always-dark preview', async () => {
  const { readFileSync } = await import('node:fs')
  const css = readFileSync(new URL('../src/renderer/src/workspace.css', import.meta.url), 'utf8')
  expect(SPEAKER_COLORS).toEqual(['violet', 'blue', 'teal', 'green', 'amber', 'orange', 'rose'])
  const inks = [...css.matchAll(/\[data-folder-color=(\w+)\] \{ --folder-ink:light-dark\((#[\dA-F]{6}),(#[\dA-F]{6})\); \}/g)]
  expect(css).toContain('[data-folder-color=violet] { --folder-ink:var(--accent); }')
  expect(['violet', ...inks.map(m => m[1])]).toEqual(SPEAKER_COLORS)
  expect(css).toContain('.widget [data-folder-color] { color-scheme:dark; }')
  const theme = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')
  const accents = [...theme.matchAll(/--accent: (#[\dA-F]{6});/g)].map(match => match[1])
  expect(accents).toEqual(['#6F00FF', '#B780FF'])
  expect(theme).toContain(':is(.line-who,.widget-preview-speaker)[data-folder-color=violet] { background:var(--accent-ink)')
  const violetBackgrounds = [...theme.matchAll(/--accent-ink: (#[\dA-F]{6});/g)].map(match => match[1])
  expect(violetBackgrounds).toEqual(['#FFFFFF', '#1B1B1D'])
  const palettes = accents.map((accent, i) => [accent, ...inks.map(m => m[i + 2])])
  const luminance = (hex: string) => {
    const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4)
    return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722
  }
  expect(palettes).toHaveLength(2) // folder inks, shared by the two transcript surfaces
  for (const [i, palette] of palettes.entries()) {
    expect(palette).toHaveLength(7)
    // Names sit outside bubbles: note canvas and a lighter worst-case dark preview.
    for (const bg of i === 0 ? ['#FFFFFF'] : ['#242426', '#333335', '#39393C']) for (const [index, colour] of palette.entries()) {
      const background = index === 0 ? violetBackgrounds[i] : bg
      const a = luminance(colour), b = luminance(background)
      expect((Math.max(a, b) + .05) / (Math.min(a, b) + .05), `${colour} on ${background}`).toBeGreaterThanOrEqual(4.5)
    }
  }
})
