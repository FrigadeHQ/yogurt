import type { Meeting } from './store'
import { callAppName, callGone, decide, ended, type Prompt, type Signals } from './detect'
import type { Reading } from './detectSignals'

/** Everything the watcher needs from outside, so tests and fake mode can stand in */
export type WatchDeps = {
  read(now: number): Promise<Reading>
  now(): number
  active(): Meeting | null
  bindApp(id: string, app: string): Meeting | undefined
  /** offer to take notes */
  offer(p: Prompt): void
  /** the first run is set up (onboarding done): until then no call is offered, the mic and models may not be ready */
  ready?(): boolean
  /** ask whether to stop */
  askStop(m: Meeting): void
  /** take down whichever card is up */
  hide(): void
  /** ms both tracks have been quiet; capture plugs in later (0 until then) */
  silentMs?(): number
  /** stop the recording because its call ended (no question asked) */
  autoStop?(m: Meeting): void
  /** the "Stop recording when the call ends" setting; off or missing: ask instead */
  autoStopOn?(): boolean
  /** how long the call must be gone (CALL_GONE_MS unless fake mode says) */
  graceMs?: number
}

const SNOOZE = 5 * 60_000

/** Looks at the signals each tick: offers notes when a call starts; when it ends, stops the recording (or asks, with that setting off). Never starts anything itself. */
/** how long a call app must be off the mic before its call is over and the next one is offered again */
export const NEW_CALL_MS = 2 * 60_000

export class Watcher {
  readonly dismissed = new Set<string>()
  private shown: string | null = null // key of the start card, or 'stop'
  private busy = false
  private rec: { id: string; lastMic: number; snoozeUntil: number; /** the call app was on the mic during this recording */ seen: boolean; stopped: boolean; /** started without a call app (New note, the agenda): never stopped by itself */ byHand: boolean } | null = null

  /** call apps on the mic at the last look before recording: a recording started from the card belongs to that call */
  private idleMic = new Set<string>()
  private idleCall: { app: string; at: number } | null = null
  /** a recording was going at the last look */
  private wasRecording = false
  /**
   * The calls already offered, by app, with when the app last held the mic. Zoom lets go of the mic for a moment when a
   * headset changes or someone toggles mute, and the calendar event can end while the call goes on: none of that is a
   * new call. A call is over only after NEW_CALL_MS off the mic, so each call gets one offer, never a stream of them.
   */
  private calls = new Map<string, { last: number; key: string; at: number }>()
  private shownApp: string | null = null

  constructor(private d: WatchDeps) {}

  /** recordings started with Join and record: plainly a call, so it may stop by itself once that call has ended (#100) */
  private joins = new Set<string>()
  joined(meetingId: string) { this.joins.add(meetingId) }
  /** the person closed the start card */
  dismiss(key: string) { this.dismissed.add(key); this.shown = null }
  /** "Keep going": ask again in a while, not every tick */
  keepGoing() { if (this.rec) this.rec.snoozeUntil = this.d.now() + SNOOZE; this.shown = null }
  /** Close: no more stop questions during this recording. */
  dismissStop() { if (this.rec) this.rec.snoozeUntil = Infinity; this.shown = null }
  /** the card went away by an action, or a recording started or stopped (a resumed note is watched afresh) */
  cleared() { this.shown = null; this.rec = null }

  /** someone is on a call now: recording, or a call app on the mic (card closed or never clicked) */
  onCall(): boolean { return !!this.d.active() || this.idleMic.size > 0 }

