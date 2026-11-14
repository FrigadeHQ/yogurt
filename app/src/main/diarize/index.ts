import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Store } from '../store'
import type { Queue } from '../notes/queue'
import type { AudioExt } from '../audio'
import { trackFile } from '../audio'
import { cleanTurns, parseRttm, type Turn } from './rttm'
import { splitPlan, type SplitRow, type SplitRun } from './align'
import { nextSpeakerNumber, resolveNames, reuseKeys } from './naming'
import { bestMatch, blend, normalize, type ProfileVec } from './match'
import { probeBackend, runDecode, runDiarize } from './run'
import { fakeDecode, fakeTurns, fakeVectorFor } from './fake'
import type { EmbedClient } from './embed-client'

export type Deps = {
  store: Pick<Store, 'meeting' | 'segments' | 'applyDiarization' | 'meetingSpeakers' | 'markDiarized' | 'speakerOrder'
    | 'voiceCentroids' | 'voiceProfiles' | 'createVoiceProfile' | 'updateVoiceCentroid' | 'bumpVoiceProfile' | 'setMeetingSpeakerProfile'>
  queue: Pick<Queue, 'enqueue'>
  /** the recorder helper (decode) */
  audioHelper: () => string
  nemoPath: () => string | undefined
  modelPath: () => string | undefined
  /** lazy speaker-model download, once, on first opt-in use */
  ensureSpeakerModel: () => Promise<string>
  embed: EmbedClient | undefined            // undefined: profiles unavailable (fake mode uses fake embeddings separately)
  dirOf: (id: string) => string
  exts: () => readonly AudioExt[]
  allowed: () => boolean                    // settings.speakerProfiles
  fake: boolean
  changed: (id: string) => void
  notesRefresh: (id: string) => void
  timeoutMs?: (audioMs: number) => number   // tests
  run?: { decode: typeof runDecode; diarize: typeof runDiarize }   // tests inject fakes
  embedVectors?: (wav: string, ranges: Array<{ startMs: number; endMs: number }>) => Promise<Array<Float32Array | undefined>>  // tests
}

const CLEAN_RANGE_MS = 800
const MIN_SPEECH_MS = 2000
const SPEAKER_N = /^Speaker \d+$/

/** the profile-match outcome for one cluster, applied once its meeting_speakers row exists */
type Patch = { profileId?: string | null; score?: number | null }

/** one voice this run produced, before names are resolved */
type Cluster = { key: string; reused: boolean; claims: Map<string | null, number>; total: number; spans: Array<{ startMs: number; endMs: number }> }

