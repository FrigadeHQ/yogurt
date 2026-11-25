import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { LevelBars } from '../src/renderer/src/components/LevelBars'
import { RecordingPill } from '../src/renderer/src/components/RecordingPill'

it('holds a single meter frame on the welcome illustration and uses the live meter on the recorder', () => {
  const render = (illustration: boolean, expanded = false) => renderToStaticMarkup(createElement(RecordingPill, { time: '0:24', illustration, expanded }))
  const sample = render(true)
  expect(sample).toMatch(/<svg data-testid="widget-wave"/)
  expect(sample.match(/<rect /g)).toHaveLength(5)
  expect(sample).not.toContain('non-scaling-stroke')
  expect(sample).not.toContain('data-testid="logo"')
  const live = renderToStaticMarkup(createElement(LevelBars, { height: 16, testId: 'widget-wave', className: 'text-[var(--pill-accent)]' }))
  expect(render(false)).toContain(live)
  expect(render(false)).not.toContain('data-testid="logo"')
  const expanded = render(false, true)
  expect(expanded).toContain('data-testid="logo"')
  expect(expanded).toContain(live)
  expect(live.match(/non-scaling-stroke/g)).toHaveLength(5)
})
