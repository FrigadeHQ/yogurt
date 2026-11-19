import type { RecordingStart } from '../meeting'
import type { Meeting, Store } from '../store'
import { nameFor, norm, othersIn, type CallSample } from './attribute'
import { readCall, summarize, type AxWindow, type CallKind } from './parse'

/**
 * Names from the call: while a meeting records, the call app it is in (Zoom, Teams, Meet in a browser) is read through
 * the accessibility tree about twice a second (macOS Accessibility, AT-SPI on Linux, UI Automation on Windows), and each line of the other side
 * is named after the person the app shows talking, or the only other person in the call. The mic is always You.
 * Without the permission, in another app, or when the app shows nothing clear, lines of the other side are Them.
 * Nothing is guessed, and nothing leaves the computer.
 */

/** what yogurt-mac call-watch prints each time it reads: the call windows, or why it could not */
/** macWindows: how many normal windows of the app the Mac itself shows, beside the ones accessibility lists (#138) */
/** hidden: no call window accessibility can see, but the Mac still has the one that was the call (another desktop, a full
 * screen Space): the call is not over */
export type WatchLine = { t: number; app?: string; windows?: AxWindow[]; error?: string; macWindows?: number; hidden?: boolean }
/** pids: read only these processes' windows (the call app's processes on the mic); none known, the app's frontmost with a call */
export type Watch = (ids: string[], onLine: (l: WatchLine) => void, pids?: number[]) => { stop(): void }

/** the call apps that can be read, by the name meeting detection gives them (detect.ts), and the kind of window each
 * has. A Mac's ids are bundle ids; Linux's are program names or Flatpak app ids; Windows's are program file names,
 * lowercased (detect.ts). Webex's Windows window isn't read yet: its lines stay Them there. */
const APPS: Record<string, { kind: CallKind; ids: string[] }> = {
  Zoom: { kind: 'zoom', ids: ['us.zoom.xos', 'zoom', 'us.zoom.Zoom', 'zoom.exe'] },
  Teams: { kind: 'teams', ids: ['com.microsoft.teams2', 'com.microsoft.teams', 'teams-for-linux', 'com.github.IsmaelMartinez.teams_for_linux', 'ms-teams.exe', 'teams.exe'] },
  Webex: { kind: 'webex', ids: ['Cisco-Systems.Spark', 'com.cisco.webexmeetingsapp'] },
  Chrome: { kind: 'meet', ids: ['com.google.Chrome', 'chrome', 'google-chrome', 'chrome.exe'] },
  Arc: { kind: 'meet', ids: ['company.thebrowser.Browser', 'arc.exe'] },
  Ardia: { kind: 'meet', ids: ['com.ardia.browser'] },
  Dia: { kind: 'meet', ids: ['company.thebrowser.dia'] },
  Brave: { kind: 'meet', ids: ['com.brave.Browser', 'brave', 'brave.exe'] },
  Edge: { kind: 'meet', ids: ['com.microsoft.edgemac', 'msedge', 'com.microsoft.Edge', 'msedge.exe'] },
  Safari: { kind: 'meet', ids: ['com.apple.Safari'] },
  Firefox: { kind: 'meet', ids: ['org.mozilla.firefox', 'firefox', 'firefox-bin', 'firefox.exe'] },
}
/** The apps to read for a meeting: the one it was detected in; with none (started by hand) any of them, the frontmost with a call first */
export const watchIds = (app: string | null): string[] => (app ? APPS[app]?.ids ?? [] : Object.values(APPS).flatMap((a) => a.ids))
const kindOf = (bundleId: string): CallKind | null => Object.values(APPS).find((a) => a.ids.includes(bundleId))?.kind ?? null
/**
 * The reader for a reading. The program's own kind; else the call's app (#83: the Teams desktop app's window can come
 * from its web view, a program not on the list, and was dropped). A browser showing Teams is read as Teams, not Meet.
 */
export function kindFor(appId: string, windows: Array<{ title?: string }>, callApp: string | null): CallKind | null {
  const kind = kindOf(appId) ?? (callApp ? APPS[callApp]?.kind ?? null : null)
  if (kind === 'meet' && windows.some((w) => /\bMicrosoft Teams\b|\|\s*Teams\b/i.test(w.title ?? ''))) return 'teams'
  return kind
}

/** how often the app is read */
export const WATCH_EVERY_MS = 400
/** the apps mark the person talking about this late (Zoom: about 0.75 to 1.2 s after they start) */
const APP_LAG_MS = 750
/** no reading for this long while recording: the reader is stuck (seen once, 11 minutes of Them), so it starts again.
 * A slow window gets longer: three times the reader's own pace, and twice as long after each start, since the reader
 * waits as long as a reading took and a fresh one killed at 5 s never sends one (#83: a Teams reading took 10 s). */
