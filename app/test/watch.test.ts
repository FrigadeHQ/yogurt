import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callAppId, callAppName } from '../src/main/detect'
import { Watcher } from '../src/main/watch'
import type { Reading } from '../src/main/detectSignals'
import type { Meeting } from '../src/main/store'
import type { CalEvent } from '../src/main/calendar'

const MIN = 60_000
const zoom = { bundleId: 'us.zoom.xos', name: 'zoom.us' }
let clock = 1_000_000_000_000
let reading: Reading
let active: Meeting | null
let log: string[]
let silent = 0
let w: Watcher
let auto = true
const autoWatcher = () => new Watcher({
  read: async () => reading, now: () => clock, active: () => active,
  bindApp: (_id, app) => (active = { ...active!, app }),
  offer: (p) => log.push('offer:' + p.key), askStop: () => log.push('stop'), hide: () => log.push('hide'),
  silentMs: () => silent,
  autoStop: (m) => log.push('auto:' + m.id), autoStopOn: () => auto,
})

const ev = (o: Partial<CalEvent> = {}): CalEvent => ({ id: 'e1', title: 'Review', start: clock, end: clock + 30 * MIN, attendees: [], url: null, ...o })
const meeting = (o: Partial<Meeting> = {}): Meeting => ({ id: 'm1', title: 'Review', startedAt: clock, endedAt: null, eventId: null, app: 'Zoom', attendees: [], state: 'recording', language: null, titleSource: 'generic', ...o })

beforeEach(() => {
  clock = 1_000_000_000_000; reading = { micApps: [], events: [] }; active = null; log = []; silent = 0
  w = new Watcher({
    read: async () => reading, now: () => clock, active: () => active,
    bindApp: (_id, app) => (active = { ...active!, app }),
    offer: (p) => log.push('offer:' + p.key), askStop: () => log.push('stop'), hide: () => log.push('hide'),
    silentMs: () => silent,
  })
})

