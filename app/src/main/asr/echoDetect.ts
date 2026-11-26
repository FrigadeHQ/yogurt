import type { Track } from '../capture'
import type { Moment } from './echo'

/**
 * Is the other side's voice reaching the mic (no headphones)? Decided from the audio, not the words: the mic's loudness
 * envelope is compared with the system track's over 2 s windows while both carry sound; their voice from the speakers
 * makes the two move together, a little late, at the same lag every time. Two people talking over each other correlate
 * now and then, at random lags; so echo is a rate (a good share of the active windows) at a steady lag, never a count.
 * Without this evidence no line is ever hidden as an echo: with headphones a short reply that repeats their words is the
 * person's own.
 *
 * Once the room's lag is known, each mic line is also judged on its own span (`over`): the windows have holes (their
 * voice for a moment in an otherwise quiet 2 s), and the leak's level on the mic tells the person's own voice apart
 * from their copy. The envelopes of the last two hours are kept (10 ms blocks, 2.9 MB a track) and every verdict given
 * is remembered, so the sweep after the meeting gets the same answers for lines judged live.
 *
 * The two tracks can also sit apart on meeting time: the mic's audio stamped late, by far more than a room delays a
 * voice (#181: 830 ms on built-in speakers, the same from the first minute to the last). A window that follows at none
 * of the room's lags is then looked at further out, and the tracks are taken as apart only where a good share of the
 * active windows agree on one lag. From then on the meeting is judged at that lag.
 */
const BLOCK_MS = 10
const WINDOW_BLOCKS = 200
const WINDOW_MS = WINDOW_BLOCKS * BLOCK_MS
const MAX_LAG_BLOCKS = 30
/**
 * how far apart the tracks are looked for (2 s). Over so many lags two people talking over each other correlate by
 * chance far more often, so these windows are no evidence by their number: only at one steady lag (see offset)
 */
const FAR_LAG_BLOCKS = 200
/** two hours of envelope; a line is judged within seconds of being said and its verdict kept */
const RING_BLOCKS = 2 * 3600 * 100
/** them is talking in a window from this mean level up; the mic shows something from this up */
const THEM_LOUD = 0.004
const ME_SOME = 0.0006
const CORRELATED = 0.6
/**
 * evidence: at least this many windows with both sides active, and either most of them correlated (a room has more than
 * one path from the speakers to the mic, so the lag can split in two), or a good share of them at one steady lag
 */
const MIN_ACTIVE = 10
const MIN_RATE = 0.4
const MIN_STEADY = 0.7
const STRONG_RATE = 0.55
/** a line is judged on its own audio only with this much of their speech inside it (blocks of 10 ms) */
const LINE_MIN_SPEAKING = 20
/** a lag behind this share of the correlated windows is one the room has (a second path from the speakers) */
const KNOWN_LAG_SHARE = 0.2
const LAG_SLACK = 2
/** the mic over the whole line may be this many times the leak's usual level and still be judged by the words */
const LOUD_RATIO = 2
/** nothing on the mic but their voice: it follows their track closely, at the leak's level, over a good part of the line */
const PURE_CORR = 0.8
const PURE_RATIO = 1.5
const PURE_COVER = 0.4

export class EchoDetector {
  private env: Record<Track, Float32Array> = { me: new Float32Array(RING_BLOCKS), them: new Float32Array(RING_BLOCKS) }
  private latest: Record<Track, number> = { me: -1, them: -1 }
  private nextCheck = WINDOW_BLOCKS
  /** windows where both sides carried sound */
  active = 0
  /** of those, the windows where the mic followed the system track: at what lag (blocks), and how loud the mic was next to their track */
  private lags: number[] = []
  private ratios: number[] = []
  private correlated = new Set<number>()
  /** active windows where the mic followed at none of the room's lags, still to be looked at further out */
  private open = new Set<number>()
  private nextFar = WINDOW_BLOCKS
  /** of those, the windows where the mic followed their track later than any room would: at what lag, and how loud */
  private far = new Map<number, { lag: number; ratio: number }>()
  /** the lag the tracks sit apart at (blocks; 0: together), worked out again once a window is counted */
  private apart: number | undefined = 0
  /** the lag the remembered verdicts were given at */
  private judgedAt = 0
  /** every span judged, by `start:end`: the sweep after the meeting asks about lines whose audio may be gone */
  private verdicts = new Map<string, Moment>()
  /** long lines copied almost word for word, found by the words (echo.ts); counted, but no evidence on their own */
  verbatim = 0

