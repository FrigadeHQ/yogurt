import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

function setup(o: { app?: string | null; attendees?: Meeting['attendees']; micPids?: Record<string, number[]>; myNames?: string[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'yogurt-callnames-')); dirs.push(root)
  const store = openStore(join(root, 'yogurt.db')); stores.push(store)
  const m = store.createMeeting({ title: 'Sync', startedAt: 1_000_000, endedAt: null, eventId: null, app: o.app === undefined ? 'Zoom' : o.app, attendees: o.attendees ?? [], state: 'recording' })
  let clock = 1_000_000
  const watched: string[][] = [], watchedPids: Array<number[] | undefined> = []
  const micPids = { ...o.micPids }
  let emit!: (l: WatchLine) => void
  let stopped = 0
  const starts: Array<(m: Meeting) => void> = [], stops: Array<(m: Meeting) => void> = [], binds: Array<(m: Meeting) => void> = []
  const captures: Array<(c: EventEmitter, id: string) => void> = []
  const changed: string[] = [], logs: string[] = []
  let transcribed!: () => void
  const done = new Promise<void>((r) => { transcribed = r })
  const hook = hookCallNames({
    store, myNames: () => o.myNames ?? ['Alex Morgan'], transcribed: () => done, changed: (id) => changed.push(id), log: (s) => logs.push(s), now: () => clock, every: () => {},
    watch: (ids, onLine, pids) => { watched.push(ids); watchedPids.push(pids); emit = onLine; return { stop: () => { stopped++ } } },
    micPids: (app) => micPids[app] ?? [],
    onStart: (fn) => starts.push(fn), onStop: (fn) => stops.push(fn), onCapture: (fn) => captures.push(fn), onBind: (fn) => binds.push(fn),
  })
  const capture = new EventEmitter()
  return {
    store, m, hook, watched, watchedPids, changed, logs, transcribed, stopped: () => stopped,
    /** the processes of an app on the mic now */
    setMic(app: string, pids: number[]) { micPids[app] = pids },
    start() { starts.forEach((f) => f(m)); captures.forEach((f) => f(capture, m.id)) },
    /** audio heard: meeting time `ms`, arriving at wall clock `at` */
    audio(ms: number, at: number) { clock = at; capture.emit('pcm', 'them', ms, new Float32Array(1600)) },
    emit: (l: WatchLine) => emit(l),
    /** the wall clock moves to `at` */
    at(t: number) { clock = t },
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
    expect(watchIds('Slack')).toEqual(['com.tinyspeck.slackmacgap'])
    expect(watchIds(null)).toContain('us.zoom.xos')
    expect(watchIds(null)).toContain('org.mozilla.firefox')
    expect(watchIds(null)).toContain('teams-for-linux')
    // Ardia, a Chromium browser on the Mac (#123): a hand-started recording reads its Meet tab too
    expect(watchIds('Ardia')).toEqual(['com.ardia.browser'])
    expect(watchIds(null)).toContain('com.ardia.browser')
    // Dia (The Browser Company, Chromium) too (#131)
    expect(watchIds('Dia')).toEqual(['company.thebrowser.dia'])
    expect(watchIds(null)).toContain('company.thebrowser.dia')
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

  it('a slow reader that still sends readings is never started again: it gets three times its own pace (#83)', () => {
    const s = setup()
    s.start()
    // a big window: the first reading takes 4 s, and the reader then reads every 8 s (it waits as long as a reading took)
    s.audio(0, 1_004_000); s.emit(zoomLine(1_004_000, ['Alex Morgan', 'Dana Smith'], 'Dana Smith'))
    for (let at = 1_006_000; at <= 1_060_000; at += 2_000) {
      s.audio(0, at)
      if ((at - 1_004_000) % 8_000 === 0) s.emit(zoomLine(at, ['Alex Morgan', 'Dana Smith'], 'Dana Smith'))
      s.hook.checkQuiet()
    }
    expect(s.watched).toHaveLength(1)
    expect(s.logs.some((l) => /went quiet/.test(l))).toBe(false)
  })

  it('a reader started again gets twice as long each time before the next start, so a first reading that takes 10 s lands (#83)', () => {
    const s = setup()
    s.start()
    const starts: number[] = []
    for (let at = 1_002_000; at <= 1_060_000; at += 2_000) {
      s.audio(0, at); s.hook.checkQuiet()
      if (s.watched.length > starts.length + 1) starts.push(at)
    }
    // 5 s, then 10 s, then 20 s of quiet; never every 6 s
    expect(starts).toEqual([1_006_000, 1_018_000, 1_040_000])
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

  // #98: two Zoom meetings, two Zoom processes. The helper reads the processes it is given, else the frontmost one,
  // which here is the other meeting.
  const twoMeetings: Record<number, string[]> = { 501: ['Alex Morgan', 'Dana Smith'], 502: ['Alex Morgan', 'Priya Nair', 'Omar Haddad'] }
  const helperReads = (pids: number[] | undefined) => twoMeetings[pids?.[0] ?? 502]
  it('with two Zoom meetings open, only the one on the mic is read: no name from the other reaches this transcript or its attendees (#98)', async () => {
    const s = setup({ micPids: { Zoom: [501] } })
    s.start()
    expect(s.watchedPids).toEqual([[501]])
    s.audio(0, 1_000_100)
    s.store.addSegments([{ meetingId: s.m.id, track: 'them', startMs: 1000, endMs: 3000, text: 'hi', speaker: null }])
    const people = helperReads(s.watchedPids.at(-1))
    for (let t = 1_000_000; t < 1_005_000; t += 500) s.emit(zoomLine(t, people, people[1], 'Alex Morgan'))
    s.stop(); s.transcribed()
    await s.hook.finished(s.m.id)
    expect(s.store.segments(s.m.id).map((x) => x.speaker)).toEqual(['Dana Smith'])
    expect(s.store.meeting(s.m.id)!.attendees.map((a) => a.name)).toEqual(['Dana Smith'])
  })
  it('a recording whose app was not on the mic yet is read again from only the process on the mic once it is, and what was read before is dropped (#98)', () => {
    const s = setup()
    s.start()
    expect(s.watchedPids).toEqual([undefined])
    s.audio(0, 1_000_100)
    for (let t = 1_000_000; t < 1_002_000; t += 500) s.emit(zoomLine(t, helperReads(undefined), 'Priya Nair'))
    s.setMic('Zoom', [501]); s.hook.checkQuiet()
    expect(s.stopped()).toBe(1)
    expect(s.watchedPids.at(-1)).toEqual([501])
    expect(s.hook.nameFor(s.m.id, 0, 1000)).toBeNull()
    // learned once: the watch isn't started again on every check
    s.hook.checkQuiet()
    expect(s.watchedPids).toHaveLength(2)
  })

  it('a 1:1 Teams call names every line of the other side after that person, with my own name not set (#83)', async () => {
    const s = setup({ app: 'Teams', myNames: [] })
    s.start()
    s.audio(0, 1_000_100)
    s.store.addSegments([
      { meetingId: s.m.id, track: 'them', startMs: 1000, endMs: 3000, text: 'Hallo.', speaker: null },
      { meetingId: s.m.id, track: 'them', startMs: 6000, endMs: 9000, text: 'Bis dann.', speaker: null },
    ])
    const tree: AxNode = { r: 'frame', k: [
      { r: 'push button', i: 'hold-button', t: 'Halten' }, { r: 'push button', i: 'hangup-button', t: 'Auflegen' },
      { r: 'menu item', t: 'Anna Becker', k: [{ r: 'label', t: 'Anna Becker' }] },
    ] }
    for (let t = 1_000_000; t < 1_011_000; t += 500) s.emit({ t, app: 'ms-teams.exe', windows: [{ title: 'Anna Becker | Microsoft Teams', tree }] })
    s.stop(); s.transcribed()
    await s.hook.finished(s.m.id)
    expect(s.store.segments(s.m.id).map((x) => x.speaker)).toEqual(['Anna Becker', 'Anna Becker'])
  })

  it('a reading that shows fewer people than a moment ago (the stage changed) names nobody from who is muted (#83)', () => {
    const s = setup({ app: 'Teams' })
    s.start()
    s.audio(0, 1_000_100)
    const tile = (name: string, muted: boolean): AxNode => ({ r: 'menu item', t: `${name}, Weekly, ${muted ? 'stummgeschaltet, ' : ''}Kontextmenü ist verfügbar`, k: [{ r: 'label', t: name }] })
    const line = (t: number, tiles: AxNode[]): WatchLine => ({ t, app: 'ms-teams.exe', windows: [{ title: 'Weekly | Microsoft Teams', tree: { r: 'frame', k: [{ r: 'push button', i: 'hangup-button', t: 'Verlassen' }, ...tiles] } }] })
    for (let t = 1_000_000; t < 1_005_000; t += 500) s.emit(line(t, [tile('Anna Becker', true), tile('Jonas Weber', true), tile('Lena Hoffmann', false)]))
    for (let t = 1_005_000; t < 1_010_000; t += 500) s.emit(line(t, [tile('Anna Becker', true), tile('Jonas Weber', false)]))
    expect(s.hook.nameFor(s.m.id, 1000, 3000)).toBe('Lena Hoffmann')
    expect(s.hook.nameFor(s.m.id, 6000, 8000)).toBeNull()
  })

  it('a meeting whose stage shrinks to me and one other is not taken for a call of two (#83: "0 of 13", then "0 of 2")', () => {
    const s = setup()
    s.start()
    s.audio(0, 1_000_100)
    for (let t = 1_000_000; t < 1_005_000; t += 500) s.emit(zoomLine(t, ['Alex Morgan', 'Dana Smith', 'Ann Lee', 'Bo Park'], undefined, 'Alex Morgan'))
    for (let t = 1_005_000; t < 1_010_000; t += 500) s.emit(zoomLine(t, ['Alex Morgan', 'Dana Smith'], undefined, 'Alex Morgan'))
    expect(s.hook.nameFor(s.m.id, 6000, 8000)).toBeNull()
    // a real call of two still is one
    const two = setup()
    two.start(); two.audio(0, 1_000_100)
    for (let t = 1_000_000; t < 1_010_000; t += 500) two.emit(zoomLine(t, ['Alex Morgan', 'Dana Smith'], undefined, 'Alex Morgan'))
    expect(two.hook.nameFor(two.m.id, 6000, 8000)).toBe('Dana Smith')
  })

  it('after the call app is known, the first reading says what it found again, even when it is what the last one said (#83: 38 minutes with no line)', () => {
    const s = setup({ app: null })
    s.start()
    const empty: WatchLine = { t: 1_000_000, app: 'ms-teams.exe', windows: [{ title: 'Sync | Microsoft Teams', tree: { r: 'frame', k: [{ r: 'push button', i: 'hangup-button', t: 'Leave' }] } }] }
    s.emit(empty)
    s.bind('Teams')
    s.emit({ ...empty, t: 1_001_000 })
    expect(s.logs.filter((l) => l === 'call names: teams talking 0 of 0')).toHaveLength(2)
  })

  it('a Teams meeting of two showing my tile ("(You)" inside) and the other one names their lines, with my own name not set (#83)', async () => {
    const s = setup({ app: 'Teams', myNames: [] })
    s.start()
    s.audio(0, 1_000_100)
    s.store.addSegments([{ meetingId: s.m.id, track: 'them', startMs: 1000, endMs: 3000, text: 'Hi.', speaker: null }])
    const tile = (name: string, label: string): AxNode => ({ r: 'menu item', t: `${name}, video is on, Weekly, Context menu is available`, k: [{ r: 'label', t: label }] })
    const tree: AxNode = { r: 'frame', k: [{ r: 'push button', i: 'hangup-button', t: 'Leave' }, tile('Alex Morgan', '(You)'), tile('Dana Smith', 'DS')] }
    for (let t = 1_000_000; t < 1_005_000; t += 500) s.emit({ t, app: 'ms-teams.exe', windows: [{ title: 'Weekly | Microsoft Teams', tree }] })
    s.stop(); s.transcribed()
    await s.hook.finished(s.m.id)
    expect(s.store.segments(s.m.id).map((x) => x.speaker)).toEqual(['Dana Smith'])
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

  it('a Teams that shows no call window still has its windows pictured in the log, once, without names (#138)', () => {
    const s = setup({ app: 'Teams' })
    s.start()
    const windows = [{ title: 'Chat | Dana Smith | Microsoft Teams', tree: { r: 'AXWindow', k: [{ r: 'AXGroup', k: [{ r: 'AXButton', d: 'Dana Smith' }] }] } }]
    for (let t = 1_000_000; t < 1_002_000; t += 500) s.emit({ t, error: 'no-call-window (search unavailable)', app: 'com.microsoft.teams2', windows })
    const pictured = s.logs.filter((l) => l.startsWith('call names: no call window in com.microsoft.teams2') && l.includes('its windows in short:'))
    expect(pictured).toHaveLength(1)
    expect(pictured[0]).toContain('AXButton')
    expect(s.logs.join('\n')).not.toContain('Dana Smith')
    expect(s.logs.filter((l) => l === 'call names: no-call-window (search unavailable)')).toHaveLength(1)
  })
  it('says how many windows the Mac shows for Teams next to the ones it pictures, so a window accessibility leaves out shows (#138)', () => {
    const s = setup({ app: 'Teams' })
    s.start()
    s.emit({ t: 1_000_000, error: 'no-call-window', app: 'com.microsoft.teams2', windows: [{ title: 'Microsoft Teams', tree: { r: 'AXWindow' } }], macWindows: 3 })
    expect(s.logs.some((l) => l.startsWith('call names: no call window in com.microsoft.teams2 (the Mac shows 3 of its windows), its windows in short:'))).toBe(true)
  })

  it("pictures the window again once the call shows people, since Teams opens the mic on its join screen (#138)", () => {
    const s = setup({ app: 'Teams' })
    s.start()
    const join = { r: 'AXWindow', k: [{ r: 'AXButton', i: 'hangup-button', d: 'Leave' }, { r: 'AXHeading', t: 'Meeting join' }] }
    const call = { r: 'AXWindow', k: [{ r: 'AXButton', i: 'hangup-button', d: 'Leave' },
      { r: 'AXMenuItem', d: 'Dana Smith, Has control of production tools, Context menu is available', k: [{ r: 'AXStaticText', v: 'Dana Smith' }, { r: 'AXGroup', c: ['vdi-frame-occlusion'] }] }] }
    s.emit({ t: 1_000_000, app: 'com.microsoft.teams2', windows: [{ title: 'Meeting join | Microsoft Teams', tree: join }] })
    s.emit({ t: 1_000_500, app: 'com.microsoft.teams2', windows: [{ title: 'Meeting join | Microsoft Teams', tree: join }] })
    s.emit({ t: 1_001_000, app: 'com.microsoft.teams2', windows: [{ title: 'Weekly | Microsoft Teams', tree: call }] })
    s.emit({ t: 1_001_500, app: 'com.microsoft.teams2', windows: [{ title: 'Weekly | Microsoft Teams', tree: call }] })
    const pictures = s.logs.filter((l) => l.startsWith('call names: reading com.microsoft.teams2 (teams), its window in short'))
    expect(pictures).toHaveLength(2)
    expect(pictures[1]).toContain('AXMenuItem')
    expect(s.logs.join('\n')).not.toContain('Dana Smith')
  })

  it('pictures a Meet window again the first time someone is marked talking, deep enough to show the tiles: the lobby shows people too (#112)', () => {
    const s = setup({ app: 'Chrome' })
    s.start()
    const tile = (name: string, talking: boolean): AxNode => {
      let n: AxNode = { r: 'AXStaticText', v: name }
      for (let i = 0; i < 6; i++) n = { r: 'AXGroup', k: [n] }
      return { r: 'AXGroup', c: talking ? ['v5h6Xc'] : [], k: [n] }
    }
    const page = (tiles: AxNode[]): WatchLine['windows'] => [{ title: 'Meet - abc-defg-hij', tree: { r: 'AXWindow', k: [{ r: 'AXWebArea', k: [{ r: 'AXGroup', k: [
      ...Array.from({ length: 70 }, (_, i): AxNode => ({ r: 'AXButton', d: `Button ${i}` })), ...tiles] }] }] } }]
    s.emit({ t: 1_000_000, app: 'com.google.Chrome', windows: page([tile('Dana Smith', false), tile('Ann Lee', false)]) })
    s.emit({ t: 1_000_500, app: 'com.google.Chrome', windows: page([tile('Dana Smith', true), tile('Ann Lee', false)]) })
    s.emit({ t: 1_001_000, app: 'com.google.Chrome', windows: page([tile('Dana Smith', false), tile('Ann Lee', true)]) })
    const pictures = s.logs.filter((l) => l.startsWith('call names: reading com.google.Chrome (meet), its window in short'))
    expect(pictures).toHaveLength(2)
    expect(pictures[1]).toContain('.v5h6Xc')
    expect(pictures[1]).toContain('AXStaticText "‹10›"')
    expect(s.logs.join('\n')).not.toContain('Dana Smith')
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

// #auto-end: Christian's Zoom call (Nov 23) never stopped by itself. A call window seen and then gone is a second sign the
// call ended, beside the mic, which Zoom can keep after a meeting.
describe('auto end by the call window on Windows (#83)', () => {
  it("ends a call on Windows too once its window is gone: the Windows reader says when the window is only minimised or on another desktop", () => {
    const main = readFileSync(join(__dirname, '../src/main/index.ts'), 'utf8')
    expect(main).toMatch(/process\.platform === 'darwin' \|\| process\.platform === 'win32'\) callWindowOf = /)
    const rust = readFileSync(join(__dirname, '../native/yogurt-system/src/wincalls.rs'), 'utf8')
    expect(rust).toContain('Look::Hidden => return json!({ "t": t, "error": "no-call-window", "hidden": true })')
  })
})

describe('callWindow: the call window seen, then gone', () => {
  const gone = (t: number, extra: Partial<WatchLine> = {}): WatchLine => ({ t, app: 'us.zoom.xos', error: 'no-call-window', ...extra })
  it('a Zoom meeting window with people that goes away counts how long it has been gone, and says so in the log', () => {
    const s = setup({ app: null })
    s.start(); s.bind('Zoom')
    for (let t = 1_000_000; t <= 1_005_000; t += 500) { s.at(t); s.emit(zoomLine(t, ['Alex Morgan', 'Dana Smith'])) }
    expect(s.hook.callWindow(s.m.id)).toEqual({ goneMs: 0 })
    for (let t = 1_005_500; t <= 1_015_500; t += 500) { s.at(t); s.emit(gone(t)) }
    expect(s.hook.callWindow(s.m.id)).toEqual({ goneMs: 10_000 })
    expect(s.logs).toContain('call names: the zoom call window went away')
    // it comes back (a reading of the window again): not gone
    s.at(1_016_000); s.emit(zoomLine(1_016_000, ['Alex Morgan', 'Dana Smith']))
    expect(s.hook.callWindow(s.m.id)).toEqual({ goneMs: 0 })
    expect(s.logs).toContain('call names: the zoom call window is back after 11 s')
  })
  it('a Teams call whose window (its Leave button) goes away is gone the same way', () => {
    const s = setup({ app: 'Teams' })
    s.start()
    const tree: AxNode = { r: 'frame', k: [{ r: 'section', t: 'Dana Smith, speaking' }, { r: 'tree', t: 'Participants', k: [{ r: 'tree item', t: 'Dana Smith, unmuted' }, { r: 'tree item', t: 'Alex Morgan (You)' }] }] }
    s.at(1_000_000); s.emit({ t: 1_000_000, app: 'com.microsoft.teams2', windows: [{ title: 'Meeting | Microsoft Teams', tree }] })
    for (let t = 1_000_500; t <= 1_008_500; t += 500) { s.at(t); s.emit({ t, app: 'com.microsoft.teams2', error: 'no-call-window' }) }
    expect(s.hook.callWindow(s.m.id)?.goneMs).toBe(8_000)
    expect(s.logs).toContain('call names: the teams call window went away')
  })
  it('Zoom quitting is the window gone too', () => {
    const s = setup()
    s.start()
    s.at(1_000_000); s.emit(zoomLine(1_000_000, ['Alex Morgan', 'Dana Smith']))
    for (let t = 1_000_500; t <= 1_010_500; t += 500) { s.at(t); s.emit({ t, error: 'not-running' }) }
    expect(s.hook.callWindow(s.m.id)?.goneMs).toBe(10_000)
  })
  it('a window the Mac still has but accessibility cannot see (another desktop, full screen) is not gone', () => {
    const s = setup()
    s.start()
    s.at(1_000_000); s.emit(zoomLine(1_000_000, ['Alex Morgan', 'Dana Smith']))
    for (let t = 1_000_500; t <= 1_060_000; t += 500) { s.at(t); s.emit(gone(t, { hidden: true })) }
    expect(s.hook.callWindow(s.m.id)).toEqual({ goneMs: 0 })
    expect(s.logs.filter((l) => l.includes('out of sight'))).toHaveLength(1)
  })
  it('a minimised meeting window is still read, so it is not gone', () => {
    const s = setup()
    s.start()
    for (let t = 1_000_000; t <= 1_060_000; t += 500) {
      const l = zoomLine(t, ['Alex Morgan', 'Dana Smith']); l.windows![0].minimized = t > 1_001_000
      s.at(t); s.emit(l)
    }
    expect(s.hook.callWindow(s.m.id)).toEqual({ goneMs: 0 })
  })
  it('no call window ever seen with people (a pre-join screen, a call not joined yet): no evidence either way', () => {
    const s = setup()
    s.start()
    s.at(1_000_000); s.emit(zoomLine(1_000_000, []))
    for (let t = 1_000_500; t <= 1_060_000; t += 500) { s.at(t); s.emit(gone(t)) }
    expect(s.hook.callWindow(s.m.id)).toBeNull()
  })
  it('a reader that went quiet or lost its permission is no evidence the window went away', () => {
    const s = setup()
    s.start()
    s.at(1_000_000); s.emit(zoomLine(1_000_000, ['Alex Morgan', 'Dana Smith']))
    s.at(1_000_500); s.emit(gone(1_000_500))
    s.at(1_030_000)
    expect(s.hook.callWindow(s.m.id)).toEqual({ goneMs: 0 })
    s.emit({ t: 1_030_000, error: 'not-trusted' })
    s.at(1_040_000); s.emit({ t: 1_040_000, error: 'not-trusted' })
    expect(s.hook.callWindow(s.m.id)).toEqual({ goneMs: 0 })
  })
  it('a Slack huddle ends once its grid is gone, in any language; while Slack still shows the huddle bar it does not', () => {
    const s = setup({ app: 'Slack' })
    s.start()
    const app = 'com.tinyspeck.slackmacgap'
    const tile: AxNode = { r: 'AXCell', t: 'a label in a language not listed', i: 'huddle-grid-gridcell-self_U1', c: ['p-huddle_peer_tile'] }
    s.at(1_000_000); s.emit({ t: 1_000_000, app, windows: [{ tree: { r: 'AXTable', c: ['p-huddle_grid_component'], k: [tile] } }] })
    // the huddle's window closed, the huddle going on: the helper says hidden
    for (let t = 1_000_500; t <= 1_030_000; t += 500) { s.at(t); s.emit({ t, error: 'no-call-window (Slack: in a huddle, no participant grid)', hidden: true }) }
    expect(s.hook.callWindow(s.m.id)).toEqual({ goneMs: 0 })
    // left: neither grid nor bar
    for (let t = 1_030_500; t <= 1_038_500; t += 500) { s.at(t); s.emit({ t, error: 'no-call-window (Slack: no huddle in a window)' }) }
    expect(s.hook.callWindow(s.m.id)).toEqual({ goneMs: 8_000 })
    expect(s.logs).toContain('call names: the slack call window went away')
  })
  it('a Meet tab is not followed: switching tabs hides the call from the reader, and the browser lets go of the mic as soon as the call ends', () => {
    const s = setup({ app: 'Chrome' })
    s.start()
    s.at(1_000_000); s.emit({ t: 1_000_000, app: 'com.google.Chrome', windows: [{ title: 'Meet - abc-defg-hij', tree: { r: 'AXWindow', k: [] } }] })
    for (let t = 1_000_500; t <= 1_060_000; t += 500) { s.at(t); s.emit({ t, app: 'com.google.Chrome', error: 'no-call-window' }) }
    expect(s.hook.callWindow(s.m.id)).toBeNull()
  })
})