describe('start cards', () => {
  // A real call: Zoom lets go of the mic for a few seconds when someone switches headsets or toggles mute, and the
  // calendar event can end while the call goes on. None of that is a new call: one offer per call, never a stream of them.
  it('a mic blip in the middle of a call neither takes the card down nor offers again', async () => {
    reading = { micApps: [zoom], events: [] }
    await w.tick()
    for (const gap of [3_000, 20_000, 90_000]) {
      reading = { micApps: [], events: [] }; clock += gap; await w.tick()
      reading = { micApps: [zoom], events: [] }; clock += 3_000; await w.tick()
    }
    expect(log).toEqual(['offer:app:us.zoom.xos'])
  })
  it('a closed card stays closed through mic blips for the rest of that call', async () => {
    reading = { micApps: [zoom], events: [] }
    await w.tick()
    w.dismiss('app:us.zoom.xos')
    for (let i = 0; i < 4; i++) {
      reading = { micApps: [], events: [] }; clock += 10_000; await w.tick()
      reading = { micApps: [zoom], events: [] }; clock += 3_000; await w.tick()
    }
    expect(log.filter((l) => l.startsWith('offer'))).toHaveLength(1)
  })
  it('the calendar event ending while the call goes on is not a new call', async () => {
    const e = ev({ end: clock + 30 * MIN })
    reading = { micApps: [zoom], events: [e] }
    await w.tick()
    clock += 60 * MIN
    reading = { micApps: [zoom], events: [] }
    await w.tick(); clock += 3_000; await w.tick()
    expect(log.filter((l) => l.startsWith('offer'))).toEqual([`offer:event:e1:${e.start}`])
  })
  it('after a recording ends, the call app coming back is a new call: back-to-back meetings each get an offer', async () => {
    reading = { micApps: [zoom], events: [] }
    await w.tick()
    active = meeting(); await w.tick()
    active = null; w.cleared(); await w.tick()
    reading = { micApps: [], events: [] }; clock += 3_000; await w.tick()
    reading = { micApps: [zoom], events: [] }; clock += 3_000; await w.tick()
    expect(log.filter((l) => l.startsWith('offer'))).toEqual(['offer:app:us.zoom.xos', 'offer:app:us.zoom.xos'])
  })
  it('a recording started and stopped between two looks still closes its call', async () => {
    reading = { micApps: [zoom], events: [] }
    await w.tick()
    // Take notes, then Stop, both before the next look
    w.cleared(); w.cleared()
    reading = { micApps: [], events: [] }; clock += 3_000; await w.tick()
    reading = { micApps: [zoom], events: [] }; clock += 3_000; await w.tick()
    expect(log.filter((l) => l.startsWith('offer'))).toEqual(['offer:app:us.zoom.xos', 'offer:app:us.zoom.xos'])
  })
  it('a different calendar meeting starting on the same app is a new call', async () => {
    const first = ev({ id: 'e1', start: clock, end: clock + 30 * MIN })
    reading = { micApps: [zoom], events: [first] }
    await w.tick()
    w.dismiss(`event:e1:${first.start}`)
    clock += 31 * MIN
    const next = ev({ id: 'e2', title: 'Next', start: clock - MIN, end: clock + 30 * MIN })
    reading = { micApps: [zoom], events: [next] }
    await w.tick()
    expect(log.filter((l) => l.startsWith('offer'))).toEqual([`offer:event:e1:${first.start}`, `offer:event:e2:${next.start}`])
  })
  it('two minutes off the mic ends the call: the next one gets its own offer', async () => {
    reading = { micApps: [zoom], events: [] }
    await w.tick()
    w.dismiss('app:us.zoom.xos')
    reading = { micApps: [], events: [] }; await w.tick(); clock += 2 * MIN; await w.tick()
    reading = { micApps: [zoom], events: [] }; await w.tick()
    expect(log.filter((l) => l.startsWith('offer'))).toHaveLength(2)
  })
  it('offers nothing while the first run is still being set up, then offers the call once it is done', async () => {
    let ready = false
    const x = new Watcher({ read: async () => reading, now: () => clock, active: () => active, bindApp: (_id, app) => (active = { ...active!, app }),
      offer: (p) => log.push('offer:' + p.key), askStop: () => log.push('stop'), hide: () => log.push('hide'), ready: () => ready })
    reading = { micApps: [zoom], events: [] }
    await x.tick(); await x.tick()
    expect(log).toEqual([])
    ready = true
    await x.tick()
    expect(log).toEqual(['offer:app:us.zoom.xos'])
  })
  it('offers once per meeting, not on every tick', async () => {
    reading = { micApps: [zoom], events: [ev()] }
    await w.tick(); await w.tick(); await w.tick()
    expect(log).toHaveLength(1)
  })
  it('takes the card down when the call stops before a click, and offers again for a new call', async () => {
    reading = { micApps: [zoom], events: [] }
    await w.tick()
    reading = { micApps: [], events: [] }
    await w.tick(); clock += 2 * MIN; await w.tick()
    reading = { micApps: [zoom], events: [] }
    await w.tick()
    expect(log).toEqual(['offer:app:us.zoom.xos', 'hide', 'offer:app:us.zoom.xos'])
  })
  it('a closed card stays quiet while the app holds the mic, and is forgiven when it lets go', async () => {
    reading = { micApps: [zoom], events: [] }
    await w.tick()
    w.dismiss('app:us.zoom.xos')
    await w.tick(); await w.tick()
    expect(log).toEqual(['offer:app:us.zoom.xos'])
    reading = { micApps: [], events: [] }
    await w.tick(); clock += 2 * MIN; await w.tick()
    expect(w.dismissed.size).toBe(0)
    reading = { micApps: [zoom], events: [] }
    await w.tick()
    expect(log.filter((l) => l.startsWith('offer'))).toHaveLength(2)
  })
  it('a helper process of the app does not forgive the dismissal', async () => {
    w.dismiss('app:us.zoom.xos')
    reading = { micApps: [{ bundleId: 'us.zoom.xos.helper', name: 'x' }], events: [], runningApps: ['us.zoom.xos'] }
    await w.tick()
    expect(w.dismissed.has('app:us.zoom.xos')).toBe(true)
  })
  it('finishing in Yogurt while the call app still holds the mic: no card for that call, and the next call still gets one', async () => {
    reading = { micApps: [zoom], events: [] }
    active = meeting()
    await w.tick(); await w.tick()
    // Finish in Yogurt; Zoom keeps the mic a few seconds longer
    active = null; w.cleared()
    await w.tick(); clock += 5000; await w.tick()
    expect(log.filter((l) => l.startsWith('offer'))).toEqual([])
    // the call ends, and a new one starts later
    reading = { micApps: [], events: [] }
    await w.tick(); clock += 2 * MIN; await w.tick()
    reading = { micApps: [zoom], events: [] }
    await w.tick()
    expect(log.filter((l) => l.startsWith('offer'))).toEqual(['offer:app:us.zoom.xos'])
  })
  it('finishing during a calendar meeting: no card for that event either', async () => {
    const e = ev()
    reading = { micApps: [zoom], events: [e] }
    active = meeting({ eventId: e.id })
    await w.tick()
    active = null; w.cleared()
    await w.tick(); clock += 5000; await w.tick()
    expect(log.filter((l) => l.startsWith('offer'))).toEqual([])
  })
  it('a closed event card stays quiet for good', async () => {
    const e = ev()
    reading = { micApps: [zoom], events: [e] }
    await w.tick()
    w.dismiss(`event:e1:${e.start}`)
    reading = { micApps: [], events: [e] }; await w.tick()
    reading = { micApps: [zoom], events: [e] }; await w.tick()
    expect(log.filter((l) => l.startsWith('offer'))).toHaveLength(1)
  })
  it('no card while recording', async () => {
    active = meeting()
    reading = { micApps: [zoom], events: [] }
    await w.tick()
    expect(log).toEqual([])
  })
})

