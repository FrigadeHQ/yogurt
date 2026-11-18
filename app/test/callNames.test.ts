import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type Meeting, type Store } from '../src/main/store'
import { hookCallNames, watchIds, type WatchLine } from '../src/main/callNames'
import { readCall, type AxNode } from '../src/main/callNames/parse'

const dirs: string[] = [], stores: Store[] = []
afterEach(() => { stores.splice(0).forEach((s) => s.close()); dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })) })

/** Zoom's meeting window with these tiles; the talking one marked */
const zoomLine = (t: number, people: string[], talking?: string, me?: string): WatchLine => ({
  t, app: 'us.zoom.xos', windows: [{ id: 'zm.meeting.window.main', tree: { r: 'AXWindow', k: [
    ...people.map((p): AxNode => ({ r: 'AXTabGroup', d: `${p}, Computer audio unmuted${p === talking ? ', Active speaker' : ''}` })),
    ...(me ? [{ r: 'AXOutline', d: 'Participants list', k: [{ r: 'AXRow', k: [{ r: 'AXStaticText', v: `${me} (me)` }] }] } as AxNode] : []),
  ] } }],
})

const webexWindows = (): WatchLine['windows'] => [{ title: 'Webex meeting', tree: { r: 'AXWindow', k: [{ r: 'AXOutline', d: 'Participants', k: [
  { r: 'AXCell', d: 'Participants group, 2 participants', k: [{ r: 'AXUnknown', i: 'GenericParticipantListGroupCellView' }] },
  { r: 'AXCell', d: 'alex@example.com, Host, presenter, me, Muted, ', k: [
    { r: 'AXUnknown', i: 'GenericParticipantListCellView', d: 'alex@example.com, Host, presenter, me, Muted, ' },
    { r: 'AXStaticText', v: 'alex@example.com' }, { r: 'AXStaticText', v: 'Host, presenter, me' },
  ] },
  { r: 'AXCell', d: 'Riley Okafor, example.org, speaking, ', k: [
    { r: 'AXUnknown', i: 'GenericParticipantListCellView', d: 'Riley Okafor, example.org, speaking, ' },
    { r: 'AXStaticText', v: 'Riley Okafor' }, { r: 'AXStaticText', v: 'example.org' },
  ] },
] }] } }]
const webexFloatingWindows = (): WatchLine['windows'] => [{ title: 'Webex multitasking floating window', tree: { r: 'AXWindow', k: [{
  r: 'AXGroup', t: 'Riley Okafor, , , speaking, Video off, ', k: [{ r: 'AXStaticText', v: 'Riley Okafor' }],
}] } }]
const webexCurrentWindows = (): WatchLine['windows'] => [{ title: 'Webex meeting', tree: { r: 'AXWindow', k: [{ r: 'AXOutline', d: 'Participants', k: [
  { r: 'AXRow', d: 'Participants group, 3 participant(s)' },
  { r: 'AXRow', d: 'alex@example.com, Host, presenter, me, Muted,' },
  { r: 'AXRow', d: 'Jane Doe, using phone, Unverified, speaking,' },
  { r: 'AXRow', d: 'Host, Muted,' },
] }] } }]
const webexLine = (t: number): WatchLine => ({ t, app: 'Cisco-Systems.Spark', windows: webexWindows() })

function setup(o: { app?: string | null; attendees?: Meeting['attendees'] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'yogurt-callnames-')); dirs.push(root)
  const store = openStore(join(root, 'yogurt.db')); stores.push(store)
  const m = store.createMeeting({ title: 'Sync', startedAt: 1_000_000, endedAt: null, eventId: null, app: o.app === undefined ? 'Zoom' : o.app, attendees: o.attendees ?? [], state: 'recording' })
  let clock = 1_000_000
  const watched: string[][] = []
  let emit!: (l: WatchLine) => void
  let stopped = 0
  const starts: Array<(m: Meeting) => void> = [], stops: Array<(m: Meeting) => void> = [], binds: Array<(m: Meeting) => void> = []
  const captures: Array<(c: EventEmitter, id: string) => void> = []
  const changed: string[] = [], logs: string[] = []
  let transcribed!: () => void
  const done = new Promise<void>((r) => { transcribed = r })
  const hook = hookCallNames({
    store, myNames: () => ['Alex Morgan'], transcribed: () => done, changed: (id) => changed.push(id), log: (s) => logs.push(s), now: () => clock, every: () => {},
    watch: (ids, onLine) => { watched.push(ids); emit = onLine; return { stop: () => { stopped++ } } },
    onStart: (fn) => starts.push(fn), onStop: (fn) => stops.push(fn), onCapture: (fn) => captures.push(fn), onBind: (fn) => binds.push(fn),
  })
  const capture = new EventEmitter()
  return {
    store, m, hook, watched, changed, logs, transcribed, stopped: () => stopped,
    start() { starts.forEach((f) => f(m)); captures.forEach((f) => f(capture, m.id)) },
    /** audio heard: meeting time `ms`, arriving at wall clock `at` */
    audio(ms: number, at: number) { clock = at; capture.emit('pcm', 'them', ms, new Float32Array(1600)) },
    emit: (l: WatchLine) => emit(l),
    /** the recording learned its call app (CALL bind) */
    bind(app: string) { binds.forEach((f) => f({ ...store.meeting(m.id)!, app })) },
    stop() { const s = { ...store.meeting(m.id)!, state: 'stopped' as const }; stops.forEach((f) => f(s)) },
  }
}
const wait = () => new Promise((r) => setTimeout(r, 10))

