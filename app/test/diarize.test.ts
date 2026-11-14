import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openStore, type Store } from '../src/main/store'
import { createDiarizer, type Deps } from '../src/main/diarize/index'
import { writeWav } from '../src/main/diarize/wav'

const dirs: string[] = []
const stores: Store[] = []
afterEach(() => { stores.splice(0).forEach((s) => s.close()); dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })) })
const fresh = () => { const d = mkdtempSync(join(tmpdir(), 'yogurt-diarize-')); dirs.push(d); const s = openStore(join(d, 'yogurt.db')); stores.push(s); return s }
// 'stopped': recorded and closed, not yet analyzed — the diarizer skips a meeting that is still recording
const base = { title: 'Sync', endedAt: null, eventId: null, app: null, attendees: [], state: 'stopped' as const }
const word = (text: string, startMs: number, endMs: number) => ({ text, startMs, endMs })
const RTTM = 'SPEAKER them 1 0.000 2.100 <NA> <NA> 0 <NA> <NA>\nSPEAKER them 1 2.300 2.200 <NA> <NA> 1 <NA> <NA>\n'

/** two voices; the call names on the rows decide the claims (pass [null, null] for a Them-only meeting) */
const seed = (s: Store, speakers: [string | null, string | null] = ['Ann Lee', null], voices = false) => {
  const m = s.createMeeting({ ...base, startedAt: 1, voicesAllowed: voices })
  s.addSegments([
    { meetingId: m.id, track: 'them', startMs: 0, endMs: 2000, text: 'hello there', speaker: speakers[0],
      words: [word('hello', 0, 1000), word('there', 1000, 2000)] },
    { meetingId: m.id, track: 'them', startMs: 2400, endMs: 4400, text: 'ok friend sure', speaker: speakers[1],
      words: [word('ok', 2400, 3200), word('friend', 3200, 3600), word('sure', 3600, 4400)] },
    { meetingId: m.id, track: 'me', startMs: 100, endMs: 600, text: 'hi', speaker: 'me' },
  ])
  return m.id
}

function setup(over: Partial<Deps> = {}) {
  const store = fresh()
  const runDir = mkdtempSync(join(tmpdir(), 'yogurt-diarize-run-'))
  // the recording the job looks for: trackFile checks the file exists before decode runs
  writeWav(join(runDir, 'them.wav'), new Float32Array(16))
  const rttm = RTTM
  const run = {
    decode: async (_helper: string, _input: string, out: string) => writeWav(out, new Float32Array(16 * 5000)),
    diarize: async (_nemo: string, _wav: string, _model: string, rttmPath: string) => { writeFileSync(rttmPath, rttm); return 'gpu' as const },
  }
  const deps: Deps = {
    store, queue: { enqueue: async (job) => { await job(new AbortController().signal) } },
    audioHelper: () => 'helper', nemoPath: () => 'nemo', modelPath: () => 'm.gguf',
    ensureSpeakerModel: vi.fn(async () => 'speaker.onnx'), embed: undefined,
    dirOf: () => runDir, exts: () => ['wav'], allowed: () => false, fake: false,
    changed: vi.fn(), notesRefresh: vi.fn(), run, ...over,
  }
  return { store, deps, runDir }
}

const them = (store: Store, id: string) => store.segments(id).filter(x => x.track === 'them')