describe('stop nudge', () => {
  beforeEach(() => { active = meeting(); silent = 60_000 })

  it('asks once after 30 s without the mic, not at 29 s', async () => {
    reading = { micApps: [zoom], events: [] }; await w.tick()
    reading = { micApps: [], events: [] }
    clock += 29_000; await w.tick()
    expect(log).toEqual([])
    clock += 1_000; await w.tick(); await w.tick()
    expect(log).toEqual(['stop'])
  })
  it('takes the nudge down when the mic comes back', async () => {
    reading = { micApps: [zoom], events: [] }; await w.tick()
    reading = { micApps: [], events: [] }; clock += 31_000; await w.tick()
    reading = { micApps: [zoom], events: [] }; clock += 1_000; await w.tick()
    expect(log).toEqual(['stop', 'hide'])
  })
  it('Keep going snoozes for 5 minutes, then asks again', async () => {
    reading = { micApps: [zoom], events: [] }; await w.tick()
    reading = { micApps: [], events: [] }; clock += 31_000; await w.tick()
    w.keepGoing()
    clock += 4 * MIN; await w.tick()
    expect(log).toEqual(['stop'])
    clock += 1.1 * MIN; await w.tick()
    expect(log).toEqual(['stop', 'stop'])
  })
  it('a meeting whose app is something else ignores other apps on the mic', async () => {
    reading = { micApps: [{ bundleId: 'com.hnc.Discord', name: 'Discord' }], events: [] }; await w.tick()
    clock += 31_000; await w.tick()
    expect(log).toEqual(['stop'])
  })
  it('a linked event over by 5 minutes and a quiet minute cannot ask while the mic is held', async () => {
    silent = 0
    const e = ev({ start: clock - 40 * MIN, end: clock - 10 * MIN })
    active = meeting({ eventId: 'e1' })
    reading = { micApps: [zoom], events: [e] }
    await w.tick()
    expect(log).toEqual([])
    clock += MIN; silent = 60_000; await w.tick()
    expect(log).toEqual([])
    clock += 4 * MIN; silent = 5 * MIN; await w.tick()
    expect(log).toEqual([])
  })
  it('a meeting with no app: the mic rule never fires', async () => {
    active = meeting({ app: null })
    reading = { micApps: [], events: [] }
    await w.tick(); clock += 10 * MIN; await w.tick()
    expect(log).toEqual([])
  })
  it('an overdue event cannot ask about a quiet meeting with no bound app', async () => {
    const e = ev({ start: clock - 40 * MIN, end: clock - 10 * MIN })
    active = meeting({ app: null, eventId: 'e1' })
    reading = { micApps: [], events: [e] }; silent = 60_000
    await w.tick(); clock += 10 * MIN; await w.tick()
    expect(log).toEqual([])
  })
})