describe('watchIds: only the call app the meeting is in', () => {
  it('maps the detected app to its ids (bundle ids on a Mac, program names and Flatpak ids on Linux); no app known: every call app (the first with a call is read)', () => {
    expect(watchIds('Zoom')).toEqual(['us.zoom.xos', 'zoom', 'us.zoom.Zoom', 'zoom.exe'])
    expect(watchIds('Teams')).toEqual(['com.microsoft.teams2', 'com.microsoft.teams', 'teams-for-linux', 'com.github.IsmaelMartinez.teams_for_linux', 'ms-teams.exe', 'teams.exe'])
    expect(watchIds('Webex')).toEqual(['Cisco-Systems.Spark', 'com.cisco.webexmeetingsapp'])
    expect(watchIds('Chrome')).toEqual(['com.google.Chrome', 'chrome', 'google-chrome', 'chrome.exe'])
    expect(watchIds('Edge')).toContain('msedge.exe')
    expect(watchIds('Safari')).toEqual(['com.apple.Safari'])
    expect(watchIds('FaceTime')).toEqual([])
    expect(watchIds(null)).toContain('us.zoom.xos')
    expect(watchIds(null)).toContain('org.mozilla.firefox')
    expect(watchIds(null)).toContain('teams-for-linux')
  })
})

describe('Webex accessibility roster', () => {
  it('reads legacy AXCell roster names, the speaking mark, and me while ignoring group rows', () => {
    expect(readCall('webex', webexWindows()!)).toEqual({
      speaking: ['Riley Okafor'], participants: ['alex@example.com', 'Riley Okafor'], me: 'alex@example.com',
    })
  })

  it('reads the marked speaker from the floating video tile when the roster is closed', () => {
    expect(readCall('webex', webexFloatingWindows()!)).toEqual({ speaking: ['Riley Okafor'], participants: [], me: null })
  })

  it('reads AXRow roster descriptions from current Webex builds', () => {
    expect(readCall('webex', webexCurrentWindows()!)).toEqual({
      speaking: ['Jane Doe'], participants: ['alex@example.com', 'Jane Doe'], me: 'alex@example.com',
    })
  })
})