  get windows(): number { return this.lags.length }

  push(track: Track, ms: number, samples: Float32Array) {
    const first = Math.floor(ms / BLOCK_MS)
    const per = 16 * BLOCK_MS
    // a jump forward (a pause, a restart) leaves blocks from two hours ago in the ring: they are silence now
    if (first > this.latest[track] + 1) for (let i = Math.max(this.latest[track] + 1, first - RING_BLOCKS); i < first; i++) this.env[track][i % RING_BLOCKS] = 0
    for (let b = 0; b * per < samples.length; b++) {
      let s = 0
      const from = b * per, to = Math.min(samples.length, from + per)
      for (let i = from; i < to; i++) s += samples[i] * samples[i]
      const idx = first + b
      if (idx < 0) continue
      this.env[track][idx % RING_BLOCKS] = Math.sqrt(s / Math.max(1, to - from))
      if (idx > this.latest[track]) this.latest[track] = idx
    }
    // a window is looked at once both tracks have reached past it (the mic's lagged blocks included); a gap in either
    // track (a pause, a restart) lets the window go unchecked rather than hold every later one
    for (;;) {
      const ready = this.latest.them >= this.nextCheck - 1 && this.latest.me >= this.nextCheck + MAX_LAG_BLOCKS - 1
      if (ready) { this.check(this.nextCheck - WINDOW_BLOCKS, this.nextCheck); this.nextCheck += WINDOW_BLOCKS; continue }
      if (this.latest.them > this.nextCheck + 2 * WINDOW_BLOCKS) { this.nextCheck += WINDOW_BLOCKS; continue }
      break
    }
    // the same windows again once the mic has reached 2 s past them, for the ones that followed at no lag a room has
    for (;;) {
      const ready = this.nextFar < this.nextCheck && this.latest.me >= this.nextFar + FAR_LAG_BLOCKS - 1
      if (ready) { this.checkFar(this.nextFar - WINDOW_BLOCKS, this.nextFar); this.nextFar += WINDOW_BLOCKS; continue }
      if (this.latest.them > this.nextFar + 3 * WINDOW_BLOCKS) { this.open.delete(this.nextFar / WINDOW_BLOCKS - 1); this.nextFar += WINDOW_BLOCKS; continue }
      break
    }
  }

  /** still in the ring: recorded, and within the last two hours */
  private inRing(track: Track, idx: number): boolean { return idx >= 0 && idx <= this.latest[track] && idx > this.latest[track] - RING_BLOCKS }
  /** a block nobody recorded (before the first sound, a pause, after the latest) is silence */
  private at(track: Track, idx: number): number { return this.inRing(track, idx) ? this.env[track][idx % RING_BLOCKS] : 0 }

  /** one 2 s window of their track against the mic's, at lags of 0 to 300 ms */
  private check(from: number, to: number) {
    const them: number[] = [], me: number[][] = Array.from({ length: MAX_LAG_BLOCKS + 1 }, () => [])
    for (let i = from; i < to; i++) {
      them.push(this.at('them', i))
      for (let lag = 0; lag <= MAX_LAG_BLOCKS; lag++) me[lag].push(this.at('me', i + lag))
    }
    if (mean(them) < THEM_LOUD || mean(me[0]) < ME_SOME) return
    this.active++
    this.apart = undefined
    // only the moments they are speaking count: the person's own words in the same window would drown a faint leak
    const speaking = them.map((v) => v >= THEM_LOUD)
    const pick = (xs: number[]) => xs.filter((_, i) => speaking[i])
    const t = pick(them)
    if (t.length < 20) return
    let best = 0, bestLag = 0
    for (let lag = 0; lag <= MAX_LAG_BLOCKS; lag++) { const c = pearson(t, pick(me[lag])); if (c > best) { best = c; bestLag = lag } }
    if (best >= CORRELATED) { this.lags.push(bestLag); this.ratios.push(mean(pick(me[bestLag])) / mean(t)); this.correlated.add(Math.floor(from / WINDOW_BLOCKS)) }
    else this.open.add(Math.floor(from / WINDOW_BLOCKS))
  }