describe('stops by itself when the call ends', () => {
  beforeEach(() => { active = meeting(); silent = 60_000; auto = true; w = autoWatcher() })

  it('already quiet for a minute, the app lets go for 4 s: stops once, with no question', async () => {
    reading = { micApps: [zoom], events: [] }; await w.tick()
    reading = { micApps: [], events: [] }
    clock += 3_000; await w.tick()
    expect(log).toEqual([])
    clock += 1_000; await w.tick(); await w.tick()
    expect(log).toEqual(['auto:m1'])
  })
  it('a recording started from the card counts the call it was offered for, even if the mic is gone by its first look', async () => {
    active = null
    reading = { micApps: [zoom], events: [] }; await w.tick()
    active = meeting()
    reading = { micApps: [], events: [] }; await w.tick()
    clock += 10_000; await w.tick()
    expect(log).toEqual(['offer:app:us.zoom.xos', 'auto:m1'])
  })
  it('a blip shorter than the grace does nothing', async () => {
    reading = { micApps: [zoom], events: [] }; await w.tick()
    reading = { micApps: [], events: [] }; clock += 2_000; await w.tick()
    reading = { micApps: [zoom], events: [] }; clock += 1_500; await w.tick()
    reading = { micApps: [], events: [] }; clock += 3_000; await w.tick()
    expect(log).toEqual([])
  })
  it('a Meet tab: the browser letting go of the mic ends it', async () => {
    active = meeting({ app: 'Chrome' })
    reading = { micApps: [{ bundleId: 'com.google.Chrome.helper', name: 'Google Chrome Helper', title: 'Meet - abc' }], events: [], runningApps: ['com.google.Chrome'] }; await w.tick()
    reading = { micApps: [], events: [] }; clock += 10_000; await w.tick()
    expect(log).toEqual(['auto:m1'])
  })
  it('switched off: asks as before', async () => {
    auto = false
    reading = { micApps: [zoom], events: [] }; await w.tick()
    reading = { micApps: [], events: [] }; clock += 30_000; await w.tick()
    expect(log).toEqual(['stop'])
  })
  // #100: Join and record is plainly a call. It starts with no call app (the browser or Zoom opens after), so it would
  // count as started by hand; once its call app has been on the mic and the call ends, it stops by itself like a card start.
  it('Join and record stops by itself once its call has ended, like a recording started from the card', async () => {
    active = meeting({ app: null })
    w.joined('m1')
    reading = { micApps: [], events: [] }; await w.tick()
    reading = { micApps: [zoom], events: [] }; clock += 3_000; await w.tick()
    expect(active!.app).toBe('Zoom')
    reading = { micApps: [], events: [] }; clock += 5_000; await w.tick()
    expect(log).toEqual(['auto:m1'])
  })
  it('Join and record whose call never reached the mic is not stopped', async () => {
    active = meeting({ app: null })
    w.joined('m1')
    reading = { micApps: [], events: [] }
    await w.tick(); clock += 10 * MIN; await w.tick()
    expect(log.filter((l) => l.startsWith('auto'))).toEqual([])
  })
  it('New note and the agenda stay started by hand: asked, never stopped by itself', async () => {
    active = meeting({ app: null })
    reading = { micApps: [], events: [] }; await w.tick()
    reading = { micApps: [zoom], events: [] }; clock += 3_000; await w.tick()
    reading = { micApps: [], events: [] }; clock += 31_000; await w.tick()
    expect(log.filter((l) => l.startsWith('auto'))).toEqual([])
  })
  it('a recording started by hand with no call is never stopped', async () => {
    active = meeting({ app: null })
    reading = { micApps: [], events: [] }
    await w.tick(); clock += 10 * MIN; await w.tick()
    expect(log).toEqual([])
  })
  it('a resumed note whose call already ended is not stopped again', async () => {
    reading = { micApps: [], events: [] }
    await w.tick(); clock += 10 * MIN; await w.tick()
    expect(log.filter((l) => l.startsWith('auto'))).toEqual([])
  })
  it('the calendar event ending never stops it during speech', async () => {
    silent = 0
    const e = ev({ start: clock - 40 * MIN, end: clock - 10 * MIN })
    active = meeting({ eventId: 'e1' })
    reading = { micApps: [zoom], events: [e] }
    await w.tick(); clock += 30 * MIN; await w.tick()
    expect(log).toEqual([])
  })
  it('takes down a "Stop recording?" card that was up', async () => {
    auto = false
    reading = { micApps: [zoom], events: [] }; await w.tick()
    reading = { micApps: [], events: [] }; clock += 30_000; await w.tick()
    auto = true; await w.tick()
    expect(log).toEqual(['stop', 'hide', 'auto:m1'])
  })
})