describe('diarizer', () => {
  it('splits at the speaker change, names by call-app evidence, numbers the rest, marks the meeting', async () => {
    const { store, deps } = setup()
    const id = seed(store)
    const d = createDiarizer(deps)
    d.schedule(id)
    await d.finished(id)
    expect(store.segments(id).map(x => [x.track, x.text, x.speakerKey])).toEqual([
      ['them', 'hello there', 'v1'],
      ['me', 'hi', null],
      ['them', 'ok friend sure', 'v2'],
    ])
    expect(them(store, id).map(x => x.speaker)).toEqual(['Ann Lee', 'Speaker 1'])
    expect(store.meeting(id)).toMatchObject({ diarizeError: null })
    expect(store.meeting(id)!.diarizedAt).toBeGreaterThan(0)
    expect(deps.changed).toHaveBeenCalledWith(id)
    expect(deps.notesRefresh).toHaveBeenCalledWith(id)
  })

  it('one person is one voice: a second cluster claiming the same name drops to Speaker N', async () => {
    const { store, deps } = setup()
    const id = seed(store, ['Ann Lee', 'Ann Lee']) // both rows claim Ann Lee; the strongest claim wins
    const d = createDiarizer(deps)
    d.schedule(id)
    await d.finished(id)
    expect(them(store, id).map(x => x.speaker)).toEqual(['Ann Lee', 'Speaker 1'])
  })

  it('profiles off: no embeddings requested, even when voice recognition is on but the meeting pre-dates it', async () => {
    const { store, deps } = setup({ allowed: () => true, embedVectors: vi.fn(async () => { throw new Error('must not run') }) })
    const id = seed(store)
    const d = createDiarizer(deps)
    d.schedule(id)
    await d.finished(id)
    expect(deps.embedVectors).not.toHaveBeenCalled()
  })

  it('profiles on: a high-confidence match links the cluster; the same profile is claimed by the strongest cluster only; enrollment bumps the profile', async () => {
    const { store, deps } = setup({ allowed: () => true })
    const id = seed(store, ['Ann Lee', null], true)
    store.createVoiceProfile({ id: 'p1', name: 'Ann Lee', model: 'campplus', dims: 3, centroid: Buffer.from(new Float32Array([1, 0, 0]).buffer) })
    const d = createDiarizer({ ...deps, embedVectors: async (_w, ranges) => ranges.map(() => new Float32Array([1, 0, 0])) })
    d.schedule(id)
    await d.finished(id)
    const sp = Object.fromEntries(store.meetingSpeakers(id).map(x => [x.key, x]))
    // v1 is Ann Lee (call-app claim) and matches p1: linked, profile bumped once for the meeting
    expect(sp.v1).toMatchObject({ profileId: 'p1' })
    expect(store.voiceProfiles().find(p => p.id === 'p1')!.meetings).toBe(1)
    // v2 (Speaker 1) also matches p1, but p1 already named v1: stays Speaker N, no link
    expect(sp.v2).toMatchObject({ profileId: null })
    expect(them(store, id).map(x => x.speaker)).toEqual(['Ann Lee', 'Speaker 1'])
  })

  it('never enrolls a Speaker N voice', async () => {
    const { store, deps } = setup({ allowed: () => true })
    const id = seed(store, [null, null], true) // no call names anywhere: both voices stay Speaker N
    const d = createDiarizer({ ...deps, embedVectors: async (_w, ranges) => ranges.map(() => new Float32Array([1, 0, 0])) })
    d.schedule(id)
    await d.finished(id)
    expect(store.voiceProfiles()).toEqual([])
    expect(store.meetingSpeakers(id).every(x => x.profileId === null)).toBe(true)
  })

  it('enrolls a named voice with no match as a new profile', async () => {
    const { store, deps } = setup({ allowed: () => true })
    const id = seed(store, ['Ann Lee', null], true)
    const d = createDiarizer({ ...deps, embedVectors: async (_w, ranges) => ranges.map(() => new Float32Array([0, 1, 0])) })
    d.schedule(id)
    await d.finished(id)
    // v1 is named Ann Lee and matched nothing: enrolled
    expect(store.voiceProfiles().map(p => p.name)).toEqual(['Ann Lee'])
    expect(store.meetingSpeakers(id).find(x => x.key === 'v1')!.profileId).toBe(store.voiceProfiles()[0].id)
  })

  it('resume: only appended rows are diarized; an overlapping new turn joins the old cluster and keeps its name', async () => {
    const { store, deps } = setup()
    const id = seed(store)
    const d = createDiarizer(deps)
    d.schedule(id)
    await d.finished(id)
    store.addSegments([{ meetingId: id, track: 'them', startMs: 100, endMs: 900, text: 'still me', speaker: null, words: [word('still', 100, 500), word('me', 500, 900)] }])
    const d2 = createDiarizer(deps)
    d2.schedule(id)
    await d2.finished(id)
    expect(store.segments(id).filter(x => x.text === 'still me').map(x => [x.speakerKey, x.speaker])).toEqual([['v1', 'Ann Lee']])
    expect(store.segments(id).filter(x => x.text === 'hello there').map(x => x.speakerKey)).toEqual(['v1'])
    expect(store.segments(id).filter(x => x.text === 'ok friend sure').map(x => x.speaker)).toEqual(['Speaker 1'])
  })

  it('decode failure is recorded on the meeting and the transcript stays as it was', async () => {
    const { store, deps } = setup()
    const id = seed(store)
    const d = createDiarizer({ ...deps, run: { ...deps.run!, decode: async () => { throw new Error('unsupported-input') } } })
    d.schedule(id)
    await d.finished(id)
    expect(store.meeting(id)).toMatchObject({ diarizeError: 'unsupported-input' })
    expect(store.meeting(id)!.diarizedAt).toBeUndefined()
    expect(store.segments(id).every(x => x.speakerKey == null)).toBe(true)
    expect(deps.changed).not.toHaveBeenCalled()
  })

  it('no them recording: recorded as a no-op', async () => {
    const { store, deps } = setup({ exts: () => ['m4a'] })
    const id = seed(store)
    const d = createDiarizer(deps)
    d.schedule(id)
    await d.finished(id)
    expect(String(store.meeting(id)!.diarizeError)).toMatch(/no them recording/)
  })

  it('all-hole vectors: the meeting still diarizes, with no profile links and nothing enrolled', async () => {
    const { store, deps } = setup({ allowed: () => true })
    const id = seed(store, ['Ann Lee', null], true)
    const embedVectors = vi.fn(async (_w: string, ranges: Array<{ startMs: number; endMs: number }>) => ranges.map(() => undefined))
    const d = createDiarizer({ ...deps, embedVectors })
    d.schedule(id)
    await d.finished(id)
    // the embedding step ran and came back empty, yet the transcript itself is fully diarized
    expect(embedVectors).toHaveBeenCalled()
    expect(them(store, id).map(x => [x.speakerKey, x.speaker])).toEqual([['v1', 'Ann Lee'], ['v2', 'Speaker 1']])
    expect(store.meetingSpeakers(id).every(x => x.profileId === null)).toBe(true)
    expect(store.voiceProfiles()).toEqual([])
    expect(store.meeting(id)).toMatchObject({ diarizeError: null })
    expect(store.meeting(id)!.diarizedAt).toBeGreaterThan(0)
  })

  it('a nemo turn with no transcript words: no ghost cluster row, and it consumes no Speaker N number', async () => {
    const { store, deps } = setup()
    const id = seed(store)
    const d = createDiarizer({ ...deps, run: { ...deps.run!, diarize: async (_nemo: string, _wav: string, _model: string, rttmPath: string) => {
      writeFileSync(rttmPath, `${RTTM}SPEAKER them 1 60.000 2.000 <NA> <NA> 2 <NA> <NA>\n`); return 'gpu' as const
    } } })
    d.schedule(id)
    await d.finished(id)
    // the turn's cluster got no runs at all: no meeting_speakers row, and only the two voiced ones remain
    expect(store.meetingSpeakers(id).map(x => [x.key, x.startMs, x.endMs])).toEqual([['v1', 0, 2000], ['v2', 2400, 4400]])
    // it consumed no Speaker number either: v2 is still Speaker 1
    expect(them(store, id).map(x => [x.speakerKey, x.speaker])).toEqual([['v1', 'Ann Lee'], ['v2', 'Speaker 1']])
    expect(store.meeting(id)).toMatchObject({ diarizeError: null })
  })

  it('the speaker model downloads lazily, on the first real meeting that asks for vectors — never before, never in fake mode', async () => {
    // real mode, voices on: downloaded when vectors are requested
    {
      const { store, deps } = setup({ allowed: () => true })
      const id = seed(store, ['Ann Lee', null], true)
      const d = createDiarizer({ ...deps, embedVectors: async (_w, ranges) => ranges.map(() => new Float32Array([0, 1, 0])) })
      d.schedule(id)
      await d.finished(id)
      expect(deps.ensureSpeakerModel).toHaveBeenCalled()
      expect(store.voiceProfiles().map(p => p.name)).toEqual(['Ann Lee'])
    }
    // a meeting that predates voice recognition: no download (the allowed() gate shares the same early return)
    {
      const { store, deps } = setup({ allowed: () => true, embedVectors: vi.fn(async () => { throw new Error('must not run') }) })
      const id = seed(store) // voicesAllowed false
      const d = createDiarizer(deps)
      d.schedule(id)
      await d.finished(id)
      expect(deps.ensureSpeakerModel).not.toHaveBeenCalled()
      expect(deps.embedVectors).not.toHaveBeenCalled()
    }
    // voices off in settings: no download either
    {
      const { store, deps } = setup({ allowed: () => false, embedVectors: vi.fn(async () => { throw new Error('must not run') }) })
      const id = seed(store, ['Ann Lee', null], true)
      const d = createDiarizer(deps)
      d.schedule(id)
      await d.finished(id)
      expect(deps.ensureSpeakerModel).not.toHaveBeenCalled()
      expect(deps.embedVectors).not.toHaveBeenCalled()
    }
    // fake mode: no download (no onnx there), though the profiles step itself runs
    {
      const { store, deps } = setup({ allowed: () => true, fake: true })
      const id = seed(store, ['Ann Lee', null], true)
      const d = createDiarizer(deps)
      d.schedule(id)
      await d.finished(id)
      expect(deps.ensureSpeakerModel).not.toHaveBeenCalled()
      expect(store.meeting(id)).toMatchObject({ diarizeError: null })
    }
  })
})