  /** a window that followed at none of the room's lags, against the mic from 310 ms to 2 s later */
  private checkFar(from: number, to: number) {
    const w = Math.floor(from / WINDOW_BLOCKS)
    if (!this.open.delete(w)) return
    const speaking: number[] = []
    for (let i = from; i < to; i++) if (this.at('them', i) >= THEM_LOUD) speaking.push(i)
    const t = speaking.map((i) => this.at('them', i))
    let best = 0, bestLag = 0
    for (let lag = MAX_LAG_BLOCKS + 1; lag <= FAR_LAG_BLOCKS; lag++) { const c = pearson(t, speaking.map((i) => this.at('me', i + lag))); if (c > best) { best = c; bestLag = lag } }
    if (best >= CORRELATED) { this.far.set(w, { lag: bestLag, ratio: mean(speaking.map((i) => this.at('me', i + bestLag))) / mean(t) }); this.apart = undefined }
  }

  /**
   * The lag the two tracks sit apart at (blocks), 0 when they are together: a good share of the active windows followed
   * later than any room would, and nearly all of those at the same lag. Never by their number alone, as the room's own
   * lags can be (STRONG_RATE): over 2 s of lags, chance alone gives many windows a lag, each a different one.
   */
  private offset(): number {
    if (this.apart !== undefined) return this.apart
    this.apart = 0
    if (this.active < MIN_ACTIVE || this.far.size / this.active < MIN_RATE) return 0
    const count = new Map<number, number>()
    for (const f of this.far.values()) count.set(f.lag, (count.get(f.lag) ?? 0) + 1)
    const mode = [...count.entries()].sort((a, b) => b[1] - a[1])[0][0]
    const steady = [...this.far.values()].filter((f) => Math.abs(f.lag - mode) <= 1).length
    if (steady / this.far.size >= MIN_STEADY && steady / this.active >= MIN_RATE) this.apart = mode
    // lines judged before the tracks were known to be apart were set against the wrong moment of theirs: asked again
    if (this.apart !== this.judgedAt) { this.verdicts.clear(); this.judgedAt = this.apart }
    return this.apart
  }
  /** how far the mic's track sits behind theirs on meeting time (ms); 0: together. A mic line is a copy of what they said this much earlier */
  offsetMs(): number { return this.offset() * BLOCK_MS }
  /** the windows that followed at the lag the tracks sit apart at */
  private apartWindows(): Array<{ lag: number; ratio: number }> { const off = this.offset(); return off ? [...this.far.values()].filter((f) => Math.abs(f.lag - off) <= 1) : [] }

  /** a line of theirs found copied almost word for word on the mic (kept for the record; the audio decides) */
  noteVerbatim() { this.verbatim++ }

  /** echo has been heard in this meeting: a steady share of the active windows, at one lag */
  present(): boolean {
    if (this.offset()) return true
    if (this.active < MIN_ACTIVE || this.lags.length / this.active < MIN_RATE) return false
    if (this.lags.length / this.active >= STRONG_RATE) return true
    const count = new Map<number, number>()
    for (const l of this.lags) count.set(l, (count.get(l) ?? 0) + 1)
    const mode = [...count.entries()].sort((a, b) => b[1] - a[1])[0][0]
    const steady = this.lags.filter((l) => Math.abs(l - mode) <= 1).length
    return steady / this.lags.length >= MIN_STEADY
  }

