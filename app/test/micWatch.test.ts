import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BACKOFF_MS, MAX_FAILURES, SLOW_POLL_MS, createMicWatch, spawnMicWatch, type MicWatchProc } from '../src/main/micWatch'
import { createSignals } from '../src/main/detectSignals'

const zoom = { bundleId: 'us.zoom.xos', name: 'zoom.us', pid: 2 }

/** stand-in helper processes: each start is one, lines and exits sent by hand */
function procs() {
  const all: { line(l: string): void; exit(): void; stopped: boolean; sent: string[] }[] = []
  const start = (): MicWatchProc => {
    let onLine: (l: string) => void = () => {}, onExit: () => void = () => {}
    const p = { line: (l: string) => onLine(l), exit: () => onExit(), stopped: false, sent: [] as string[] }
    all.push(p)
    return { onLine: (f) => { onLine = f }, onExit: (f) => { onExit = f }, send: (l) => { p.sent.push(l) }, stop: () => { p.stopped = true } }
  }
  return { all, start, last: () => all[all.length - 1] }
}

function setup(o: { recording?: boolean } = {}) {
  const p = procs()
  const polls: number[] = []
  let recording = o.recording ?? false
  const w = createMicWatch({ start: p.start, poll: async () => { polls.push(Date.now()); return [zoom] }, recording: () => recording })
  return { w, p, polls, setRecording: (r: boolean) => { recording = r } }
}

describe('createMicWatch', () => {
  beforeEach(() => { vi.useFakeTimers({ now: 0 }) })
  afterEach(() => { vi.useRealTimers() })

  it('starts one watcher and returns its latest line, never asking again per read', async () => {
    const x = setup()
    x.p.last().line(JSON.stringify([zoom]))
    for (let i = 0; i < 100; i++) { expect(await x.w.read()).toEqual([zoom]); vi.advanceTimersByTime(3000) }
    x.p.last().line('[]')
    expect(await x.w.read()).toEqual([])
    expect(x.p.all).toHaveLength(1)
    expect(x.polls).toEqual([])
  })
  it('tells the watcher whether a meeting records, only when that changes, so it reads again at the old pace', async () => {
    const x = setup()
    x.p.last().line('[]')
    expect(x.p.last().sent).toEqual(['idle'])
    await x.w.read(); await x.w.read()
    x.setRecording(true)
    await x.w.read(); await x.w.read()
    x.setRecording(false)
    await x.w.read()
    expect(x.p.last().sent).toEqual(['idle', 'recording', 'idle'])
  })
  it('a restarted watcher is told again', async () => {
    const x = setup({ recording: true })
    x.p.last().exit()
    vi.advanceTimersByTime(BACKOFF_MS[0])
    expect(x.p.last().sent).toEqual(['recording'])
  })
  it('skips lines it cannot read and keeps the last good one', async () => {
    const x = setup()
    x.p.last().line(JSON.stringify([zoom]))
    x.p.last().line('[{"bundleId"')
    x.p.last().line('{"error":"x"}')
    expect(await x.w.read()).toEqual([zoom])
  })
  it('waits briefly for the first line after starting', async () => {
    const x = setup()
    const r = x.w.read()
    x.p.last().line(JSON.stringify([zoom]))
    expect(await r).toEqual([zoom])
    expect(x.polls).toEqual([])
  })
  it('restarts a watcher that ended, waiting longer each time it ends early', async () => {
    const x = setup()
    x.p.last().exit()
    vi.advanceTimersByTime(BACKOFF_MS[0] - 1)
    expect(x.p.all).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(x.p.all).toHaveLength(2)
    x.p.last().line('[]')
    x.p.last().exit()
    vi.advanceTimersByTime(BACKOFF_MS[1] - 1)
    expect(x.p.all).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(x.p.all).toHaveLength(3)
  })
  it('a watcher that ran a long while starts again at the shortest wait', async () => {
    const x = setup()
    for (let i = 0; i < 3; i++) { x.p.last().exit(); vi.advanceTimersByTime(60_000) }
    expect(x.p.all).toHaveLength(4)
    vi.advanceTimersByTime(10 * 60_000)
    x.p.last().exit()
    vi.advanceTimersByTime(BACKOFF_MS[0])
    expect(x.p.all).toHaveLength(5)
  })
  it('between watchers it asks once in a while, not every read', async () => {
    const x = setup()
    x.p.last().line(JSON.stringify([zoom]))
    x.p.last().exit()
    expect(await x.w.read()).toEqual([zoom])
    expect(x.polls).toHaveLength(1)
    await x.w.read()
    expect(x.polls).toHaveLength(1)
  })
  it('falls back to slow polling once the watcher keeps failing (an older helper)', async () => {
    const x = setup()
    for (let i = 0; i < MAX_FAILURES; i++) { x.p.last().exit(); vi.advanceTimersByTime(60_000) }
    expect(x.p.all).toHaveLength(MAX_FAILURES)
    vi.advanceTimersByTime(60 * 60_000)
    expect(x.p.all).toHaveLength(MAX_FAILURES)
    // reads every 3 s for a minute: a poll each SLOW_POLL_MS.idle
    for (let t = 0; t < 60_000; t += 3000) { expect(await x.w.read()).toEqual([zoom]); vi.advanceTimersByTime(3000) }
    expect(x.polls).toHaveLength(Math.ceil(60_000 / SLOW_POLL_MS.idle))
  })
  it('polls a little more often while recording, still far less than every tick', async () => {
    const x = setup({ recording: true })
    for (let i = 0; i < MAX_FAILURES; i++) { x.p.last().exit(); vi.advanceTimersByTime(60_000) }
    for (let t = 0; t < 60_000; t += 1500) { await x.w.read(); vi.advanceTimersByTime(1500) }
    expect(x.polls.length).toBeGreaterThan(1)
    expect(x.polls.length).toBeLessThanOrEqual(60_000 / SLOW_POLL_MS.recording)
    expect(SLOW_POLL_MS.recording).toBeGreaterThanOrEqual(5000)
  })
  it('a failed poll counts as nothing on the mic, and is not retried at once', async () => {
    const p = procs()
    let polls = 0
    const w = createMicWatch({ start: p.start, poll: async () => { polls++; throw new Error('no helper') }, recording: () => false })
    for (let i = 0; i < MAX_FAILURES; i++) { p.last().exit(); vi.advanceTimersByTime(60_000) }
    expect(await w.read()).toEqual([])
    expect(await w.read()).toEqual([])
    expect(polls).toBe(1)
  })
  it('stop ends the watcher and never starts another', async () => {
    const x = setup()
    x.w.stop()
    expect(x.p.last().stopped).toBe(true)
    x.p.last().exit()
    vi.advanceTimersByTime(10 * 60_000)
    expect(x.p.all).toHaveLength(1)
  })
  it('stop during a restart wait cancels the restart', async () => {
    const x = setup()
    x.p.last().exit()
    x.w.stop()
    vi.advanceTimersByTime(10 * 60_000)
    expect(x.p.all).toHaveLength(1)
  })
})