describe('binding a call after any recording start', () => {
  beforeEach(() => { active = meeting({ app: null }); silent = 60_000; auto = true; w = autoWatcher() })
  // a recording started by hand (New note, Take notes on the agenda) is never stopped by itself: the call app letting go of
  // the mic while joining (a browser's pre-join screen) stopped one mid-meeting. It asks, as before, after 30 s
  it.each([zoom, { bundleId: 'us.zoom.CptHost', name: 'CptHost' }, { bundleId: 'com.apple.avconferenced', name: 'avconferenced' }])('binds $bundleId ten seconds after a start by hand, never stops it by itself, and asks after 30 s without the mic', async (mic) => {
    const info = vi.spyOn(console, 'info')
    const appName = callAppName(callAppId(mic.bundleId)!)!
    await w.tick(); clock += 10_000
    reading = { micApps: [mic], events: [], runningApps: [callAppId(mic.bundleId)!] }; await w.tick()
    expect(active?.app).toBe(appName)
    reading = { micApps: [], events: [] }; clock += 10_000; await w.tick()
    expect(log).toEqual([])
    clock += 20_000; await w.tick()
    expect(log).toEqual(['stop'])
    expect(info.mock.calls.map(([line]) => line).filter((l) => !String(l).startsWith('CALL stop-card'))).toEqual([
      'CALL watch meeting=m1 app=none', `CALL bind meeting=m1 app=${appName} via=mic`,
    ])
    info.mockRestore()
  })
  it('binds a call already on the mic, and does not switch to a different app', async () => {
    reading = { micApps: [zoom], events: [] }; await w.tick()
    expect(active?.app).toBe('Zoom')
    reading = { micApps: [{ bundleId: 'com.microsoft.teams2', name: 'Teams' }], events: [] }
    clock += 10_000; await w.tick()
    // started by hand: bound, but never stopped by itself
    expect(active?.app).toBe('Zoom'); expect(log).toEqual([])
  })
  it('uses a fresh pre-start observation once, including a dismissed offer', async () => {
    active = null; reading = { micApps: [zoom], events: [] }; await w.tick()
    w.dismiss('app:us.zoom.xos'); active = meeting({ app: null }); w.cleared()
    reading = { micApps: [], events: [] }; clock += 3000; await w.tick()
    expect(active?.app).toBe('Zoom')
    clock += 10_000; await w.tick(); expect(log).not.toContain('auto:m1')
  })
  it('does not bind an unrelated microphone app or an unqualified browser', async () => {
    reading = { micApps: [{ bundleId: 'com.apple.VoiceMemos', name: 'Voice Memos' }, { bundleId: 'com.google.Chrome', name: 'Chrome' }], events: [] }
    await w.tick(); expect(active?.app).toBeNull()
  })
  it('does not reuse an old call observation for a later recording', async () => {
    active = null; reading = { micApps: [zoom], events: [] }; await w.tick()
    clock += 60_000; active = meeting({ app: null }); reading = { micApps: [], events: [] }
    await w.tick(); expect(active?.app).toBeNull()
  })
})


