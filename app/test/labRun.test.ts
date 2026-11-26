// Transcript lab runs, with the speech engines stood in for.
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi, beforeEach } from 'vitest'

const engine = vi.hoisted(() => ({ fail: false, gate: null as null | Promise<void>, texts: new Map<string, string>() }))
vi.mock('../src/main/lab/engines', async (orig) => {
  const real = await orig<typeof import('../src/main/lab/engines')>()
  return {
    ...real,
    decodeTrack: async () => new Float32Array(16000 * 20),
    runModel: async (_c: unknown, m: { id: string }, files: string[]) => {
      if (engine.gate) await engine.gate
      if (engine.fail) throw new Error('model crashed')
      return new Map(files.map((f) => [f, { text: engine.texts.get(m.id) ?? 'we ship the remote control on Monday', ...(m.id === 'q' ? { language: 'en' } : {}) }]))
    },
  }
})
import { openStore } from '../src/main/store'
import { createTranscriptLab } from '../src/main/lab/index'
import type { LabConfig } from '../src/main/lab/config'

const cfg: LabConfig = { ffmpeg: 'ffmpeg', engines: { transcribe: 'x' }, languages: ['en'], auto: true, mode: 'vote', models: [
  { id: 'q', label: 'Q', engine: 'transcribe', path: 'q', takes: [], detects: true },
  { id: 'a', label: 'A', engine: 'transcribe', path: 'a', takes: ['language'] },
  { id: 'b', label: 'B', engine: 'transcribe', path: 'b', takes: ['language'] },
] }

function setup(o: { live?: boolean; config?: () => LabConfig | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-labrun-'))
  const store = openStore(join(dir, 'y.db'))
  const ids = ['m1', 'm2'].map((title) => {
    const m = store.createMeeting({ title, startedAt: 1, endedAt: 2, eventId: null, app: null, attendees: [], state: 'done' })
    mkdirSync(join(dir, m.id)); writeFileSync(join(dir, m.id, 'me.wav'), '')
    store.addSegments([{ meetingId: m.id, track: 'me', startMs: 1000, endMs: 4000, text: 'we ship the remote patrol on Monday', speaker: 'me' }])
    return m.id
  })
  let live = o.live ?? false
  const lab = createTranscriptLab({ store, config: o.config ?? (() => cfg), dirOf: (id) => join(dir, id), exts: ['wav'], busy: () => false, live: () => live, changed: () => {}, log: () => {} })
  const done = async (id: string) => { while (!['done', 'failed'].includes(lab.view(id).status.state)) await new Promise((r) => setTimeout(r, 5)) }
  return { store, lab, ids, done, setLive: (v: boolean) => { live = v } }
}
const text = (store: ReturnType<typeof openStore>, id: string) => store.segments(id).map((s) => s.text).join(' | ')

describe('lab runs', () => {
  beforeEach(() => { engine.fail = false; engine.gate = null; engine.texts.clear() })

  it('combines and replaces the transcript once done', async () => {
    const { store, lab, ids, done } = setup()
    lab.run(ids[0]); await done(ids[0])
    expect(lab.view(ids[0]).status).toMatchObject({ state: 'done', using: 'combined' })
    expect(text(store, ids[0])).toBe('we ship the remote control on Monday')
  })

  it('does not replace the transcript of a meeting still going; the run after it does', async () => {
    const { store, lab, ids, done, setLive } = setup({ live: true })
    lab.run(ids[0]); await done(ids[0])
    expect(lab.view(ids[0]).status).toMatchObject({ state: 'done', using: 'live' })
    expect(text(store, ids[0])).toBe('we ship the remote patrol on Monday')
    setLive(false)
    await lab.finished(ids[0]); await new Promise((r) => setTimeout(r, 5)); await done(ids[0])
    expect(text(store, ids[0])).toBe('we ship the remote control on Monday')
  })

  it("stops only the meeting asked for, and takes a queued one off the queue", async () => {
    let open!: () => void
    engine.gate = new Promise((r) => { open = r })
    const { lab, ids, done } = setup()
    lab.run(ids[0]); lab.run(ids[1])
    expect(lab.view(ids[1]).status.state).toBe('queued')
    lab.stop(ids[1])
    expect(lab.view(ids[1]).status).toMatchObject({ state: 'failed', error: 'stopped' })
    open(); await done(ids[0])
    expect(lab.view(ids[0]).status.state).toBe('done')
    expect(lab.view(ids[1]).status.state).toBe('failed')
  })

  it('keeps the last combined transcript when a new run fails', async () => {
    const { store, lab, ids, done } = setup()
    lab.run(ids[0]); await done(ids[0])
    engine.fail = true
    lab.run(ids[0]); await done(ids[0])
    expect(lab.view(ids[0]).status).toMatchObject({ state: 'failed', using: 'combined' })
    expect(lab.view(ids[0]).windows[0].combined).toBe('we ship the remote control on Monday')
    lab.use(ids[0], 'live')
    expect(text(store, ids[0])).toBe('we ship the remote patrol on Monday')
  })

  it('says why when the setup is gone by the time the run starts, rather than waiting forever', async () => {
    let c: LabConfig | null = cfg
    const { lab, ids, done } = setup({ config: () => c })
    let open!: () => void
    engine.gate = new Promise((r) => { open = r })
    lab.run(ids[0]); lab.run(ids[1])
    c = null; open()
    await done(ids[0]); await done(ids[1])
    expect(lab.view(ids[1]).status.state).toBe('failed')
  })
})