describe('hookCallNames', () => {
  // #83 (Windows): Teams in Chrome was read with the Meet reader, and the Teams desktop app's readings were dropped
  const teamsTree = (): AxNode => ({ r: 'frame', k: [
    { r: 'section', t: 'Dana Smith, speaking' },
    { r: 'tree', t: 'Participants', k: [{ r: 'tree item', t: 'Dana Smith, unmuted' }, { r: 'tree item', t: 'Ann Lee, muted' }, { r: 'tree item', t: 'Alex Morgan (You)' }] },
  ] })
  it('Teams in a browser tab is read as Teams, not Meet', () => {
    const s = setup({ app: 'Chrome' })
    s.start()
    s.emit({ t: 1_000_000, app: 'chrome.exe', windows: [{ title: 'Weekly sync | Microsoft Teams - Google Chrome', tree: teamsTree() }] })
    expect(s.logs.some((l) => l.startsWith('call names: reading chrome.exe (teams)'))).toBe(true)
    expect(s.logs).toContain('call names: teams talking 1 of 3, me known')
  })
  it('a Teams call whose window comes from a program not on the list (its web view) is still read as Teams, and the log names it', () => {
    const s = setup({ app: 'Teams' })
    s.start()
    s.emit({ t: 1_000_000, app: 'msedgewebview2.exe', windows: [{ title: 'Meeting | Microsoft Teams', tree: teamsTree() }] })
    expect(s.logs.some((l) => l.startsWith('call names: reading msedgewebview2.exe (teams)'))).toBe(true)
    expect(s.logs).toContain('call names: teams talking 1 of 3, me known')
  })

  it('a reader that goes quiet (no reading for over 5 s while recording) is started again, and the log says so', () => {
    const s = setup()
    s.start()
    s.emit(zoomLine(1_000_000, ['Alex Morgan', 'Dana Smith'], 'Dana Smith'))
    s.audio(0, 1_004_000); s.hook.checkQuiet()
    expect(s.watched).toHaveLength(1)
    s.audio(0, 1_006_500); s.hook.checkQuiet()
    expect(s.stopped()).toBe(1)
    expect(s.watched).toHaveLength(2)
    expect(s.logs.some((l) => /went quiet/.test(l))).toBe(true)
    // readings again: nothing more to do
    s.emit(zoomLine(1_007_000, ['Alex Morgan', 'Dana Smith'], 'Dana Smith'))
    s.audio(0, 1_009_000); s.hook.checkQuiet()
    expect(s.watched).toHaveLength(2)
  })

  it('a recording started by hand watches every call app until its app is known, then only that one (a Teams chat window cannot hide a Meet call, #72)', () => {
    const s = setup({ app: null })
    s.start()
    expect(s.watched[0]).toContain('com.microsoft.teams2')
    s.bind('Chrome')
    expect(s.stopped()).toBe(1)
    expect(s.watched.at(-1)).toEqual(watchIds('Chrome'))
    // a meeting that knew its app from the start is never watched again
    const k = setup()
    k.start(); k.bind('Chrome')
    expect(k.watched).toHaveLength(1)
  })

  it('says what it read in main.log (info, which the log file keeps; console.log never reaches it)', () => {
    const root = mkdtempSync(join(tmpdir(), 'yogurt-callnames-')); dirs.push(root)
    const store = openStore(join(root, 'yogurt.db')); stores.push(store)
    const m = store.createMeeting({ title: 'Sync', startedAt: 1_000_000, endedAt: null, eventId: null, app: 'FaceTime', attendees: [], state: 'recording' })
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const starts: Array<(m: Meeting) => void> = []
    try {
      hookCallNames({ store, myNames: () => [], transcribed: async () => {}, changed: () => {}, watch: () => ({ stop() {} }),
        onStart: (fn) => starts.push(fn), onStop: () => {}, onCapture: () => {} })
      starts.forEach((f) => f(m))
      expect(info.mock.calls.flat().join('\n')).toContain("call names: FaceTime can't be read")
    } finally { info.mockRestore() }
  })

  it('a resumed session names only new lines and preserves previous speaker labels', async () => {
    const s = setup()
    s.store.addSegments([{ meetingId: s.m.id, track: 'them', startMs: 1000, endMs: 3000, text: 'Prior session.', speaker: 'Ann Lee' }])
    s.start(); s.audio(10_000, 2_000_100)
    s.store.addSegments([{ meetingId: s.m.id, track: 'them', startMs: 11_000, endMs: 13_000, text: 'New session.', speaker: null }])
    for (let t = 2_000_000; t < 2_010_000; t += 500) s.emit(zoomLine(t, ['Bo Park'], 'Bo Park'))
    s.stop(); s.transcribed(); await s.hook.finished(s.m.id)
    expect(s.store.segments(s.m.id).map((line) => line.speaker)).toEqual(['Ann Lee', 'Bo Park'])
  })

  it('reads the meeting\'s app while it records, and a line of the other side gets the name talking then', () => {
    const s = setup()
    s.start()
    expect(s.watched).toEqual([['us.zoom.xos', 'zoom', 'us.zoom.Zoom', 'zoom.exe']])
    // meeting time 0 was heard at 1_005_000 (the 100 ms of audio arrived 100 ms after it started)
    s.audio(0, 1_005_100)
    for (let t = 1_006_000; t < 1_014_000; t += 500) s.emit(zoomLine(t, ['Alex Morgan', 'Dana Smith', 'Ann Lee'], t < 1_010_000 ? 'Dana Smith' : 'Ann Lee'))
    // Zoom marks a little late: 1.75 s to 4.25 s of the meeting is Dana's
    expect(s.hook.nameFor(s.m.id, 1500, 4000)).toBe('Dana Smith')
    expect(s.hook.nameFor(s.m.id, 6000, 8000)).toBe('Ann Lee')
    expect(s.hook.nameFor('other', 1500, 4000)).toBeNull()
  })

  it('reads Webex roster names during a call', () => {
    const s = setup({ app: 'Webex' })
    s.start()
    expect(s.watched).toEqual([['Cisco-Systems.Spark', 'com.cisco.webexmeetingsapp']])
    s.audio(0, 1_000_100)
    for (let t = 1_000_000; t < 1_005_000; t += 500) s.emit(webexLine(t))
    expect(s.hook.nameFor(s.m.id, 1000, 3000)).toBe('Riley Okafor')
  })

  it('after the meeting every line of the other side is named again from the whole timeline; new people join the attendees', async () => {
    const s = setup({ attendees: [{ name: 'Dana Smith', email: 'dana@example.com' }] })
    s.start()
    s.audio(0, 1_000_100)
    s.store.addSegments([
      { meetingId: s.m.id, track: 'them', startMs: 1000, endMs: 3000, text: 'early', speaker: null },
      { meetingId: s.m.id, track: 'me', startMs: 3000, endMs: 4000, text: 'mine', speaker: 'me' },
      { meetingId: s.m.id, track: 'them', startMs: 6000, endMs: 8000, text: 'later', speaker: null },
    ])
    for (let t = 1_000_000; t < 1_010_000; t += 500) s.emit(zoomLine(t, ['Alex Morgan', 'Dana Smith', 'Ann Lee'], t < 1_005_000 ? 'Dana Smith' : 'Ann Lee', 'Alex Morgan'))
    s.stop()
    expect(s.stopped()).toBe(1)
    s.transcribed()
    await s.hook.finished(s.m.id)
    expect(s.store.segments(s.m.id).map((x) => x.speaker)).toEqual(['Dana Smith', 'me', 'Ann Lee'])
    expect(s.store.meeting(s.m.id)!.attendees).toEqual([{ name: 'Dana Smith', email: 'dana@example.com' }, { name: 'Ann Lee', email: null }])
    expect(s.changed).toEqual([s.m.id])
    // the first reading is pictured in the log, for a real call's data
    expect(s.logs.some((l) => l.includes('AXTabGroup'))).toBe(true)
    // main.log is pasted into public issues: no one's name reaches it, only counts and shapes
    for (const name of ['Alex Morgan', 'Dana Smith', 'Ann Lee']) expect(s.logs.join('\n')).not.toContain(name)
    expect(s.logs.some((l) => /talking 1 of 3/.test(l))).toBe(true)
  })

  it('without Accessibility, or with nothing read, every line stays Them and nothing changes', async () => {
    const s = setup()
    s.start()
    s.audio(0, 1_000_100)
    s.store.addSegments([{ meetingId: s.m.id, track: 'them', startMs: 1000, endMs: 3000, text: 'hello', speaker: null }])
    for (let t = 1_000_000; t < 1_005_000; t += 500) s.emit({ t, error: 'not-trusted' })
    expect(s.hook.nameFor(s.m.id, 1000, 3000)).toBeNull()
    s.stop(); s.transcribed()
    await s.hook.finished(s.m.id)
    expect(s.store.segments(s.m.id)[0].speaker).toBeNull()
    expect(s.changed).toEqual([])
    // said once, not on every reading
    expect(s.logs.filter((l) => l.includes('not-trusted'))).toHaveLength(1)
  })

  it('a meeting in an app it can\'t read starts no watch', async () => {
    const s = setup({ app: 'FaceTime' })
    s.start()
    expect(s.watched).toEqual([])
    s.stop(); s.transcribed()
    await s.hook.finished(s.m.id)
  })

  it('the name in Settings is never given to the other side', async () => {
    const s = setup()
    s.start()
    s.audio(0, 1_000_100)
    for (let t = 1_000_000; t < 1_005_000; t += 500) s.emit(zoomLine(t, ['Alex Morgan', 'Dana Smith', 'Ann Lee'], 'Alex Morgan'))
    expect(s.hook.nameFor(s.m.id, 1000, 3000)).toBeNull()
    // and a call of two with that name is the other person's whatever is marked
    const p = setup()
    p.start()
    p.audio(0, 1_000_100)
    for (let t = 1_000_000; t < 1_005_000; t += 500) p.emit(zoomLine(t, ['Alex Morgan', 'Dana Smith']))
    expect(p.hook.nameFor(p.m.id, 1000, 3000)).toBe('Dana Smith')
    await wait()
  })
})