export const QUIET_MS = 5000
const MAX_QUIET_MS = 60_000
/** how far back the people seen count for the call's size (see onLine) */
const RECENT_MS = 60_000
/** at most this many fresh starts per meeting, so an app that never answers can't start readers forever */
const MAX_RESTARTS = 20
/** changes of who talks written to the log, per meeting (enough to check a real call, never a flood) */
const LOGGED_CHANGES = 30

type Sample = Omit<CallSample, 'ms'> & { t: number }
type Session = { app: string | null; ids: string[]; pids?: number[]; heardAt: number; quietMs: number; restarts: number; samples: Sample[]; priorLines: Set<number>; watch?: { stop(): void }; everyApp: boolean; offset?: number; startedAt: number; pictured: boolean; missPictured?: boolean; picturedPeople?: boolean; picturedTalking?: boolean; errors: Set<string>; last: string; logged: number; /** a call window with people was read (Zoom, Teams) */ windowSeen?: CallKind; /** since when the readings say that window is gone, and the last one that said so */ goneSince?: number; goneAt?: number }

export function hookCallNames(p: {
  store: Pick<Store, 'meeting' | 'segments' | 'setSegmentSpeakers' | 'updateMeeting'>
  watch: Watch
  /** the person's own names (Settings, the Mac's full name): never given to the other side */
  myNames: () => string[]
  /** the meeting's transcript is all saved */
  transcribed: (id: string) => Promise<void>
  /** lines got their names after the meeting: the window reads them again */
  changed: (id: string) => void
  onStart: (fn: (m: RecordingStart) => void) => unknown
  onStop: (fn: (m: Meeting) => void) => unknown
  onCapture: (fn: (c: { on(e: 'pcm', fn: (track: 'me' | 'them', ms: number, samples: Float32Array) => void): unknown }, meetingId: string) => void) => unknown
  /** the processes of a call app on the mic now (detect.ts micPids): two Zoom meetings are two processes (#98) */
  micPids?: (app: string) => number[]
  /** a recording started by hand learned its call app from the mic (watch.ts, CALL bind) */
  onBind?: (fn: (m: Meeting) => void) => unknown
  log?: (msg: string) => void
  now?: () => number
  /** how the quiet check runs (every 2 s; tests call checkQuiet themselves) */
  every?: (fn: () => void, ms: number) => unknown
}) {
  // info, not log: main.log keeps info, warn and error, and these lines are how a call that stayed Them gets explained
  const log = p.log ?? ((s: string) => console.info(s))
  const now = p.now ?? Date.now
  const sessions = new Map<string, Session>()
  const finals = new Map<string, Promise<void>>()

  /** the readings in meeting time: the wall clock less when meeting time 0 was heard, less the app's lag */
  const timeline = (s: Session): CallSample[] => {
    const zero = s.offset ?? s.startedAt
    return s.samples.map(({ t, ...r }) => ({ ...r, ms: t - zero - APP_LAG_MS }))
  }

  /** the call window was read again after the readings said it was gone */
  const windowBack = (s: Session) => {
    if (s.goneSince !== undefined) log(`call names: the ${s.windowSeen} call window is back after ${Math.round((now() - s.goneSince) / 1000)} s`)
    s.goneSince = undefined; s.goneAt = undefined
  }

  const onLine = (id: string, s: Session, l: WatchLine) => {
    s.quietMs = Math.min(MAX_QUIET_MS, Math.max(QUIET_MS, 3 * (now() - s.heardAt)))
    s.heardAt = now()
    if (l.error || !l.app || !l.windows) {
      // the call window gone: the reader looked and found none (or the app quit). Anything else (no permission, a slow
      // window) says nothing either way.
      const gone = !!l.error && (l.error.startsWith('no-call-window') || l.error === 'not-running')
      if (gone && l.hidden) {
        if (!s.errors.has('hidden')) { s.errors.add('hidden'); log('call names: the call window is out of sight (another desktop or full screen), not closed') }
        windowBack(s)
      }
      else if (gone && s.windowSeen) {
        if (s.goneSince === undefined) { s.goneSince = now(); log(`call names: the ${s.windowSeen} call window went away`) }
        s.goneAt = now()
      } else { s.goneSince = undefined; s.goneAt = undefined }
      const why = l.error ?? 'nothing read'
      if (!s.errors.has(why)) { s.errors.add(why); log(`call names: ${why}${why === 'not-trusted' ? ' (no Accessibility permission): the other side stays Them' : ''}`) }
      // a call app with no call window sends its windows once, so the log shows what it gives when a call is missed (#138)
      if (l.app && l.windows && !s.missPictured) { s.missPictured = true; log(`call names: no call window in ${l.app}${l.macWindows === undefined ? '' : ` (the Mac shows ${l.macWindows} of its windows)`}, its windows in short:\n${summarize(l.windows)}`) }
      s.samples.push({ t: l.t, speaking: [], participants: [], me: null, ok: false })
      return
    }
    const kind = kindFor(l.app, l.windows, s.app)
    if (!kind) {
      const why = `${l.app} is not a call app Yogurt reads`
      if (!s.errors.has(why)) { s.errors.add(why); log(`call names: ${why}`) }
      return
    }
    const { byMute, ...r } = readCall(kind, l.windows)
    // The first reading of each meeting goes to the log in short, so a real call shows what its app gives. Teams opens
    // the mic on its join screen, minutes before the call (#138), so the first reading with people in it goes there too.
    // Meet's lobby shows people too (#112), so the first reading with someone marked talking goes there as well, long
    // enough to reach the tiles past the browser's own buttons: it shows where the marks sit.
    const people = r.participants.length > 0
    const talking = r.speaking.length > 0
    if (!s.pictured || (people && !s.picturedPeople) || (talking && !s.picturedTalking)) {
      s.pictured = true; s.picturedPeople ||= people
      if (talking) s.picturedTalking = true
      log(`call names: reading ${l.app} (${kind}), its window in short:\n${summarize(l.windows, talking ? 200 : 60)}`)
    }
    // A stage can show fewer people than are in the call (a screen share, another layout: #83 went "0 of 13", "0 of 2").
    // The most seen in the last minute stands for the call, so me and one other is no call of two, and who is muted
    // names nobody while someone may be hidden.
    const most = Math.max(r.participants.length, ...s.samples.filter((x) => x.ok !== false && l.t - x.t <= RECENT_MS).map((x) => x.participants.length))
    if (byMute && most > r.participants.length) r.speaking = []
    s.samples.push({ t: l.t, ...r, most })
    // Zoom's meeting window and Teams' Leave button are there only during a call. A Meet tab is not followed: switching
    // tabs hides it from the reader, and the browser lets go of the mic as soon as its call ends.
    if (kind === 'zoom' || kind === 'teams') {
      if (r.participants.length) s.windowSeen ??= kind
      windowBack(s)
    }
    // counts only: main.log is pasted into public issues, and names belong to the people in the call
    const said = `${r.speaking.length} of ${r.participants.length}${r.me ? ', me known' : ''}`
    if (said !== s.last && s.logged < LOGGED_CHANGES) { s.logged++; log(`call names: ${kind} talking ${said}`) }
    s.last = said
  }

  /** Starts the session's reader. With its app's process on the mic known, only that one is read: another meeting open
   * in the same app (a second Zoom process) never gives this one its names or people (#98). */
  const begin = (id: string, s: Session) => {
    const pids = s.pids ?? (s.app ? p.micPids?.(s.app) : undefined)
    s.pids = pids?.length ? pids : undefined
    try { s.watch = p.watch(s.ids, (l) => onLine(id, s, l), s.pids) } catch (e) { console.error('call names: the watch did not start', e) }
  }

  p.onStart((m) => {
    const ids = watchIds(m.app)
    const s: Session = { app: m.app, ids, heardAt: now(), quietMs: QUIET_MS, restarts: 0, everyApp: !m.app, samples: [], priorLines: new Set(p.store.segments(m.id, { hidden: true }).map((line) => line.id)), startedAt: m.resume ? m.resume.startedAt - m.resume.startMs : m.startedAt, pictured: false, errors: new Set(), last: '', logged: 0 }
    sessions.set(m.id, s)
    if (!ids.length) { log(`call names: ${m.app} can't be read, the other side is Them`); return }
    begin(m.id, s)
  })

  // A recording started by hand reads every call app, the frontmost with a call first; another app's window (a Teams
  // chat) can win that. Once the mic says which app the call is in, only that one is read.
  p.onBind?.((m) => {
    const s = sessions.get(m.id)
    if (!s || !s.everyApp || !m.app) return
    s.everyApp = false
    s.app = m.app
    s.watch?.stop(); s.watch = undefined
    const ids = watchIds(m.app)
    s.ids = ids; s.heardAt = now()
    // a window read before may have been another app's
    s.windowSeen = undefined; s.goneSince = undefined; s.goneAt = undefined
    log(`call names: the call is in ${m.app}, reading only it`)
    if (!ids.length) return
    // the log says again what the call's own app shows, even when it reads as what the last app did (#83)
    s.pictured = false; s.picturedPeople = false; s.picturedTalking = false; s.last = ''
    begin(m.id, s)
  })

  // meeting time 0 on the wall clock: the earliest any audio could have been heard (each frame arrives a little after it was said)
  p.onCapture((c, id) => {
    c.on('pcm', (_track, ms, samples) => {
      const s = sessions.get(id)
      if (!s) return
      const zero = now() - (ms + samples.length / 16)
      s.offset = Math.min(s.offset ?? Infinity, zero)
    })
  })

  p.onStop((m) => {
    const s = sessions.get(m.id)
    if (!s) return
    s.watch?.stop(); s.watch = undefined
    const final = (async () => {
      await p.transcribed(m.id)
      const tl = timeline(s)
      const o = { myNames: p.myNames() }
      // every line of the other side again, now that the whole call is known
      const lines = p.store.segments(m.id, { hidden: true }).filter((x) => x.track === 'them' && !s.priorLines.has(x.id))
      const names = lines.map((x) => ({ id: x.id, speaker: nameFor(x, tl, o) }))
      const moved = names.filter((x, i) => x.speaker !== lines[i].speaker)
      if (moved.length) p.store.setSegmentSpeakers(moved)
      // everyone seen in the call is one of the people at the meeting
      const cur = p.store.meeting(m.id)
      // the same name the calendar already gave: "Okafor, Riley" from Exchange is the "Riley Okafor" the call shows
      const known = new Set(cur?.attendees.map((a) => norm(a.name)) ?? [])
      const added = othersIn(tl, o).filter((n) => !known.has(norm(n)))
      if (cur && added.length) p.store.updateMeeting(m.id, { attendees: [...cur.attendees, ...added.map((name) => ({ name, email: null }))] })
      log(`call names: ${s.samples.length} readings, ${names.filter((x) => x.speaker).length} of ${lines.length} lines of the other side named, ${added.length} people added`)
      if (moved.length || added.length) p.changed(m.id)
    })().catch((e) => console.error('call names after the meeting failed', e)).finally(() => { sessions.delete(m.id); finals.delete(m.id) })
    finals.set(m.id, final)
  })

  /** a reader that stopped sending readings is stopped and started again (the cause is logged where it's known) */
  function checkQuiet() {
    for (const [id, s] of sessions) {
      // the app came on the mic after the reader started: from now on only that process, and what was read before
      // may be another meeting's (#98)
      if (s.watch && s.app && !s.pids && p.micPids?.(s.app).length) {
        log(`call names: ${s.app} is on the mic now, reading only its process`)
        s.watch.stop(); s.watch = undefined
        s.samples = []; s.heardAt = now(); s.pictured = false; s.picturedPeople = false; s.picturedTalking = false
        s.windowSeen = undefined; s.goneSince = undefined; s.goneAt = undefined
        begin(id, s)
        continue
      }
      if (!s.watch || !s.ids.length || now() - s.heardAt <= s.quietMs || s.restarts >= MAX_RESTARTS) continue
      log(`call names: the reader went quiet for ${Math.round((now() - s.heardAt) / 1000)} s; starting it again`)
      s.restarts++
      s.quietMs = Math.min(MAX_QUIET_MS, s.quietMs * 2)
      s.watch.stop(); s.watch = undefined
      s.heardAt = now()
      begin(id, s)
    }
  }
  ;(p.every ?? ((fn, ms) => setInterval(fn, ms).unref()))(checkQuiet, 2000)

  return {
    checkQuiet,
    /** the name for a line of the other side just heard, or null for Them */
    nameFor(meetingId: string, startMs: number, endMs: number): string | null {
      const s = sessions.get(meetingId)
      return s?.samples.length ? nameFor({ startMs, endMs }, timeline(s), { myNames: p.myNames() }) : null
    },
    /**
     * The meeting's call window (watch.ts ends the call when it has been gone a while): null until one with people was
     * read; goneMs 0 while it is there, hidden, or the reader has said nothing lately (no evidence is not gone).
     */
    callWindow(meetingId: string): { goneMs: number } | null {
      const s = sessions.get(meetingId)
      if (!s?.windowSeen) return null
      const fresh = s.goneSince !== undefined && s.goneAt !== undefined && now() - s.goneAt <= s.quietMs
      return { goneMs: fresh ? now() - s.goneSince! : 0 }
    },
    /** resolves when the names after the meeting are in */
    finished: (id: string): Promise<void> => finals.get(id) ?? Promise.resolve(),
  }
}
export type CallNames = ReturnType<typeof hookCallNames>
