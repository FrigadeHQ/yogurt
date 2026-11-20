import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { ScreenArt } from '../src/renderer/src/components/OnboardingArt'

it.each(['mic', 'systemAudio'] as const)('illustrates only the %s channel', kind => {
  const html = renderToStaticMarkup(createElement(ScreenArt, { kind }))
  const lanes = Array.from(html.matchAll(/class="ob-lane" data-active="(\w+)" data-channel="(\w+)"/g), m => m.slice(1))
  expect(lanes).toEqual(['mic', 'systemAudio'].map(channel => [String(channel === kind), channel]))
  expect(html.match(/<i style=/g)).toHaveLength(10)
  expect(html).not.toMatch(/ob-lane-state|data-on=|lucide-check/)
})
