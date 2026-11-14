import { readFileSync } from 'node:fs'
import { createElement, useEffect, useLayoutEffect, useRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { Event } from '../src/renderer/src/components/Agenda'
import type { AgendaEvent, MeetingCard } from '../src/shared/types'
import { surfaceMotion } from '../src/renderer/src/motion'

vi.mock('react', async importOriginal => {
  const react = await importOriginal<typeof import('react')>()
  return { ...react, useEffect: vi.fn(), useLayoutEffect: vi.fn(), useRef: vi.fn(react.useRef) }
})

const event: AgendaEvent = { id: 'event', title: 'Planning', start: 100, end: 200, attendees: [{ name: 'Robin Vale', email: null }], url: null }
const saved: AgendaEvent = { ...event, note: { id: 'note', state: 'done' } }
const recording: MeetingCard = { id: 'note', title: 'Planning', state: 'recording', startedAt: 100, endedAt: null, attendees: [], folders: [], preview: '', eventId: event.id, app: null, language: null, titleSource: 'calendar' }
const render = (props: Partial<Parameters<typeof Event>[0]> = {}) => renderToStaticMarkup(createElement(Event, {
  event, me: '', now: 150, near: true, initial: false, selected: false, onInspect() {}, ...props,
}))
const css = readFileSync(new URL('../src/renderer/src/workspace.css', import.meta.url), 'utf8')

it('colors the rail only for live or recording rows, independent of saved notes', () => {
  const accentRules = css.split('\n').filter(line => line.includes('.agenda-event') && line.includes('border-inline-start-color:var(--accent)'))
  expect(accentRules).toEqual(['.agenda-event:is(.live,[data-recording=true]) .agenda-event-body { border-inline-start-color:var(--accent); }'])
  for (const row of [event, saved]) for (const [now, phase] of [[99, 'upcoming'], [100, 'live'], [199, 'live'], [200, 'past']] as const) {
    for (const active of [undefined, recording, { ...recording, eventId: 'another-event' }]) {
      const html = render({ event: row, now, recording: active })
      expect(html).toContain(`class="agenda-event ${phase}"`)
      expect(html).toContain(`data-recording="${active?.eventId === row.id}"`)
    }
  }
})

it('uses a muted note icon in the title slot only when notes exist', () => {
  expect(render()).not.toContain('agenda-marker')
  const html = render({ event: saved, now: 200 })
  expect(html).toContain('aria-label="Has notes"')
  expect(html).toContain('lucide-file-text')
  expect(html).toContain('width="13" height="13"')
  expect(html.indexOf('aria-label="Has notes"')).toBeGreaterThan(html.indexOf('</h3>'))
  expect(html).not.toContain('agenda-recording-levels')
  expect(css).toMatch(/\.agenda-marker \{[^}]*color:var\(--muted\)/)
  expect(css).toMatch(/\.agenda-marker \{[^}]*pointer-events:none/)
})

it('replaces the icon with the real meter when recording starts or resumes, including after the event ends', () => {
  for (const now of [150, 200]) for (const row of [event, saved]) {
    for (const active of [recording, undefined, recording]) {
      const html = render({ event: row, now, recording: active })
      if (active) {
        expect(html).toContain('aria-label="Recording"')
        expect(html).toContain('<canvas data-testid="agenda-recording-levels"')
        expect(html).not.toContain('lucide-file-text')
        expect(html).not.toContain('Has notes')
      } else if (row.note) {
        expect(html).toContain('aria-label="Has notes"')
        expect(html).not.toContain('agenda-recording-levels')
      }
      expect(html).not.toContain('agenda-live')
      expect(html).not.toContain('>Recording<')
      expect(html).not.toContain('In progress')
    }
  }
})

it('labels paused bars and keeps markers out of loading rows', () => {
  const html = render({ event: saved, recording: { ...recording, paused: true } })
  expect(html).toContain('aria-label="Paused"')
  expect(html).toContain('agenda-recording-levels')
  expect(html).not.toContain('lucide-file-text')
  expect(html).not.toContain('>Paused<')
  const loading = render({ loading: true, event: saved, recording })
  expect(loading).toContain('agenda-skeleton')
  expect(loading).not.toContain('agenda-marker')
  expect(loading).not.toContain('agenda-recording-levels')
})

it('removes the live row action and keeps the upcoming countdown and title spacing', () => {
  expect(render()).not.toContain('Take notes')
  expect(render({ now: 99 })).toContain('Starts in 1 min')
  expect(render()).not.toContain('agenda-live')
  expect(css).toMatch(/\.agenda-heading \{[^}]*min-height:17px/)
  expect(css).toMatch(/\.agenda-time \{[^}]*padding-top:0;/)
})

it('keeps past and upcoming rows compact, even when selected or saved', () => {
  for (const now of [99, 200]) for (const row of [event, saved]) {
    const html = render({ event: row, now, selected: true })
    expect(html).not.toContain('agenda-people')
    expect(html).not.toContain('Robin')
    expect(html).not.toContain('event-start')
  }
})

it('fades only ended, non-recording events, leaving row focus outlines at full strength', () => {
  for (const row of [event, saved]) for (const now of [99, 100, 199, 200, 201]) {
    for (const active of [undefined, recording, { ...recording, paused: true as const }, { ...recording, eventId: 'another-event' }]) {
      const html = render({ event: row, now, recording: active, selected: true })
      expect(html).toContain(`data-faded="${now >= event.end && active?.eventId !== event.id}"`)
    }
  }
  expect(render({ now: 201, loading: true })).toContain('data-faded="false"')
  expect(css.split('\n').filter(line => line.includes('[data-faded=true]'))).toEqual([
    '.agenda-event[data-faded=true] :is(.agenda-time,.agenda-title,.agenda-marker) { color:var(--ink);opacity:.65; }',
  ])
  expect(css).toContain(':is(.native-meeting-row,.ask-history-row,.agenda-event):is(:focus-visible,:has(:focus-visible)) { outline:2px solid var(--focus);outline-offset:-2px; }')
})

it('shows people on live and recording rows without a Take notes action', () => {
  for (const row of [event, { ...event, note: { id: 'note', state: 'prepared' as const } }]) {
    const html = render({ event: row })
    expect(html).toContain('class="agenda-people" title="Robin Vale">Robin</p>')
    expect(html).not.toContain('data-testid="event-start"')
    expect(html).not.toContain('Take notes')
    expect(html).not.toContain('workspace-button primary')
  }
  for (const now of [99, 150, 200]) {
    const html = render({ now, recording })
    expect(html).toContain('agenda-people')
    expect(html).not.toContain('event-start')
  }
  expect(render({ recording: { ...recording, eventId: 'another-event' } })).not.toContain('event-start')
  expect(render({ event: saved })).not.toContain('event-start')
  expect(render({ event: { ...event, attendees: [] } })).not.toContain('agenda-people')
  expect(css).toMatch(/\.agenda-event h3 \{[^}]*font-size:11px;line-height:17px;font-weight:400/)
  expect(css).toMatch(/\.agenda-event:is\(\.live,\[data-recording=true\]\) \.agenda-title \{ font-weight:600/)
})

it('resizes from the previous height, retargets interrupted growth and snaps with reduced motion', () => {
  vi.clearAllMocks()
  render()
  let height = 33
  let reduced = false
  const animation = { playState: 'running', cancel: vi.fn() }
  const animate = vi.fn(() => animation)
  const measure = vi.fn(() => ({ height }))
  vi.mocked(useRef).mock.results[0].value.current = { getBoundingClientRect: measure, animate }
  const resize = vi.mocked(useLayoutEffect).mock.calls[0][0]
  const cleanup = vi.mocked(useEffect).mock.calls[0][0]()
  vi.stubGlobal('window', { matchMedia: () => ({ matches: reduced }) })
  try {
    resize()
    expect(animate).not.toHaveBeenCalled()
    height = 78
    resize()
    expect(surfaceMotion.resizeMs).toBe(180)
    expect(animate).toHaveBeenLastCalledWith([{ height: '33px' }, { height: '78px' }], { duration: 180, easing: surfaceMotion.settleEase })
    measure.mockReturnValueOnce({ height: 50 })
    height = 52
    resize()
    expect(animation.cancel).toHaveBeenCalledOnce()
    expect(animate).toHaveBeenLastCalledWith([{ height: '50px' }, { height: '52px' }], { duration: 180, easing: surfaceMotion.settleEase })
    reduced = true
    height = 33
    resize()
    expect(animate).toHaveBeenCalledTimes(2)
    expect(animation.cancel).toHaveBeenCalledTimes(2)
    if (typeof cleanup === 'function') cleanup()
    expect(animation.cancel).toHaveBeenCalledTimes(3)
  } finally { vi.unstubAllGlobals() }
})
