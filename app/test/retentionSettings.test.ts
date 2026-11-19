import { expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { RetentionSettings } from '../src/renderer/src/components/RetentionSettings'
import type { Retention } from '../src/shared/retention'

const page = (retention?: Retention, reveal = false) => renderToStaticMarkup(createElement(RetentionSettings, { retention, reveal }))
const row = (html: string, kind: string) => html.slice(html.indexOf(`data-testid="retention-${kind}"`), html.indexOf('</select>', html.indexOf(`data-testid="retention-${kind}"`)) + 200)

it('shows each saved rule, and a days field only for a number that is none of the choices', () => {
  const html = page({ audio: null, transcript: 45, meeting: 365 })
  expect(row(html, 'audio')).toMatch(/<option value="never" selected="">Never<\/option>/)
  expect(row(html, 'transcript')).toMatch(/<option value="other" selected="">Other<\/option>/)
  expect(html).toContain('data-testid="retention-transcript-days"')
  expect(html).toMatch(/data-testid="retention-transcript-days"[^>]*value="45"/)
  expect(row(html, 'meeting')).toMatch(/<option value="365" selected="">After 1 year<\/option>/)
  expect(html).not.toContain('retention-audio-days')
  expect(html).not.toContain('retention-meeting-days')
})

it('offers once the summary is saved for audio only, and waits for the saved rules before anything can change', () => {
  const html = page({ audio: 0, transcript: null, meeting: null })
  expect(row(html, 'audio')).toContain('<option value="0" selected="">Once the summary is saved</option>')
  expect(row(html, 'transcript')).not.toContain('Once the summary is saved')
  expect(page()).toMatch(/<select[^>]*disabled=""/)
})

it('highlights the audio row when revealed, once ready', () => {
  expect(row(page({ audio: null, transcript: null, meeting: null }, true), 'audio')).toContain('settings-row settings-reveal')
  expect(page(undefined, true)).not.toContain('settings-reveal')
})
