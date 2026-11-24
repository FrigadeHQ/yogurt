import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { Onboarding } from '../src/renderer/src/screens/Onboarding'

it('shows a plain notification on the recording reminders step', () => {
  const html = renderToStaticMarkup(createElement(Onboarding, {
    state: { phase: 'ready', fraction: 1 },
    plan: { intro: false, steps: [{ kind: 'notifications', status: 'unknown' }] },
    onDone: () => {},
  }))

  expect(html).toContain('data-testid="notice-art"')
  expect(html).toContain('Take notes?')
  expect(html).toContain('Start recording')
  expect(html).not.toContain('ob-prompt-countdown')
})