  /** the mic followed the system track in the window holding this moment (tracks apart: the window of theirs this moment on the mic is a copy of) */
  correlatedAt(ms: number): boolean {
    const off = this.offset()
    if (!off) return this.correlated.has(Math.floor(ms / WINDOW_MS))
    const f = this.far.get(Math.floor((ms - off * BLOCK_MS) / WINDOW_MS))
    return !!f && Math.abs(f.lag - off) <= 1
  }

  /** the lags the room has shown (blocks) */
  private knownLags(): number[] {
    const off = this.offset()
    if (off) return [off]
    const count = new Map<number, number>()
    for (const l of this.lags) count.set(l, (count.get(l) ?? 0) + 1)
    return [...count.entries()].filter(([, n]) => n / this.lags.length >= KNOWN_LAG_SHARE).map(([l]) => l)
  }
  /** the leak's usual level on the mic, as a share of their track's: the middle of the correlated windows */
  private gain(): number { const r = (this.offset() ? this.apartWindows().map((f) => f.ratio) : [...this.ratios]).sort((a, b) => a - b); return r.length ? r[Math.floor(r.length / 2)] : 0 }

  /**
   * A mic line judged by its own audio. Over its span: does the mic follow their track at the room's lag (correlated);
   * is the mic, over the whole line, no louder than the leak usually is, so it holds little beyond their voice (loud);
   * and is it so close a copy, at the leak's level, over enough of the line, that it sounds like nothing but their voice
   * from the speakers (pure; echo.ts still wants their words in it)? Undefined before the room's lag is known, and for
   * audio older than two hours that was never asked about. Their voice hardly inside the line: none of these.
   * Tracks apart: the line is set against their track from that much earlier, where the voice it may copy is.
   */
  over(startMs: number, endMs: number): Moment | undefined {
    const key = `${startMs}:${endMs}`
    const known = this.verdicts.get(key)
    if (known) return known
    const lagsKnown = this.knownLags()
    if (!lagsKnown.length) return undefined
    const off = this.offset()
    // a and b are on their track's time; the mic is read `lag` later, which with the tracks apart is the line itself
    const a = Math.floor(startMs / BLOCK_MS) - off, b = Math.ceil(endMs / BLOCK_MS) - off
    if (!this.inRing('them', a) || !this.inRing('me', a + off)) return undefined
    const remember = (m: Moment) => { this.verdicts.set(key, m); return m }
    const speaking: number[] = []
    for (let i = a; i < b; i++) if (this.at('them', i) >= THEM_LOUD) speaking.push(i)
    if (speaking.length < LINE_MIN_SPEAKING) return remember({ correlated: false, loud: false, pure: false })
    // the whole span, pauses included: the person's own words in the pauses pull the correlation down and the level up, as they should
    const them: number[] = []
    for (let i = a; i < b; i++) them.push(this.at('them', i))
    let best = 0, bestLag = lagsKnown[0]
    for (const known of lagsKnown) for (let lag = Math.max(0, known - LAG_SLACK); lag <= Math.min(off ? FAR_LAG_BLOCKS : MAX_LAG_BLOCKS, known + LAG_SLACK); lag++) {
      const me: number[] = []
      for (let i = a; i < b; i++) me.push(this.at('me', i + lag))
      const c = pearson(them, me)
      if (c > best) { best = c; bestLag = lag }
    }
    const me: number[] = []
    for (let i = a; i < b; i++) me.push(this.at('me', i + bestLag))
    const ratio = mean(me) / mean(them)
    const g = this.gain()
    const cover = speaking.length / Math.max(1, b - a)
    return remember({ correlated: best >= CORRELATED, loud: ratio <= LOUD_RATIO * g, pure: best >= PURE_CORR && ratio <= PURE_RATIO * g && cover >= PURE_COVER })
  }
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

function pearson(a: number[], b: number[]): number {
  const n = a.length
  let sa = 0, sb = 0
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i] }
  const ma = sa / n, mb = sb / n
  let cov = 0, va = 0, vb = 0
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; cov += x * y; va += x * x; vb += y * y }
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0
}
