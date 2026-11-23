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
  for (const state of ['muting', 'unmuting', 'unconfirmed'] as const) {
    expect(button(state)).toContain(' disabled=""')
  }
})
