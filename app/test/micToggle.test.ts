import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { MicToggle } from '../src/renderer/src/components/MicToggle'
import type { MicState } from '../src/shared/types'

it('sets the native disabled attribute while paused, switching, or awaiting a confirmed mic state', () => {
  const button = (state: MicState, paused = false) =>
    renderToStaticMarkup(createElement(MicToggle, { id: 'meeting', state, paused }))
  for (const state of ['on', 'off', 'still-off'] as const) {
    expect(button(state)).not.toContain(' disabled=""')
    expect(button(state, true)).toContain(' disabled=""')
  }
  for (const state of ['muting', 'unmuting', 'restoring-off', 'unconfirmed'] as const) {
    expect(button(state)).toContain(' disabled=""')
  }
})

it('keeps the last confirmed icon and pressed state on both buttons until the reply', () => {
  for (const pill of [true, false]) {
    const markup = (state: MicState) => renderToStaticMarkup(createElement(MicToggle, { id: 'meeting', state, pill }))
    const icon = (state: MicState) => markup(state).match(/<svg.*?<[/]svg>/)?.[0]
    for (const [settled, pending, pressed] of [['on', 'muting', false], ['off', 'unmuting', true], ['off', 'restoring-off', true]] as const) {
      expect(icon(pending)).toBeTruthy()
      expect(icon(pending)).toEqual(icon(settled))
      expect(markup(pending)).toContain(`aria-pressed="${pressed}"`)
      expect(markup(pending)).toContain('aria-busy="true"')
    }
    expect(icon('on')).not.toBe(icon('off'))
  }
})