describe('createSignals with a mic watcher', () => {
  it('reads the mic from the watcher, never from a new helper', async () => {
    const calls: string[][] = []
    const s = createSignals({ helper: async (a) => { calls.push(a); return [] }, micApps: async () => [zoom], events: async () => [] })
    for (let i = 0; i < 10; i++) expect((await s.read(i * 3000)).micApps).toEqual([zoom])
    expect(calls.filter((c) => c[0] === 'mic-apps')).toEqual([])
  })
})

describe.skipIf(process.platform === 'win32')('spawnMicWatch', () => {
  it('hands on each line, and ends the helper when stopped (stdin closed)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'micwatch-'))
    const bin = join(dir, 'helper')
    writeFileSync(bin, '#!/bin/sh\n[ "$1" = mic-watch ] || exit 2\necho \'[{"bundleId":"us.zoom.xos","name":"zoom.us","pid":2}]\'\ncat >/dev/null\n')
    chmodSync(bin, 0o755)
    const p = spawnMicWatch(() => bin)()
    p.send('recording')
    const line = await new Promise<string>((r) => p.onLine(r))
    expect(JSON.parse(line)).toEqual([zoom])
    const ended = new Promise<void>((r) => p.onExit(r))
    p.stop()
    await ended
  })
  it('a helper that cannot start ends once', async () => {
    const p = spawnMicWatch(() => '/nonexistent/yogurt-mac')()
    let ends = 0
    await new Promise<void>((r) => p.onExit(() => { ends++; r() }))
    await new Promise((r) => setTimeout(r, 50))
    expect(ends).toBe(1)
  })
})

it('releases a pending read when disabled without starting a fallback mic poll', async () => {
  const x = setup()
  const pending = x.w.read()
  x.w.stop()
  expect(x.p.last().stopped).toBe(true)
  x.p.last().line(JSON.stringify([zoom]))
  expect(await pending).toEqual([])
  expect(await x.w.read()).toEqual([])
  expect(x.polls).toEqual([])
})