it('does not keep a FaceTime recording alive for the shared daemon after FaceTime exits', async () => {
  active = meeting({ app: 'FaceTime' }); silent = 60_000; auto = true; w = autoWatcher()
  reading = { micApps: [{ bundleId: 'com.apple.avconferenced', name: 'avconferenced' }], events: [], runningApps: ['com.apple.FaceTime'] }
  await w.tick()
  reading.runningApps = []; clock += 10000; await w.tick()
  expect(log).toEqual(['auto:m1'])
})

describe('on a call', () => {
  it('a call app on the mic is a call, even unrecorded or with its card closed; it ends when the app lets go', async () => {
    expect(w.onCall()).toBe(false)
    reading = { micApps: [zoom], events: [] }
    await w.tick()
    expect(w.onCall()).toBe(true)
    w.dismiss('app:Zoom')
    await w.tick()
    expect(w.onCall()).toBe(true)
    reading = { micApps: [], events: [] }
    await w.tick()
    expect(w.onCall()).toBe(false)
  })
  it('recording is a call too', () => {
    active = meeting()
    expect(w.onCall()).toBe(true)
  })
})


describe('speech protects a call whose app released the mic', () => {
  it('continuous speech prevents cards even after multiple five-minute snoozes would have elapsed', async () => {
    active = meeting(); reading.micApps = [zoom]; await w.tick()
    reading.micApps = []
    for (let i = 0; i < 20; i++) { clock += MIN; silent = 0; await w.tick() }
    expect(log).toEqual([])
    silent = 59_999; await w.tick(); expect(log).toEqual([])
    silent = 60_000; await w.tick(); expect(log).toEqual(['stop'])
  })
  it('Keep going stays quiet through speech and asks again only after a quiet minute and the snooze', async () => {
    active = meeting(); reading.micApps = [zoom]; await w.tick()
    reading.micApps = []; clock += MIN; silent = MIN; await w.tick()
    expect(log).toEqual(['stop'])
    w.keepGoing()
    for (let i = 0; i < 10; i++) { clock += MIN; silent = 0; await w.tick() }
    expect(log).toEqual(['stop'])
    clock += 59_999; silent = 59_999; await w.tick()
    expect(log).toEqual(['stop'])
    clock++; silent++; await w.tick()
    expect(log).toEqual(['stop', 'stop'])
  })
  it('takes down an already-shown card when speech resumes, even if the app stays off the mic', async () => {
    active = meeting(); reading.micApps = [zoom]; await w.tick()
    reading.micApps = []; clock += MIN; silent = MIN; await w.tick()
    silent = 0; await w.tick()
    expect(log).toEqual(['stop', 'hide'])
  })
  it('auto-stop waits for silence, not just the four-second app grace', async () => {
    active = meeting(); w = autoWatcher(); auto = true
    reading.micApps = [zoom]; await w.tick()
    reading.micApps = []
    for (let i = 0; i < 10; i++) { clock += MIN; silent = 0; await w.tick() }
    expect(log).toEqual([])
    silent = 59_999; await w.tick(); expect(log).toEqual([])
    silent = MIN; await w.tick(); expect(log).toEqual(['auto:m1'])
  })
  it('an open app without microphone use never binds a manually started meeting', async () => {
    active = meeting({ app: null }); reading.runningApps = ['us.zoom.xos']
    await w.tick(); clock += MIN; await w.tick()
    expect(active.app).toBeNull()
    expect(log).toEqual([])
  })
  it('missing silence evidence cannot ask or auto-stop', async () => {
    active = meeting()
    const x = new Watcher({ read: async () => reading, now: () => clock, active: () => active,
      bindApp: () => undefined, offer: vi.fn(), askStop: () => log.push('stop'), hide: vi.fn(),
      autoStop: () => log.push('auto'), autoStopOn: () => true })
    reading.micApps = [zoom]; await x.tick()
    reading.micApps = []; clock += 10 * MIN; await x.tick()
    expect(log).toEqual([])
  })
})


