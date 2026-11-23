import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

/** one running yogurt-mac mic-watch: its lines, its end, and how to end it */
export type MicWatchProc = { onLine(f: (line: string) => void): void; onExit(f: () => void): void; send(line: string): void; stop(): void }

/** waits before starting the watcher again, longer each time it ends soon after starting */
export const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000]
/** this many short runs in a row (an older helper without mic-watch, or one that can't run here): poll instead */
export const MAX_FAILURES = 5
/** a run this long was fine: the next end starts the waits over */
const LONG_RUN_MS = 60_000
/** without a watcher, how often a one-off mic-apps may run: each one is a new Core Audio client (#143) */
export const SLOW_POLL_MS = { idle: 20_000, recording: 5_000 }
/** a watcher just started prints at once; a read waits this long for it */
const FIRST_LINE_MS = 2_000

/**
 * Which apps are on the mic, from one long-lived yogurt-mac mic-watch that prints a line whenever it changes.
 * Starting a helper every few seconds made coreaudiod and powerd run out of room after about an hour, and the
 * displays never woke again (#143). A watcher that keeps ending is started again with growing waits, then given up on
 * for a slow poll.
 */
export function createMicWatch(d: { start: () => MicWatchProc; poll: () => Promise<unknown>; recording: () => boolean }) {
  let proc: MicWatchProc | undefined
  /** the watcher's latest line; undefined while none is running or it has not spoken yet */
  let value: unknown[] | undefined
  let failures = 0, stopped = false, polling = false
  let restart: NodeJS.Timeout | undefined
  let heard: (() => void)[] = []
  let polled: { at: number; value: unknown } | undefined
  let asking: Promise<unknown> | undefined
  /** what the watcher was last told: it reads again every 1.5 s while recording, else 3 s */
  let told: boolean | undefined
  const tell = () => {
    const r = d.recording()
    if (proc && r !== told) { told = r; proc.send(r ? 'recording' : 'idle') }
  }

  const run = () => {
    if (stopped) return
    const startedAt = Date.now()
    const p = d.start()
    proc = p
    told = undefined
    tell()
    p.onLine((l) => {
      if (proc !== p) return
      let v: unknown
      try { v = JSON.parse(l) } catch { return }
      if (!Array.isArray(v)) return
      value = v
      for (const f of heard.splice(0)) f()
    })
    p.onExit(() => {
      if (proc !== p) return
      proc = undefined; value = undefined
      for (const f of heard.splice(0)) f()
      if (stopped) return
      failures = Date.now() - startedAt >= LONG_RUN_MS ? 0 : failures + 1
      if (failures >= MAX_FAILURES) {
        polling = true
        console.warn(`mic watch: ended ${failures} times in a row, asking every ${SLOW_POLL_MS.idle / 1000} s instead`)
        return
      }
      restart = setTimeout(run, BACKOFF_MS[Math.max(0, failures - 1)])
    })
  }

  const slowPoll = (): Promise<unknown> => {
    const every = d.recording() ? SLOW_POLL_MS.recording : SLOW_POLL_MS.idle
    if (polled && Date.now() - polled.at < every) return Promise.resolve(polled.value)
    asking ??= d.poll().catch(() => [])
      .then((v) => { polled = { at: Date.now(), value: v }; return v })
      .finally(() => { asking = undefined })
    return asking
  }

  run()
  return {
    async read(): Promise<unknown> {
      tell()
      if (value) return value
      if (proc && !polling) {
        let timer: NodeJS.Timeout | undefined
        await new Promise<void>((r) => { heard.push(r); timer = setTimeout(r, FIRST_LINE_MS) })
        clearTimeout(timer)
        if (value) return value
      }
      return slowPoll()
    },
    /** quitting: the watcher ends, and no other starts */
    stop() {
      stopped = true
      clearTimeout(restart)
      proc?.stop()
    },
  }
}

/** yogurt-mac mic-watch: one JSON line (what mic-apps prints) at start and on each change, until its stdin closes;
 * "recording" or "idle" sent to it sets how often it reads again by itself */
export const spawnMicWatch = (binary: () => string) => (): MicWatchProc => {
  const child = spawn(binary(), ['mic-watch'], { stdio: ['pipe', 'pipe', 'ignore'] })
  const exits: (() => void)[] = []
  let ended = false
  const end = () => { if (ended) return; ended = true; for (const f of exits) f() }
  child.on('error', (e) => { console.warn('mic watch: could not run', e.message); end() })
  child.on('exit', end)
  // closing stdin of one already gone
  child.stdin.on('error', () => {})
  const lines = createInterface({ input: child.stdout })
  return {
    onLine: (f) => { lines.on('line', f) },
    onExit: (f) => { exits.push(f) },
    send: (l) => { if (!ended && child.stdin.writable) child.stdin.write(l + '\n') },
    stop() {
      child.stdin.end()
      setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }, 2000).unref()
    },
  }
}
