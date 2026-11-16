// Transcript lab, switching the transcript between versions and back.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openStore } from '../src/main/store'
import { createLabStore } from '../src/main/lab/labStore'
import { windowsOf } from '../src/main/lab/windows'

function setup() {
  const store = openStore(join(mkdtempSync(join(tmpdir(), 'yogurt-lab-')), 'y.db'))
  const m = store.createMeeting({ title: 'Plan', startedAt: 1, endedAt: 2, eventId: null, app: null, attendees: [], state: 'done' })
  store.addSegments([
    { meetingId: m.id, track: 'me', startMs: 0, endMs: 3000, text: 'we ship the remote', speaker: 'me' },
    { meetingId: m.id, track: 'me', startMs: 3200, endMs: 6000, text: 'patrol on Monday uh', speaker: 'me' },
    { meetingId: m.id, track: 'me', startMs: 6100, endMs: 7000, text: 'uh', speaker: 'me' },
    { meetingId: m.id, track: 'them', startMs: 1000, endMs: 2000, text: 'echo of me', speaker: null, hidden: true },
    { meetingId: m.id, track: 'them', startMs: 8000, endMs: 9000, text: 'sounds good', speaker: 'Ann' },
  ])
  const lab = createLabStore(store)
  const ws = windowsOf(lab.liveSegments(m.id))
  lab.saveWindows(m.id, ws.map((w) => ({ ...w, language: 'en' })))
  lab.saveCombined(m.id, 'me:0', 'we ship the remote control on Monday', [])
  lab.saveCombined(m.id, 'them:8000', 'Sounds good.', [])
  lab.saveReadings(m.id, 'qwen', new Map([['me:0', { text: 'We ship the remote control on Monday.' }], ['them:8000', { text: 'Sounds good.' }]]))
  return { store, lab, id: m.id }
}
const shown = (store: ReturnType<typeof openStore>, id: string) => store.segments(id).map((s) => `${s.track}@${s.startMs}:${s.text}`)

describe('lab store', () => {
  it('shows the combined transcript over the live lines, keeping times, speakers and hidden echoes', () => {
    const { store, lab, id } = setup()
    lab.use(id, 'combined')
    expect(shown(store, id)).toEqual(['me@0:we ship the remote', 'me@3200:control on Monday', 'them@8000:Sounds good.'])
    expect(store.segments(id, { hidden: true }).find((s) => s.hidden)?.text).toBe('echo of me')
    expect(store.segments(id).find((s) => s.track === 'them')?.speaker).toBe('Ann')
    expect(lab.status(id).using).toBe('combined')
    // search follows the shown text
    expect(store.search('control', 5).length).toBe(1)
  })

  it('goes back to the live lines exactly, the removed one too, and on to a model', () => {
    const { store, lab, id } = setup()
    const before = shown(store, id)
    lab.use(id, 'combined')
    lab.use(id, 'live')
    expect(shown(store, id)).toEqual(before)
    lab.use(id, 'qwen')
    expect(shown(store, id)[1]).toBe('me@3200:control on Monday.')
    lab.use(id, 'live')
    expect(shown(store, id)).toEqual(before)
  })

  it('keeps switching after several lines of one stretch were removed and put back', () => {
    const { store, lab, id } = setup()
    const before = shown(store, id)
    lab.saveCombined(id, 'me:0', 'we ship the remote', [])
    for (let i = 0; i < 3; i++) {
      lab.use(id, 'combined')
      expect(shown(store, id).filter((l) => l.startsWith('me'))).toEqual(['me@0:we ship the remote'])
      lab.use(id, 'live')
      expect(shown(store, id)).toEqual(before)
    }
  })

  it("keeps the person's fix whatever version is shown, and over a new run", () => {
    const { store, lab, id } = setup()
    lab.fix(id, 'them:8000', 'Sounds great.')
    lab.use(id, 'combined')
    expect(shown(store, id).at(-1)).toBe('them@8000:Sounds great.')
    // a new run's stretches are built from the live text, and the fix stays with its stretch
    const ws = windowsOf(lab.liveSegments(id))
    expect(ws.find((w) => w.key === 'me:0')?.texts).toEqual(['we ship the remote', 'patrol on Monday uh', 'uh'])
    lab.saveWindows(id, ws.map((w) => ({ ...w, language: 'en' })))
    expect(lab.windows(id).find((w) => w.key === 'them:8000')?.fixed).toBe('Sounds great.')
  })
})