it('Close suppresses every later stop question for this recording, but a new recording starts fresh', async () => {
  active = meeting(); reading.micApps = [zoom]; await w.tick()
  reading.micApps = []; clock += MIN; silent = MIN; await w.tick()
  expect(log).toEqual(['stop'])
  w.dismissStop()
  for (const mins of [6, 20, 120]) { clock += mins * MIN; silent = mins * MIN; await w.tick() }
  expect(log).toEqual(['stop'])
  // Resumed speech and a later quiet spell do not undo Close.
  reading.micApps = [zoom]; silent = 0; await w.tick()
  reading.micApps = []; clock += 10 * MIN; silent = 10 * MIN; await w.tick()
  expect(log).toEqual(['stop'])
  active = null; w.cleared(); await w.tick()
  active = meeting({ id: 'm2' }); reading.micApps = [zoom]; silent = 0; await w.tick()
  reading.micApps = []; clock += MIN; silent = MIN; await w.tick()
  expect(log).toEqual(['stop', 'stop'])
})

it('Close does not change automatic-stop rules when the setting is enabled later', async () => {
  active = meeting(); auto = false; w = autoWatcher()
  reading.micApps = [zoom]; await w.tick()
  reading.micApps = []; clock += MIN; silent = MIN; await w.tick()
  w.dismissStop(); auto = true; await w.tick()
  expect(log).toEqual(['stop', 'auto:m1'])
})

// Nov 23: Christian started a note by hand (CALL watch app=none), Zoom came on the mic 5 s later (CALL bind via=mic), and
// when the call ended nothing stopped: a hand start never stopped by itself, and the stop card needs a quiet minute. The
// meeting window and its Leave button going away is a second sign the call ended, even while Zoom keeps the mic.
describe('the call window going away ends the call', () => {
  let win: { goneMs: number } | null
  const windowWatcher = () => new Watcher({
    read: async () => reading, now: () => clock, active: () => active,
    bindApp: (_id, app) => (active = { ...active!, app }),
    offer: (p) => log.push('offer:' + p.key), askStop: () => log.push('stop'), hide: () => log.push('hide'),
    silentMs: () => silent, callWindow: () => win,
    autoStop: (m) => log.push('auto:' + m.id), autoStopOn: () => auto,
  })
  beforeEach(() => { win = null; auto = true; silent = 0; w = windowWatcher() })
  /** the log's sequence up to the end of the call: watch with no app, bind via mic, a call window with people */
  const callStartedByHand = async () => {
    active = meeting({ app: null })
    reading = { micApps: [], events: [] }; await w.tick()
    clock += 5_000; reading = { micApps: [zoom], events: [] }; await w.tick()
    expect(active!.app).toBe('Zoom')
    win = { goneMs: 0 }
    for (let i = 0; i < 10; i++) { clock += MIN; await w.tick() }
    expect(log).toEqual([])
  }
  it('a note started by hand stops by itself once Zoom\'s meeting window is gone, though Zoom keeps the mic', async () => {
    const info = vi.spyOn(console, 'info')
    await callStartedByHand()
    // people leave, the meeting window closes; Zoom still holds the mic
    for (let ms = 1_500; ms <= 30_000 && !log.length; ms += 1_500) { clock += 1_500; win = { goneMs: ms }; silent = ms; await w.tick() }
    expect(log).toEqual(['auto:m1'])
    const lines = info.mock.calls.map(([l]) => String(l))
    expect(lines.find((l) => l.startsWith('CALL gone'))).toMatch(/^CALL gone meeting=m1 app=Zoom idle_ms=0 silent_ms=15000 via=window window_ms=15000 mic=us\.zoom\.xos$/)
    info.mockRestore()
  })
  it('logs what the mic said for the call app every 10 s after its window went away', async () => {
    const info = vi.spyOn(console, 'info')
    await callStartedByHand()
    // someone is still talking in the room: no end, but the log says what the mic did
    for (let ms = 1_500; ms <= 30_000; ms += 1_500) { clock += 1_500; win = { goneMs: ms }; await w.tick() }
    expect(log).toEqual([])
    const lines = info.mock.calls.map(([l]) => String(l)).filter((l) => l.startsWith('CALL window-gone'))
    expect(lines).toEqual([
      'CALL window-gone meeting=m1 app=Zoom window_ms=1500 on_mic=true mic=us.zoom.xos silent_ms=0',
      'CALL window-gone meeting=m1 app=Zoom window_ms=12000 on_mic=true mic=us.zoom.xos silent_ms=0',
      'CALL window-gone meeting=m1 app=Zoom window_ms=22500 on_mic=true mic=us.zoom.xos silent_ms=0',
    ])
    info.mockRestore()
  })
  it('with "Stop recording when the call ends" off, it asks instead', async () => {
    auto = false
    await callStartedByHand()
    for (let ms = 1_500; ms <= 30_000; ms += 1_500) { clock += 1_500; win = { goneMs: ms }; silent = ms; await w.tick() }
    expect(log).toEqual(['stop'])
  })
  it('never while people are still heard', async () => {
    await callStartedByHand()
    for (let ms = 1_500; ms <= 5 * MIN; ms += 1_500) { clock += 1_500; win = { goneMs: ms }; silent = 0; await w.tick() }
    expect(log).toEqual([])
  })
  it('never while the window is only hidden, minimised or on another desktop (the reader says it is not gone)', async () => {
    await callStartedByHand()
    for (let i = 0; i < 200; i++) { clock += 1_500; win = { goneMs: 0 }; silent = 60_000; await w.tick() }
    expect(log).toEqual([])
  })
  it('a window gone for less than the wait is a blip: no end', async () => {
    await callStartedByHand()
    for (let ms = 1_500; ms <= 6_000; ms += 1_500) { clock += 1_500; win = { goneMs: ms }; silent = 60_000; await w.tick() }
    win = { goneMs: 0 }; clock += 1_500; await w.tick()
    expect(log).toEqual([])
  })
  it('a card start still ends by the mic as before', async () => {
    active = meeting()
    reading = { micApps: [zoom], events: [] }; await w.tick()
    reading = { micApps: [], events: [] }; silent = 60_000; clock += 5_000; await w.tick()
    expect(log).toEqual(['auto:m1'])
  })
})