export function createDiarizer(p: Deps) {
  const run = p.run ?? { decode: runDecode, diarize: runDiarize }
  const finals = new Map<string, Promise<void>>()

  const job = async (id: string, signal: AbortSignal) => {
    const m = p.store.meeting(id)
    if (!m || m.state === 'recording') return
    const file = trackFile(p.dirOf(id), 'them', p.exts())
    if (!file) { p.store.markDiarized(id, 'no them recording'); return }
    const dir = mkdtempSync(join(tmpdir(), 'yogurt-diarize-'))
    try {
      const wav = join(dir, 'them.wav'), rttmFile = join(dir, 'them.rttm')
      const cap = p.timeoutMs?.(m.durationMs ?? 0)
      if (p.fake) await fakeDecode(p.audioHelper(), file, wav)
      else await run.decode(p.audioHelper(), file, wav)
      const model = p.modelPath(), nemo = p.nemoPath()
      if (!model || !nemo) throw new Error('diarization model is not downloaded yet')
      let turns: Turn[]
      if (p.fake) turns = cleanTurns(fakeTurns())
      else {
        await run.diarize(nemo, wav, model, rttmFile, probeBackend(), cap)
        turns = cleanTurns(parseRttm(readFileSync(rttmFile, 'utf8')))
      }
      if (signal.aborted) return
      await persist(id, wav, turns)
      p.store.markDiarized(id)
      p.changed(id)
      p.notesRefresh(id)
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      console.warn('DIARIZE failed:', reason)
      try { p.store.markDiarized(id, reason.slice(0, 300)) } catch { /* the meeting may be gone */ }
    } finally {
      // a Windows handle can outlive the kill and hold the dir a moment; the next run makes a new one anyway
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch { /* left behind */ }
    }
  }

  const nameOfKey = (id: string, key: string): string | null => {
    const s = p.store.segments(id, { hidden: true }).find(x => x.track === 'them' && x.speakerKey === key && x.speaker)
    return s?.speaker ?? null
  }

  const spanOf = (c: Cluster) => ({ startMs: Math.min(...c.spans.map(s => s.startMs)), endMs: Math.max(...c.spans.map(s => s.endMs)) })

  const persist = async (id: string, wav: string, turns: Turn[]) => {
    const existing = p.store.meetingSpeakers(id)
    const reuse = reuseKeys(turns, existing)
    // fresh keys continue after the highest vN already in the meeting
    let nextV = existing.reduce((n, e) => Math.max(n, Number(/^v(\d+)$/.exec(e.key)?.[1] ?? 0)), 0)
    const keyOf = new Map<string, string>()
    for (const t of turns) keyOf.set(t.key, reuse.get(t.key) ?? `v${++nextV}`)
    const rows: SplitRow[] = p.store.segments(id, { hidden: true })
      .filter(s => s.track === 'them' && !s.speakerKey && !s.hidden)
      .map(s => ({ id: s.id, startMs: s.startMs, endMs: s.endMs, text: s.text, speaker: s.speaker, ...(s.words?.length ? { words: s.words } : {}) }))
    const { keep, runs } = splitPlan(rows, turns, (t) => t) // respell was already applied when the lines were saved
    const reusedKeys = new Set([...reuse.values()])
    const clusters = new Map<string, Cluster>()
    const put = (key: string): Cluster => clusters.get(key) ?? (() => { const c: Cluster = { key, reused: reusedKeys.has(key), claims: new Map(), total: 0, spans: [] }; clusters.set(key, c); return c })()
    for (const key of keyOf.values()) put(key)
    const keyedRuns: SplitRun[] = [], leftovers: SplitRun[] = []
    for (const r of runs) {
      if (!r.key) { leftovers.push(r); continue }
      const key = keyOf.get(r.key)! // the meeting's stable key ('v1', …), not the diarizer's per-run label
      keyedRuns.push({ ...r, key })
      const c = put(key)
      const ms = r.endMs - r.startMs
      c.total += ms
      c.spans.push({ startMs: r.startMs, endMs: r.endMs })
      c.claims.set(r.speaker, (c.claims.get(r.speaker) ?? 0) + ms)
    }
    // names: reused clusters keep the name already shown; new clusters resolve (claims, dedupe, Speaker N).
    // A turn that overlaid no transcript row (asr dropped the speech) leaves its cluster without runs: it takes
    // no part in naming (consumes no number) and gets no meeting_speakers row; a reused cluster like that keeps
    // its existing row untouched.
    const voiced = (c: Cluster) => c.spans.length > 0
    const reusedNames = existing.filter(e => reusedKeys.has(e.key)).map(e => nameOfKey(id, e.key)).filter((n): n is string => !!n)
    const live = new Set(p.store.segments(id, { hidden: true }).filter(s => s.track === 'them' && s.speaker).map(s => s.speaker!))
    const resolved = resolveNames(
      [...clusters.values()].filter(c => !c.reused && voiced(c)).map(c => ({ key: c.key, claims: [...c.claims].map(([name, ms]) => ({ name, ms })), total: c.total })),
      { taken: [...new Set(reusedNames)], startNumber: nextSpeakerNumber([...live]) })
    const nameOf = new Map(resolved.map(r => [r.key, r.speaker]))
    const finalName = (key: string): string | null => nameOf.get(key) ?? nameOfKey(id, key)
    // voice profiles, only where the meeting allowed them; their cluster-row patches land after the transaction below
    const patches = new Map<string, Patch>()
    await profiles(id, wav, clusters, finalName, keyedRuns, patches)
    // one transaction: delete re-split rows, insert runs (reused keys keep their name), leftover remainders, cluster rows
    const deleted = new Set<number>()
    for (const r of [...keyedRuns, ...leftovers]) for (const line of r.lineIds) deleted.add(line)
    for (const keptId of keep) deleted.delete(keptId)
    const insert: Array<Omit<import('../store').Segment, 'id'>> = [...keyedRuns, ...leftovers].map(r => ({
      meetingId: id, track: 'them' as const, startMs: r.startMs, endMs: r.endMs, text: r.text,
      speaker: r.key ? finalName(r.key) : r.speaker, speakerKey: r.key, ...(r.words?.length ? { words: r.words } : {}),
    }))
    const speakers = [...clusters.values()].filter(voiced).map(c => {
      const span = spanOf(c)
      const old = existing.find(e => e.key === c.key)
      return {
        key: c.key, speaker: old ? nameOfKey(id, c.key) : finalName(c.key),
        profileId: old?.profileId ?? null, score: old?.score ?? null,
        startMs: Math.min(old?.startMs ?? span.startMs, span.startMs), endMs: Math.max(old?.endMs ?? span.endMs, span.endMs),
      }
    })
    p.store.applyDiarization(id, { deleteIds: [...deleted], insert, speakers })
    // the profile step's outcome: the cluster rows it patches only exist now (setMeetingSpeakerProfile is for after the split)
    for (const [key, patch] of patches) p.store.setMeetingSpeakerProfile(id, key, patch)
    p.store.speakerOrder(id) // colour order: first-appearance order across the meeting's named voices
  }

  /** embeddings per new cluster, match against profiles, auto-name the sure ones, enroll the named ones */
  const profiles = async (id: string, wav: string, clusters: Map<string, Cluster>, finalName: (key: string) => string | null, keyedRuns: SplitRun[], patches: Map<string, Patch>) => {
    try {
      const meetingAllows = !!p.store.meeting(id)?.voicesAllowed
      if (!meetingAllows || !p.allowed()) return
      if (!keyedRuns.length) return
      const items: Array<{ key: string; ranges: Array<{ startMs: number; endMs: number }>; total: number }> = []
      for (const c of clusters.values()) {
        if (c.reused) continue // existing clusters keep their names across a resume; no embeddings for them
        // clean speech: ranges of >= 0.8 s, at least 2 s together
        const ranges = c.spans.filter(s => s.endMs - s.startMs >= CLEAN_RANGE_MS)
        const total = ranges.reduce((n, s) => n + s.endMs - s.startMs, 0)
        if (total < MIN_SPEECH_MS) continue
        items.push({ key: c.key, ranges, total })
      }
      if (!items.length) return
      // fake mode never starts the worker: one deterministic vector per cluster
      if (p.fake) {
        for (const item of items) await matchAndEnroll(id, item.key, fakeVectorFor(item.key), finalName(item.key), spanOf(clusters.get(item.key)!), patches)
        return
      }
      // the lazy speaker-model download, once, on the first opt-in meeting that asks for vectors (fake mode
      // never gets here: no onnx); a failed download lands in the catch and skips profiles for this run
      await p.ensureSpeakerModel()
      const embed = p.embedVectors ?? ((w, ranges) => p.embed!.embed(w, ranges))
      const all = items.flatMap(i => i.ranges)
      const vectors = await embed(wav, all)
      // match every new cluster, then let the strongest cluster claim each profile (one person, one voice)
      const dim = vectors.find(v => v)?.length ?? 0
      if (!dim) return
      const profileRows = p.store.voiceCentroids().filter(pr => pr.dims === dim)
      const scored = items.map((item) => {
        const vec = average(vectors, items, item.key)
        const profiles: ProfileVec[] = profileRows.map(pr => ({ id: pr.id, name: pr.name, centroid: normalize(pr.centroid), meetings: pr.meetings }))
        return { item, vec, match: vec ? bestMatch(normalize(vec), profiles) : null }
      })
      // one person, one voice: the strongest cluster wins a contested profile; the losers keep Speaker N and get no link
      const claimed = new Set<string>()
      const byStrength = [...scored].sort((a, b) => (b.match?.id ? b.match.score : -1) - (a.match?.id ? a.match.score : -1))
      for (const s of byStrength) {
        const vec = s.vec
        if (!vec) continue // every range came back a hole: no trustworthy vector, so no link and no enrollment
        const won = !!s.match?.id && !claimed.has(s.match.id)
        if (won) claimed.add(s.match!.id!)
        await matchAndEnroll(id, s.item.key, normalize(vec), finalName(s.item.key), spanOf(clusters.get(s.item.key)!), patches, won ? s.match : s.match && { id: null, score: s.match.score })
      }
    } catch (e) {
      console.warn('voice profiles skipped:', e instanceof Error ? e.message : e)
    }
  }

  /** the cluster vectors' mean, normalized (None where the worker found too little speech) */
  const average = (vectors: Array<Float32Array | undefined>, items: Array<{ key: string; ranges: Array<{ startMs: number; endMs: number }> }>, key: string): Float32Array | undefined => {
    const at = items.findIndex(i => i.key === key)
    if (at < 0) return undefined
    const from = items.slice(0, at).reduce((n, i) => n + i.ranges.length, 0)
    const got = vectors.slice(from, from + items[at].ranges.length).filter((v): v is Float32Array => !!v && v.length > 0)
    if (!got.length) return undefined
    const out = new Float32Array(got[0].length)
    for (const v of got) for (let i = 0; i < out.length; i++) out[i] += v[i] ?? 0
    return normalize(out)
  }

  const matchAndEnroll = async (id: string, key: string, vec: Float32Array, name: string | null, span: { startMs: number; endMs: number }, patches: Map<string, Patch>, matched?: { id: string; score: number } | { id: null; score: number } | null) => {
    const dims = vec.length
    const profiles: ProfileVec[] = p.store.voiceCentroids().filter(pr => pr.dims === dims).map(pr => ({ id: pr.id, name: pr.name, centroid: normalize(pr.centroid), meetings: pr.meetings }))
    const match = matched === undefined ? bestMatch(normalize(vec), profiles) : matched
    const patch: Patch = {}
    if (match?.id) {
      const profile = profiles.find(pr => pr.id === match.id)!
      // auto-name only fills clusters that are still Speaker N; the profile keeps its own name
      if (!name || SPEAKER_N.test(name)) name = profile.name
      patch.profileId = profile.id
      patch.score = match.score
      if (name === profile.name) {
        // same voice heard again: the stored voiceprint drifts toward what was heard
        const blended = blend(profile.centroid, normalize(vec))
        p.store.updateVoiceCentroid(profile.id, Buffer.from(blended.buffer, blended.byteOffset, blended.byteLength))
      }
    }
    // enrollment: named remote voices only; Speaker N is never enrolled
    if (name && !SPEAKER_N.test(name)) {
      if (match === null) {
        // no high-confidence match at all: a new profile, as long as the name is free
        const taken = new Set(p.store.voiceProfiles().map(pr => pr.name))
        if (!taken.has(name)) {
          const pid = `vp_${id.slice(0, 8)}_${key}`
          const v = normalize(vec)
          p.store.createVoiceProfile({ id: pid, name, model: 'campplus', dims, centroid: Buffer.from(v.buffer, v.byteOffset, v.byteLength) })
          // it was heard in this meeting: the count starts at one, as a match's bump would
          p.store.bumpVoiceProfile(pid)
          patch.profileId = pid
        }
      } else if (match.id && name === profiles.find(pr => pr.id === match.id)!.name) {
        p.store.bumpVoiceProfile(match.id)
      }
      // matched but the names disagree: skip, never contaminate the voiceprint
    }
    patches.set(key, patch)
  }

  return {
    schedule(id: string) {
      // failures were already recorded on the meeting by the job itself; nothing broadcasts for them
      const final = p.queue.enqueue((signal) => job(id, signal), 'diarize', id).catch((e) => {
        console.warn('DIARIZE failed:', e instanceof Error ? e.message : e)
        try { p.store.markDiarized(id, (e instanceof Error ? e.message : String(e)).slice(0, 300)) } catch { /* meeting may be gone */ }
      })
      finals.set(id, final)
    },
    finished: (id: string): Promise<void> => finals.get(id) ?? Promise.resolve(),
  }
}
