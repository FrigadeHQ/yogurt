import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { Event } from '../src/renderer/src/components/Agenda'
import type { AgendaEvent, MeetingCard } from '../src/shared/types'

const event: AgendaEvent = { id: 'event', title: 'Planning', start: 100, end: 200, attendees: [], url: null }
const saved: AgendaEvent = { ...event, note: { id: 'note', state: 'done' } }
const recording: MeetingCard = { id: 'note', title: 'Planning', state: 'recording', startedAt: 100, endedAt: null, attendees: [], folders: [], preview: '', eventId: event.id, app: null, language: null, titleSource: 'calendar' }
const render = (props: Partial<Parameters<typeof Event>[0]> = {}) => renderToStaticMarkup(createElement(Event, {
  event, me: '', now: 150, near: true, initial: false, selected: false, onInspect() {}, async onStart() {}, ...props,
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
  expect(html).toContain('aria-label="Has notes" title="Has notes"')
  expect(html).toContain('lucide-file-text')
  expect(html).toContain('width="13" height="13"')
  expect(html.indexOf('aria-label="Has notes"')).toBeGreaterThan(html.indexOf('</h3>'))
  expect(html).not.toContain('agenda-recording-levels')
  expect(css).toMatch(/\.agenda-marker \{[^}]*color:var\(--muted\)/)
})

it('replaces the icon with the real meter when recording starts or resumes, including after the event ends', () => {
  for (const now of [150, 200]) for (const row of [event, saved]) {
    for (const active of [recording, undefined, recording]) {
      const html = render({ event: row, now, recording: active })
      if (active) {
        expect(html).toContain('aria-label="Recording" title="Recording"')
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
  expect(html).toContain('aria-label="Paused" title="Paused"')
  expect(html).toContain('agenda-recording-levels')
  expect(html).not.toContain('lucide-file-text')
  expect(html).not.toContain('>Paused<')
  const loading = render({ loading: true, event: saved, recording })
  expect(loading).toContain('agenda-skeleton')
  expect(loading).not.toContain('agenda-marker')
  expect(loading).not.toContain('agenda-recording-levels')
})

it('keeps the live action, upcoming countdown and even title spacing', () => {
  expect(render()).toContain('Take notes')
  expect(render({ now: 99 })).toContain('Starts in 1 min')
  expect(render()).not.toContain('agenda-live')
  expect(css).toMatch(/\.agenda-heading \{[^}]*min-height:20px/)
  expect(css).toMatch(/\.agenda-time \{[^}]*padding-top:0;/)
})