describe('automatic meeting detection', () => {
  it('withdraws the offer immediately and only offers again after detection is enabled', async () => {
    reading = { micApps: [zoom], events: [] }
    await w.tick()
    expect(log).toEqual(['offer:app:us.zoom.xos'])
    w.setDetectionEnabled(false)
    expect(w.onCall()).toBe(false)
    await w.tick()
    expect(log).toEqual(['offer:app:us.zoom.xos', 'hide'])
    w.setDetectionEnabled(true)
    await w.tick()
    expect(log.at(-1)).toBe('offer:app:us.zoom.xos')
  })

  it.each([false, true])('leaves a manual or ongoing recording under user control when auto-stop is %s', async enabled => {
    w = autoWatcher()
    auto = enabled
    active = meeting()
    reading = { micApps: [zoom], events: [] }
    await w.tick()
    w.setDetectionEnabled(false)
    reading = { micApps: [], events: [] }
    clock += 10 * MIN
    silent = 10 * MIN
    await w.tick()
    active = meeting({ id: 'manual', app: null })
    await w.tick()
    expect(w.onCall()).toBe(true)
    expect(active.app).toBeNull()
    expect(log).toEqual(['hide'])
  })

  it('skips signal reads while off and discards a read started before an off/on cycle', async () => {
    let finish!: (reading: Reading) => void
    const read = vi.fn(() => new Promise<Reading>(resolve => { finish = resolve }))
    w = new Watcher({ read, now: () => clock, active: () => active, bindApp: vi.fn(), offer: vi.fn(p => log.push(p.key)), askStop: vi.fn(), hide: vi.fn() })
    const old = w.tick()
    w.setDetectionEnabled(false)
    w.setDetectionEnabled(true)
    finish({ micApps: [zoom], events: [] })
    await old
    expect(log).toEqual([])
    w.setDetectionEnabled(false)
    await w.tick()
    expect(read).toHaveBeenCalledTimes(1)
  })
})
