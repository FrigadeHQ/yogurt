import { expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { RecordingSetting } from '../src/renderer/src/screens/Settings'

const row = (reveal = false, disabled = false) => renderToStaticMarkup(createElement(RecordingSetting, { on: true, reveal, disabled, onChange: async () => {} }))

it('highlights a revealed recording setting only when it is ready', () => {
  expect(row(true)).toContain('class="settings-row settings-reveal"')
  expect(row()).not.toContain('settings-reveal')
  expect(row(true, true)).not.toContain('settings-reveal')
})

it('names audio recordings in the visible label and switch label', () => {
  const html = row()
  expect(html).toContain('>Keep audio recordings after meetings</p>')
  expect(html).toContain('aria-label="Keep audio recordings after meetings"')
})