  async tick(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      const now = this.d.now()
      const reading = await this.d.read(now)
      const rec = this.d.active()
      const s: Signals = { ...reading, recording: !!rec }
      if (rec) this.recording(rec, s, now)
      else this.idle(s, now, this.wasRecording)
      this.wasRecording = !!rec
    } finally { this.busy = false }
  }

  private idle(s: Signals, now: number, justStopped = false) {
    this.rec = null
    // the recording just ended while its call app still holds the mic (Finish in Yogurt, then Zoom closes a few seconds
    // later): that call is done, as if its card were closed. It is forgiven once the app lets go of the mic, as below.
    // A recording ending closes its call: once the app lets go of the mic, the next call is new (back-to-back meetings)
    if (justStopped) this.calls.clear()
    if (justStopped) for (let p = decide(s, now, this.dismissed); p; p = decide(s, now, this.dismissed)) this.dismissed.add(p.key)
    this.idleMic = new Set(s.micApps.flatMap((m) => callAppName(m.bundleId, s.runningApps) ?? []))
    const call = decide(s, now, new Set())
    this.idleCall = call?.app ? { app: call.app, at: now } : null
    for (const a of this.idleMic) { const c = this.calls.get(a); if (c) c.last = now }
    for (const [a, c] of this.calls) if (now - c.last >= NEW_CALL_MS) this.calls.delete(a)
    // a call app whose call is over (off the mic long enough) is a new call next time
    for (const k of [...this.dismissed]) {
      const app = k.startsWith('app:') ? callAppName(k.slice(4)) : undefined
      if (app !== undefined && !this.idleMic.has(app ?? '') && !this.calls.has(app ?? '')) this.dismissed.delete(k)
    }
    let p = this.d.ready && !this.d.ready() ? null : decide(s, now, this.dismissed)
    // this call was offered already: under another key (its event ended) or after a moment off the mic. A different
    // calendar meeting that starts after that offer is the next meeting, though: it gets its own.
    const before = p && this.calls.get(p.app ?? p.key)
    if (p && before && this.shown !== p.key && !(p.event && p.key !== before.key && p.event.start > before.at)) p = null
    if (!p) {
      // a card stays up through a blip; it goes when its call is over
      if (this.shown && !(this.shownApp && this.calls.has(this.shownApp))) { this.shown = null; this.shownApp = null; this.d.hide() }
      return
    }
    if (this.shown === p.key) return
    this.shown = p.key
    this.shownApp = p.app ?? p.key
    this.calls.set(p.app ?? p.key, { last: now, key: p.key, at: now })
    console.info(`CALL offer app=${p.app} mic=${s.micApps.filter(m => callAppName(m.bundleId, s.runningApps) === p.app).map(m => m.bundleId).join(',')}`)
    this.d.offer(p)
  }

  private recording(m: Meeting, s: Signals, now: number) {
    const starting = this.rec?.id !== m.id
    // started by hand (no call app yet: New note, the agenda): never stopped by itself, only asked about. Join and record
    // starts with no app too, but it is a call: like a card start it stops once its call app was on the mic and has gone
    const byHand = starting ? !m.app && !this.joins.has(m.id) : this.rec!.byHand
    const recent = starting && this.idleCall && now - this.idleCall.at <= 6000 ? this.idleCall.app : null
    const observed = decide({ ...s, recording: false }, now, new Set())?.app ?? null
    if (!m.app && (observed || recent)) {
      m = this.d.bindApp(m.id, (observed || recent)!) ?? m
      if (m.app) console.info(`CALL bind meeting=${m.id} app=${m.app} via=${observed ? 'mic' : 'recent-mic'}`)
    } else if (starting) console.info(`CALL watch meeting=${m.id} app=${m.app ?? 'none'}`)
    if (starting) {
      this.rec = { id: m.id, lastMic: now, snoozeUntil: 0, seen: !!m.app && this.idleMic.has(m.app), stopped: false, byHand }
      this.idleCall = null; this.idleMic.clear()
      if (this.shown !== 'stop') this.shown = null
    }
    const r = this.rec!
    if (r.stopped) return
    const onMic = !!m.app && s.micApps.some((a) => { const n = callAppName(a.bundleId, s.runningApps); return n && n === m.app })
    if (onMic) r.seen = true
    // Without a bound call app there is no mic-loss evidence to ask about.
    const using = !m.app || onMic
    if (using) r.lastMic = now
    const silentMs = this.d.silentMs?.() ?? 0
    if (!r.byHand && this.d.autoStop && this.d.autoStopOn?.() && callGone({ app: m.app, seen: r.seen, micIdleMs: now - r.lastMic, silentMs, graceMs: this.d.graceMs })) {
      console.info(`CALL gone meeting=${m.id} app=${m.app} idle_ms=${now - r.lastMic} silent_ms=${silentMs}`)
      r.stopped = true
      if (this.shown === 'stop') { this.shown = null; this.d.hide() }
      this.d.autoStop(m)
      return
    }
    const over = ended(now - r.lastMic, silentMs)
    if (over && this.shown !== 'stop' && now >= r.snoozeUntil) {
      console.info(`CALL stop-card meeting=${m.id} app=${m.app ?? 'none'} reason=mic-idle-and-silent idle_ms=${now - r.lastMic} silent_ms=${silentMs}`)
      this.shown = 'stop'; this.d.askStop(m)
    }
    else if (!over && this.shown === 'stop') { this.shown = null; this.d.hide() }
  }
}
