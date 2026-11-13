# Local speaker diarization and voice profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Diarize the `them` track of new meetings locally (Nemotron-3-Diarization), split transcript lines at speaker changes using Whisper word timings, reconcile call-app names per voice, add inline rename/merge, and add opt-in local voice profiles that auto-name high-confidence matches in later meetings.

**Architecture:** A post-meeting job decodes the `them` recording with the platform `yogurt-audio` helper, runs `nemo-speech diarize` (built from pinned NeMo-Speech.cpp) to RTTM, splits the saved Whisper word stream at speaker changes, reconciles names per cluster, and persists everything in one store transaction. Speaker embeddings run in an Electron utility process (`sherpa-onnx-node` + CAM++ ONNX) for opt-in cross-meeting voice profiles.

**Tech Stack:** Electron main process (TypeScript, `node:sqlite`), spawned native helpers (Swift/Rust), NeMo-Speech.cpp (`nemo-speech` CLI), `sherpa-onnx-node` 2.0.1, Vitest, Playwright (fake mode).

**Spec:** `docs/superpowers/specs/2026-11-13-local-speaker-diarization-design.md` (approved).

## Global Constraints

- Everything runs locally. The only network traffic is checksum-pinned model downloads. No audio, transcript, embedding, or voiceprint ever leaves the computer.
- Only the `them` track is diarized. `me` is always the local user. No in-person/room mode.
- Post-meeting batch only; no diarization during recording. Job order: `recordingFinished → transcriptFinished → callNames.finished → diarize → notes`.
- No backfill of old meetings. Old rows (`speaker_key IS NULL`, `diarized_at NULL`) render exactly as today.
- Models (verbatim from the spec):
  - Diarization GGUF: `Nemotron-3-Diarization.q8_0.gguf`, 107,012,128 bytes, SHA-256 `08456d9e22cd9a323c0364d98375f3746d6e68507ebb705cd46438c534c7a3a1`, downloaded in normal setup into `models/diarization/`.
  - Speaker ONNX: `3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx`, 28,281,164 bytes, SHA-256 `aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2`, lazy download on first opt-in into `models/speaker/`.
- Diarization runtime: `nemo-speech` built from NeMo-Speech.cpp pinned to commit `c540e21167017d2e34444f2fc2d70649065dc500` (verify it still exists at `https://github.com/NVIDIA/NeMo-Speech.cpp/commit/c540e21167017d2e34444f2fc2d70649065dc500` during Task 10; if the repo moved, pick the newest commit that contains `fix(diar): correct speaker attribution and word timing` and update every place the commit appears). Invocation: `nemo-speech diarize <wav> --model <gguf> --format rttm --output <rttm> [--device <backend>]`. Default (streaming) pass; never `--offline` (it caps at ~6.6 min). Backends: Vulkan (Linux/Windows), Metal (macOS), CPU fallback; `YOGURT_DIARIZE_BACKEND=cpu|vulkan|metal` overrides.
- Naming thresholds (verbatim): `AUTO_NAME_MIN = 0.72`, `AMBIGUOUS_MIN = 0.60`, `BEST_MARGIN = 0.08`; claim rule `≥ 2 s` and `≥ 0.5` of cluster speech; EMA `0.7·old + 0.3·new`, renormalized.
- Alignment constants: turns `< 200 ms` dropped, same-speaker gaps `< 300 ms` merged, nearest-turn window `2000 ms`, enrollment speech `≥ 0.8 s` per range and `≥ 2 s` total.
- `Speaker N` numbers are stable, never compacted; resume numbering continues after the highest existing number. Renaming onto another live voice's name routes to merge. The merge source name stays in `speaker_order` as an unused slot.
- Platforms: macOS Apple Silicon, Windows x64, Linux x86_64. Cross-platform imported recordings (`m4a` on Windows/Linux, `ogg` on macOS) are skipped with a logged reason, no user-facing error.
- Voice profiles: opt-in (`speakerProfiles` setting, off by default), local-only, deletable individually or all; auto-enroll named remote voices only; never enroll `Speaker N`; `profile_id` SET NULL on profile delete; excluded from backup exports.
- All user-visible strings go through `t()`; every non-English locale table must contain every key (`app/test/i18n-tables.test.ts` enforces this).
- Vitest tests live in `app/test/*.test.ts` (run from `app/` with `npm test`, 5 s timeout, 30 s on Windows). E2E tests live in `app/e2e/*.spec.ts` (fake mode, `YOGURT_FAKE=1`). Typecheck with `npm run typecheck`.
- Commit after every task. Never attach audio, embeddings, or similarity scores to logs or crash reports; counts and backend names only.

## File Structure

New files:

| File | Responsibility |
|---|---|
| `app/src/main/diarize/rttm.ts` | RTTM parsing and turn cleanup |
| `app/src/main/diarize/align.ts` | Word-stream alignment, line splitting plan |
| `app/src/main/diarize/naming.ts` | Cluster naming: claims, dedupe, `Speaker N` numbering, key reuse |
| `app/src/main/diarize/match.ts` | Cosine similarity, thresholds, EMA blend |
| `app/src/main/diarize/wav.ts` | WAV read/write helpers (16 kHz mono s16le) |
| `app/src/main/diarize/run.ts` | Spawn decode/nemo-speech, backend selection, CPU fallback, timeouts |
| `app/src/main/diarize/embed-worker.ts` | Utility-process entry: CAM++ embeddings for speech ranges |
| `app/src/main/diarize/embed-client.ts` | Main-process client for the embedding worker |
| `app/src/main/diarize/fake.ts` | Fake diarizer/embeddings for fake mode |
| `app/src/main/diarize/index.ts` | Orchestrator: job lifecycle, persist, notify |
| `app/scripts/nemo-build.mjs` | Builds `nemo-speech` for Windows/Linux |
| `app/test/diarizeStore.test.ts`, `diarizeWords.test.ts`, `diarizeRttm.test.ts`, `diarizeAlign.test.ts`, `diarizeNaming.test.ts`, `diarizeMatch.test.ts`, `diarizeRun.test.ts`, `diarizeEmbed.test.ts`, `diarize.test.ts`, `fakeDiarize.test.ts` | Unit tests, one per module |
| `app/e2e/diarize.spec.ts`, `app/e2e/voiceProfiles.spec.ts` | E2E tests |
| `.github/workflows/diarize-engine.yml` | Real-engine CI (Linux Vulkan/CPU, macOS Metal) |

Modified files:

| File | Change |
|---|---|
| `app/src/main/store.ts` | Migrations, Segment/Meeting fields, diarization/rename/merge/profile store ops |
| `app/src/main/asr/pipeline.ts` | Persist `words` on `them` lines |
| `app/src/main/notes/queue.ts` | `diarize` job kind |
| `app/src/main/notes/index.ts` | (unchanged code) `named` dependency is now injected from `index.ts` |
| `app/src/main/setup.ts` | Diarization model in setup, `installed().diarization`, lazy `ensureSpeakerModel()` |
| `app/src/main/settings.ts` | `speakerProfiles?: boolean` |
| `app/src/main/backup.ts` | Export snapshot scrubs voice profiles |
| `app/src/main/fake.ts` | (no change needed — `fakeDownloadDeps` already covers any URL) |
| `app/src/main/index.ts` | Wire diarizer, IPC, voices_allowed snapshot, temp sweep |
| `app/src/main/engine.ts` | (pattern reference only, no change) |
| `app/src/preload/index.ts`, `app/src/shared/types.ts` | New API surface |
| `app/src/renderer/src/components/Transcript.tsx` | Inline rename/merge UI |
| `app/src/renderer/src/screens/Settings.tsx` | Voice recognition section |
| `app/src/shared/locales/*.json` | New UI strings in all 31 non-English locales |
| `catalog/catalog.json`, `catalog/licenses.json` | Diarization/speaker model + runtime entries |
| `packages/picker/src/catalog-schema.ts`, `packages/picker/src/types.ts`, `packages/picker/test/catalog.test.ts` | Catalog schema for the new entries |
| `app/electron.vite.config.ts` | `diarize-worker` main entry |
| `app/electron-builder.yml` | asarUnpack for worker + sherpa-onnx natives |
| `app/package.json` | `sherpa-onnx-node` dependency |
| `app/scripts/native.mjs`, `app/scripts/native.sh`, `native/yogurt-audio/main.swift`, `native/yogurt-audio-linux/src/*`, `native/yogurt-audio-win/src/*` | `decode` subcommand, `nemo-speech` build |
| `.github/workflows/release.yml` | Build `nemo-speech` in releases |
| `app/test/backup.test.ts` | Updated table lists + export scrub test |

---

### Task 1: Store migrations and diarization operations

**Files:**
- Modify: `app/src/main/store.ts`
- Modify: `app/test/backup.test.ts:143-148` (table lists gain the new tables)
- Test: `app/test/diarizeStore.test.ts` (new)

**Interfaces:**
- Consumes: existing `Store`, `Segment`, `speakerOrder` from `../shared/speakerColors`.
- Produces (used by Tasks 4, 13, 14, 16, 17):
  - `type Word = { text: string; startMs: number; endMs: number }`
  - `Segment` gains `speakerKey?: string | null` and `words?: Word[]`
  - `Meeting` gains `diarizedAt?: number`, `diarizeError: string | null`, `voicesAllowed: boolean`
  - `addSegments` persists `speakerKey`/`words`
  - `applyDiarization(meetingId, a: { deleteIds: number[]; insert: Array<Omit<Segment,'id'>>; speakers: Array<{ key: string; speaker: string | null; profileId?: string | null; score?: number | null; startMs: number; endMs: number }> }): void`
  - `renameSpeaker(meetingId: string, key: string, raw: string): boolean`
  - `mergeSpeakers(meetingId: string, fromKey: string, intoKey: string): boolean`
  - `meetingSpeakers(meetingId: string): Array<{ key: string; profileId: string | null; score: number | null; startMs: number; endMs: number }>`
  - `setVoicesAllowed(id: string, on: boolean): void`
  - `markDiarized(id: string, error?: string): void`
  - `voiceProfiles(): Array<{ id: string; name: string; meetings: number; createdAt: number; updatedAt: number }>`
  - `voiceCentroids(): Array<{ id: string; name: string; model: string; dims: number; centroid: Float32Array; meetings: number }>`
  - `createVoiceProfile(p: { id: string; name: string; model: string; dims: number; centroid: Buffer }): void`
  - `updateVoiceCentroid(id: string, centroid: Buffer): void`
  - `bumpVoiceProfile(id: string): void`
  - `deleteVoiceProfile(id: string): void` / `deleteAllVoiceProfiles(): void`
  - `setMeetingSpeakerProfile(meetingId: string, key: string, patch: { profileId?: string | null; score?: number | null }): void`

- [ ] **Step 1: Write the failing tests**

Create `app/test/diarizeStore.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type Store } from '../src/main/store'

const dirs: string[] = []
const stores: Store[] = []
function fresh(): Store {
  const d = mkdtempSync(join(tmpdir(), 'yogurt-diarize-store-'))
  dirs.push(d)
  const s = openStore(join(d, 'yogurt.db'))
  stores.push(s)
  return s
}
afterEach(() => {
  stores.splice(0).forEach((s) => s.close())
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})
const base = { title: 'Sync', endedAt: null, eventId: null, app: null, attendees: [], state: 'recording' as const }
const words = (t: string, from: number, to: number) => {
  const parts = t.split(' ')
  return parts.map((w, i) => ({ text: w, startMs: from + Math.round((to - from) * i / parts.length), endMs: from + Math.round((to - from) * (i + 1) / parts.length) }))
}

describe('diarization store', () => {
  it('persists speaker_key and words on segments, and maps them back', () => {
    const s = fresh()
    const m = s.createMeeting({ ...base, startedAt: 1 })
    s.addSegments([{ meetingId: m.id, track: 'them', startMs: 100, endMs: 900, text: 'hello there', speaker: null, speakerKey: 'v1', words: words('hello there', 100, 900) }])
    const seg = s.segments(m.id)[0]
    expect(seg.speakerKey).toBe('v1')
    expect(seg.words?.map(w => w.text)).toEqual(['hello', 'there'])
  })

  it('applyDiarization deletes, splits and writes clusters in one transaction', () => {
    const s = fresh()
    const m = s.createMeeting({ ...base, startedAt: 1 })
    s.addSegments([{ meetingId: m.id, track: 'them', startMs: 0, endMs: 2000, text: 'one two', speaker: 'Ann' }])
    const old = s.segments(m.id)[0]
    s.applyDiarization(m.id, {
      deleteIds: [old.id],
      insert: [
        { meetingId: m.id, track: 'them', startMs: 0, endMs: 900, text: 'one', speaker: 'Ann', speakerKey: 'v1', words: words('one', 0, 900) },
        { meetingId: m.id, track: 'them', startMs: 1000, endMs: 2000, text: 'two', speaker: null, speakerKey: 'v2', words: words('two', 1000, 2000) },
      ],
      speakers: [
        { key: 'v1', speaker: 'Ann', startMs: 0, endMs: 900 },
        { key: 'v2', speaker: 'Speaker 1', startMs: 1000, endMs: 2000 },
      ],
    })
    expect(s.segments(m.id).map(x => [x.text, x.speakerKey])).toEqual([['one', 'v1'], ['two', 'v2']])
    expect(s.meetingSpeakers(m.id).map(x => [x.key, x.speaker && null])).toEqual([['v1', null], ['v2', null]])
    expect(s.meetingSpeakers(m.id).map(x => x.startMs)).toEqual([0, 1000])
  })

  it('renameSpeaker renames every row of the voice in place, keeping colour order', () => {
    const s = fresh()
    const m = s.createMeeting({ ...base, startedAt: 1 })
    s.addSegments([
      { meetingId: m.id, track: 'them', startMs: 0, endMs: 900, text: 'a', speaker: 'Speaker 1', speakerKey: 'v1' },
      { meetingId: m.id, track: 'them', startMs: 1000, endMs: 1900, text: 'b', speaker: 'Speaker 2', speakerKey: 'v2' },
    ])
    s.speakerOrder(m.id)
    expect(s.renameSpeaker(m.id, 'v1', '  Ada   Chen ')).toBe(true)
    expect(s.segments(m.id).map(x => x.speaker)).toEqual(['Ada Chen', 'Speaker 2'])
    expect(JSON.parse(String(s.db.prepare('SELECT speaker_order FROM meetings WHERE id = ?').get(m.id)!.speaker_order))).toEqual(['Ada Chen', 'Speaker 2'])
    // unknown key: no
    expect(s.renameSpeaker(m.id, 'vX', 'Zoe')).toBe(false)
  })

  it('renameSpeaker refuses a name another live voice already has (routes to merge)', () => {
    const s = fresh()
    const m = s.createMeeting({ ...base, startedAt: 1 })
    s.addSegments([
      { meetingId: m.id, track: 'them', startMs: 0, endMs: 900, text: 'a', speaker: 'Ada', speakerKey: 'v1' },
      { meetingId: m.id, track: 'them', startMs: 1000, endMs: 1900, text: 'b', speaker: 'Speaker 1', speakerKey: 'v2' },
    ])
    expect(s.renameSpeaker(m.id, 'v2', 'Ada')).toBe(false)
    expect(s.renameSpeaker(m.id, 'v2', 'Ada ')).toBe(false)
  })

  it('renameSpeaker can name a voice that was Them, appending to the colour order', () => {
    const s = fresh()
    const m = s.createMeeting({ ...base, startedAt: 1 })
    s.addSegments([{ meetingId: m.id, track: 'them', startMs: 0, endMs: 900, text: 'a', speaker: null, speakerKey: 'v1' }])
    expect(s.renameSpeaker(m.id, 'v1', 'Bo')).toBe(true)
    expect(s.segments(m.id)[0].speaker).toBe('Bo')
    expect(JSON.parse(String(s.db.prepare('SELECT speaker_order FROM meetings WHERE id = ?').get(m.id)!.speaker_order))).toEqual(['Bo'])
  })

  it('mergeSpeakers moves rows and cluster metadata to the target and keeps the source colour slot', () => {
    const s = fresh()
    const m = s.createMeeting({ ...base, startedAt: 1 })
    s.addSegments([
      { meetingId: m.id, track: 'them', startMs: 0, endMs: 900, text: 'a', speaker: 'Speaker 1', speakerKey: 'v1' },
      { meetingId: m.id, track: 'them', startMs: 1000, endMs: 1900, text: 'b', speaker: 'Speaker 2', speakerKey: 'v2' },
      { meetingId: m.id, track: 'them', startMs: 2000, endMs: 2900, text: 'c', speaker: 'Speaker 3', speakerKey: 'v3' },
    ])
    s.speakerOrder(m.id)
    s.applyDiarization(m.id, { deleteIds: [], insert: [], speakers: [
      { key: 'v1', speaker: 'Speaker 1', profileId: 'p1', score: 0.9, startMs: 0, endMs: 900 },
      { key: 'v2', speaker: 'Speaker 2', startMs: 1000, endMs: 1900 },
    ] })
    expect(s.mergeSpeakers(m.id, 'v2', 'v1')).toBe(true)
    const segs = s.segments(m.id)
    expect(segs.map(x => x.speakerKey)).toEqual(['v1', 'v1', 'v3'])
    expect(segs.map(x => x.speaker)).toEqual(['Speaker 1', 'Speaker 1', 'Speaker 3'])
    const sp = Object.fromEntries(s.meetingSpeakers(m.id).map(x => [x.key, x]))
    expect(sp.v2).toBeUndefined()
    expect(sp.v1).toMatchObject({ startMs: 0, endMs: 1900, profileId: 'p1', score: 0.9 })
    // the source name stays as an unused slot, so Speaker 3 keeps its colour
    expect(JSON.parse(String(s.db.prepare('SELECT speaker_order FROM meetings WHERE id = ?').get(m.id)!.speaker_order))).toEqual(['Speaker 1', 'Speaker 2', 'Speaker 3'])
    expect(s.mergeSpeakers(m.id, 'vX', 'v1')).toBe(false)
    expect(s.mergeSpeakers(m.id, 'v1', 'v1')).toBe(false)
  })

  it('setVoicesAllowed and markDiarized land on the meeting', () => {
    const s = fresh()
    const m = s.createMeeting({ ...base, startedAt: 1 })
    s.setVoicesAllowed(m.id, true)
    expect(s.meeting(m.id)).toMatchObject({ voicesAllowed: true, diarizedAt: undefined, diarizeError: null })
    s.markDiarized(m.id)
    expect(s.meeting(m.id)).toMatchObject({ voicesAllowed: true, diarizeError: null })
    expect(s.meeting(m.id)!.diarizedAt).toBeGreaterThan(0)
    s.markDiarized(m.id, 'nemo-speech failed')
    expect(s.meeting(m.id)).toMatchObject({ diarizeError: 'nemo-speech failed' })
  })

  it('voice profiles: create, list without vectors, bump, update, delete, delete all', () => {
    const s = fresh()
    expect(s.voiceProfiles()).toEqual([])
    s.createVoiceProfile({ id: 'p1', name: 'Ada', model: 'campplus', dims: 192, centroid: Buffer.from([1, 2]) })
    s.createVoiceProfile({ id: 'p2', name: 'Bo', model: 'campplus', dims: 192, centroid: Buffer.from([3]) })
    s.bumpVoiceProfile('p1')
    s.updateVoiceCentroid('p1', Buffer.from([9, 9]))
    expect(s.voiceProfiles().map(p => [p.name, p.meetings])).toEqual([['Ada', 1], ['Bo', 0]])
    expect(Object.keys(s.voiceProfiles()[0])).not.toContain('centroid')
    expect([...s.voiceCentroids().find(p => p.id === 'p1')!.centroid]).toEqual([9, 9])
    expect(s.voiceCentroids().find(p => p.id === 'p1')!.dims).toBe(192)
  })
  it('setMeetingSpeakerProfile fills profile and score without erasing them', () => {
    const s = fresh()
    const m = s.createMeeting({ ...base, startedAt: 1 })
    s.applyDiarization(m.id, { deleteIds: [], insert: [], speakers: [{ key: 'v1', speaker: 'Speaker 1', score: 0.5, startMs: 0, endMs: 100 }] })
    s.setMeetingSpeakerProfile(m.id, 'v1', { profileId: 'p1', score: null })
    expect(s.meetingSpeakers(m.id)[0]).toMatchObject({ profileId: 'p1', score: 0.5 })
    // a meeting_speakers row loses its profile but keeps its name when the profile is deleted
    const m = s.createMeeting({ ...base, startedAt: 2 })
    s.applyDiarization(m.id, { deleteIds: [], insert: [], speakers: [{ key: 'v1', speaker: 'Ada', profileId: 'p1', startMs: 0, endMs: 100 }] })
    s.deleteVoiceProfile('p1')
    expect(s.voiceProfiles().map(p => p.id)).toEqual(['p2'])
    expect(s.meetingSpeakers(m.id)[0].profileId).toBeNull()
    s.deleteAllVoiceProfiles()
    expect(s.voiceProfiles()).toEqual([])
  })
})
```

Note: one assertion above (`setMeetingSpeakerProfile`) belongs to the orchestrator's post-match patch (Task 13 uses it); it is included here so Task 1's store layer is complete in one pass.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd app && npx vitest run test/diarizeStore.test.ts`
Expected: FAIL — `speakerKey`/`words` not on Segment, `applyDiarization` etc. not functions.

- [ ] **Step 3: Implement in `app/src/main/store.ts`**

3a. Types — extend `Segment` (around line 35) and `Meeting`:

```ts
/** A whisper word with its times on meeting time (them lines only, persisted so lines can be re-split without re-transcribing) */
export type Word = { text: string; startMs: number; endMs: number }
export type Segment = { id: number; meetingId: string; track: 'me' | 'them'; startMs: number; endMs: number; text: string; speaker: string | null
  /** an echo of the other side found on the mic: kept, but out of the transcript, notes, search and export until shown again */
  hidden?: boolean
  /** High-confidence echo: retained for recovery, omitted from inline disclosures. */
  echoConfident?: boolean
  /** this line's voice in the meeting, from diarization ('v1', 'v2', …); null for me, Them and undiarized lines */
  speakerKey?: string | null
  /** the line's words (them lines from now on), so diarization can re-split without re-transcribing */
  words?: Word[]
  /** Shared display-only palette index, supplied by the transcript bridge. */
  speakerColor?: number }
```

In `Meeting` (the type near the top), add:

```ts
  /** when the them track was diarized (null: not yet, or it failed) */
  diarizedAt?: number
  /** why diarization did not happen, for diagnostics */
  diarizeError: string | null
  /** voice profiles were allowed to hear this meeting (snapshotted at recording start) */
  voicesAllowed: boolean
```

3b. Row mappers — `toMeeting` gains:

```ts
  diarizeError: r.diarize_error == null ? null : String(r.diarize_error),
  voicesAllowed: Number(r.voices_allowed ?? 0) === 1,
  ...(r.diarized_at == null ? {} : { diarizedAt: Number(r.diarized_at) }),
```

`toSegment` gains:

```ts
  speakerKey: r.speaker_key == null ? null : String(r.speaker_key),
  ...(r.words == null ? {} : { words: JSON.parse(String(r.words)) as Word[] }),
```

(Keep `speakerColor` mapping behaviour unchanged — it is added by the bridge, not the store.)

3c. Migrations in the constructor. After the existing `echo_confident` block (which defines `segmentCols`), add:

```ts
    if (!segmentCols.includes('speaker_key')) this.db.exec('ALTER TABLE segments ADD COLUMN speaker_key TEXT')
    if (!segmentCols.includes('words')) this.db.exec('ALTER TABLE segments ADD COLUMN words TEXT')
    const meetingCols2 = meetingCols
    for (const [name, type] of [['diarized_at', 'INTEGER'], ['diarize_error', 'TEXT'], ['voices_allowed', 'INTEGER NOT NULL DEFAULT 0']] as const) {
      if (!meetingCols2.includes(name)) this.db.exec(`ALTER TABLE meetings ADD COLUMN ${name} ${type}`)
    }
    // voice profiles first: meeting_speakers points at them
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS voice_profiles (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, model TEXT NOT NULL, dims INTEGER NOT NULL,
        centroid BLOB NOT NULL, meetings INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS meeting_speakers (
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        key TEXT NOT NULL, profile_id TEXT REFERENCES voice_profiles(id) ON DELETE SET NULL,
        score REAL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, PRIMARY KEY (meeting_id, key));
    `)
```

(`meetingCols` is already in scope from the earlier migration block.)

3d. `addSegments` (around line 336) — add the two columns:

```ts
    const ins = this.db.prepare('INSERT INTO segments (meeting_id, track, start_ms, end_ms, text, speaker, hidden, echo_confident, speaker_key, words) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    // …
        const r = ins.run(s.meetingId, s.track, s.startMs, s.endMs, s.text, s.speaker, s.hidden ? 1 : 0, s.hidden && s.echoConfident ? 1 : 0, s.speakerKey ?? null, s.words ? JSON.stringify(s.words) : null)
```

3e. New methods on `Store` (place after `setSegmentSpeakers`):

```ts
  /** One transaction: delete the rows being re-split, insert the split runs, write cluster rows. FTS triggers keep search in step. */
  applyDiarization(meetingId: string, a: { deleteIds: number[]; insert: Array<Omit<Segment, 'id'>>; speakers: Array<{ key: string; speaker: string | null; profileId?: string | null; score?: number | null; startMs: number; endMs: number }> }) {
    const del = this.db.prepare('DELETE FROM segments WHERE id = ? AND meeting_id = ?')
    const ins = this.db.prepare('INSERT INTO segments (meeting_id, track, start_ms, end_ms, text, speaker, hidden, echo_confident, speaker_key, words) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    const up = this.db.prepare(`INSERT INTO meeting_speakers (meeting_id, key, profile_id, score, start_ms, end_ms) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(meeting_id, key) DO UPDATE SET profile_id = excluded.profile_id, score = excluded.score, start_ms = excluded.start_ms, end_ms = excluded.end_ms`)
    this.db.exec('BEGIN')
    try {
      for (const id of a.deleteIds) del.run(id, meetingId)
      for (const s of a.insert) {
        const r = ins.run(s.meetingId, s.track, s.startMs, s.endMs, s.text, s.speaker, s.hidden ? 1 : 0, s.hidden && s.echoConfident ? 1 : 0, s.speakerKey ?? null, s.words ? JSON.stringify(s.words) : null)
        if (s.hidden) this.db.prepare("INSERT INTO segments_fts(segments_fts, rowid, text) VALUES ('delete', ?, ?)").run(r.lastInsertRowid, s.text)
      }
      for (const sp of a.speakers) up.run(meetingId, sp.key, sp.profileId ?? null, sp.score ?? null, sp.startMs, sp.endMs)
      this.db.exec('COMMIT')
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
  }

  /** cluster metadata for a meeting */
  meetingSpeakers(meetingId: string): Array<{ key: string; profileId: string | null; score: number | null; startMs: number; endMs: number }> {
    if (!(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meeting_speakers'").get())) return []
    return (this.db.prepare('SELECT key, profile_id, score, start_ms, end_ms FROM meeting_speakers WHERE meeting_id = ? ORDER BY start_ms, key').all(meetingId) as Row[]).map(r => ({
      key: String(r.key), profileId: r.profile_id == null ? null : String(r.profile_id), score: r.score == null ? null : Number(r.score), startMs: Number(r.start_ms), endMs: Number(r.end_ms),
    }))
  }

  /** The person renames a voice: every line of that voice, in place in the colour order. Renaming onto another live voice's name is refused (that is a merge). */
  renameSpeaker(meetingId: string, key: string, raw: string): boolean {
    const name = raw.replace(/\s+/g, ' ').trim().slice(0, 80)
    if (!name || !key) return false
    const rows = this.db.prepare("SELECT id, speaker FROM segments WHERE meeting_id = ? AND track = 'them' AND speaker_key = ? AND hidden = 0").all(meetingId, key) as Row[]
    if (!rows.length) return false
    const old = rows[0].speaker == null ? null : String(rows[0].speaker)
    const live = (this.db.prepare("SELECT DISTINCT speaker FROM segments WHERE meeting_id = ? AND track = 'them' AND speaker_key IS NOT NULL AND speaker IS NOT NULL AND hidden = 0").all(meetingId) as Row[]).map(r => String(r.speaker))
    if (live.some(n => n !== old && n === name)) return false
    const row = this.db.prepare('SELECT speaker_order FROM meetings WHERE id = ?').get(meetingId) as Row | undefined
    const order = JSON.parse(String(row?.speaker_order ?? '[]')) as string[]
    const next = old && order.includes(old) ? order.map(n => n === old ? name : n) : speakerOrder(order, [name])
    this.db.exec('BEGIN')
    try {
      const up = this.db.prepare('UPDATE segments SET speaker = ? WHERE id = ?')
      for (const r of rows) up.run(name, Number(r.id))
      this.db.prepare('UPDATE meetings SET speaker_order = ? WHERE id = ?').run(JSON.stringify(next), meetingId)
      this.db.exec('COMMIT')
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
    return true
  }

  /** Two voices are one person: the source's rows and cluster metadata join the target. The source's colour slot stays, so nobody else's colour moves. */
  mergeSpeakers(meetingId: string, fromKey: string, intoKey: string): boolean {
    if (!fromKey || !intoKey || fromKey === intoKey) return false
    const segs = this.db.prepare("SELECT speaker_key FROM segments WHERE meeting_id = ? AND track = 'them' AND speaker_key IN (?, ?) AND hidden = 0").all(meetingId, fromKey, intoKey) as Row[]
    const has = (k: string) => segs.some(r => r.speaker_key === k)
    if (!has(fromKey) || !has(intoKey)) return false
    const nameOf = (k: string) => { const r = this.db.prepare("SELECT speaker FROM segments WHERE meeting_id = ? AND speaker_key = ? AND speaker IS NOT NULL AND hidden = 0 LIMIT 1").get(meetingId, k) as Row | undefined; return r?.speaker == null ? null : String(r.speaker) }
    const name = nameOf(intoKey) ?? nameOf(fromKey)
    const fromSp = this.db.prepare('SELECT * FROM meeting_speakers WHERE meeting_id = ? AND key = ?').get(meetingId, fromKey) as Row | undefined
    const intoSp = this.db.prepare('SELECT * FROM meeting_speakers WHERE meeting_id = ? AND key = ?').get(meetingId, intoKey) as Row | undefined
    this.db.exec('BEGIN')
    try {
      this.db.prepare('UPDATE segments SET speaker_key = ?, speaker = ? WHERE meeting_id = ? AND speaker_key = ?').run(intoKey, name, meetingId, fromKey)
      this.db.prepare('DELETE FROM meeting_speakers WHERE meeting_id = ? AND key = ?').run(meetingId, fromKey)
      if (intoSp && fromSp) this.db.prepare('UPDATE meeting_speakers SET start_ms = ?, end_ms = ?, profile_id = COALESCE(profile_id, ?), score = COALESCE(score, ?) WHERE meeting_id = ? AND key = ?')
        .run(Math.min(Number(intoSp.start_ms), Number(fromSp.start_ms)), Math.max(Number(intoSp.end_ms), Number(fromSp.end_ms)), fromSp.profile_id ?? null, fromSp.score ?? null, meetingId, intoKey)
      this.db.exec('COMMIT')
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
    return true
  }

  /** snapshot at recording start: enabling profiles mid-call must not capture a call already in progress */
  setVoicesAllowed(id: string, on: boolean) { this.db.prepare('UPDATE meetings SET voices_allowed = ? WHERE id = ?').run(on ? 1 : 0, id) }
  /** diarization done (error: recorded on the meeting instead, the transcript stays usable) */
  markDiarized(id: string, error?: string) { this.db.prepare('UPDATE meetings SET diarized_at = ?, diarize_error = ? WHERE id = ?').run(error ? null : Date.now(), error ?? null, id) }

  /** profiles for Settings: names and counts only, never the vectors */
  voiceProfiles(): Array<{ id: string; name: string; meetings: number; createdAt: number; updatedAt: number }> {
    return (this.db.prepare('SELECT id, name, meetings, created_at, updated_at FROM voice_profiles ORDER BY created_at').all() as Row[]).map(r =>
      ({ id: String(r.id), name: String(r.name), meetings: Number(r.meetings), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) }))
  }
  /** full rows for matching, main process only (never over IPC) */
  voiceCentroids(): Array<{ id: string; name: string; model: string; dims: number; centroid: Float32Array; meetings: number }> {
    return (this.db.prepare('SELECT id, name, model, dims, centroid, meetings FROM voice_profiles ORDER BY created_at').all() as Row[]).map(r => {
      const buf = Buffer.from(r.centroid as Uint8Array)
      const centroid = new Float32Array(Number(r.dims))
      for (let i = 0; i < centroid.length && buf.length >= (i + 1) * 4; i++) centroid[i] = buf.readFloatLE(i * 4)
      return { id: String(r.id), name: String(r.name), model: String(r.model), dims: Number(r.dims), centroid, meetings: Number(r.meetings) }
    })
  }
  createVoiceProfile(p: { id: string; name: string; model: string; dims: number; centroid: Buffer }) {
    const now = Date.now()
    this.db.prepare('INSERT INTO voice_profiles (id, name, model, dims, centroid, meetings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)').run(p.id, p.name, p.model, p.dims, p.centroid, now, now)
  }
  updateVoiceCentroid(id: string, centroid: Buffer) { this.db.prepare('UPDATE voice_profiles SET centroid = ?, updated_at = ? WHERE id = ?').run(centroid, Date.now(), id) }
  bumpVoiceProfile(id: string) { this.db.prepare('UPDATE voice_profiles SET meetings = meetings + 1 WHERE id = ?').run(id) }
  deleteVoiceProfile(id: string) { this.db.prepare('DELETE FROM voice_profiles WHERE id = ?').run(id) }
  deleteAllVoiceProfiles() { this.db.exec('DELETE FROM voice_profiles') }
  /** diarization's profile-match outcome for one cluster, after the split transaction; COALESCE keeps what was there */
  setMeetingSpeakerProfile(meetingId: string, key: string, patch: { profileId?: string | null; score?: number | null }) {
    this.db.prepare('UPDATE meeting_speakers SET profile_id = COALESCE(?, profile_id), score = COALESCE(?, score) WHERE meeting_id = ? AND key = ?')
      .run(patch.profileId ?? null, patch.score ?? null, meetingId, key)
  }
```

3f. Update `app/test/backup.test.ts:143-148` so the table inventory accepts the new tables (the export scrub comes in Task 17):

```ts
    expect(meetingTables(s.db).map((t) => t.table).sort()).toEqual(['chat_turns', 'folder_meetings', 'library_chunks', 'library_sources', 'meeting_speakers', 'notes', 'segments'])
    // a new table that is not tied to a meeting would be left out of backups: decide what a backup does with it, then list it here
    const all = (s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'").all() as Array<{ name: string }>).map((r) => r.name)
    expect(all.filter((t) => t !== 'meetings' && !meetingTables(s.db).some((m) => m.table === t)).sort()).toEqual(['conversation_turns', 'conversations', 'folders', 'people', 'voice_profiles'])
```

(`meeting_speakers` has an FK to meetings, so `meetingTables` picks it up; `voice_profiles` has none and is deliberately excluded from backups — Task 17.)

- [ ] **Step 4: Run the tests**

Run: `cd app && npx vitest run test/diarizeStore.test.ts test/backup.test.ts test/store.test.ts`
Expected: PASS (all three files).

- [ ] **Step 5: Commit**

```bash
git add app/src/main/store.ts app/test/diarizeStore.test.ts app/test/backup.test.ts
git commit -m "feat(store): diarization schema, rename/merge and voice profile operations"
```

---

### Task 2: Persist Whisper words on them lines

**Files:**
- Modify: `app/src/main/asr/pipeline.ts` (`out()`, around line 106)
- Test: `app/test/diarizeWords.test.ts` (new)

**Interfaces:**
- Consumes: `Line.words` (already on the type, live view only today).
- Produces: `them` segments saved with `words`; `me` lines never carry words (they can't be re-split and would only grow the database).

- [ ] **Step 1: Write the failing test**

Create `app/test/diarizeWords.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { createPipeline } from '../src/main/asr/pipeline'
import type { Chunk } from '../src/main/asr/chunker'

const chunk = (track: 'me' | 'them', startMs: number): Chunk => ({ track, startMs, samples: new Float32Array(1600), clearMs: 1600 })

describe('pipeline saves words for re-splitting', () => {
  it('saves whisper's words on them lines, and none on me lines', async () => {
    const save = vi.fn()
    const p = createPipeline({ meetingId: 'm1', save, emit: () => {}, holdMs: 0, extraWaitMs: 0,
      transcribe: async (c) => c.track === 'them'
        ? [{ track: 'them', startMs: 0, endMs: 2000, text: 'hello there', words: [{ text: 'hello', startMs: 0, endMs: 800 }, { text: 'there', startMs: 900, endMs: 2000 }] }]
        : [{ track: 'me', startMs: 0, endMs: 1000, text: 'hi', words: [{ text: 'hi', startMs: 0, endMs: 1000 }] }] })
    p.push('them', 0, chunk('them', 0).samples)
    p.push('me', 3000, chunk('me', 3000).samples)
    await p.finish()
    const segs = save.mock.calls.flat() as Array<{ track: string; words?: unknown[] }>
    expect(segs.find(s => s.track === 'them')!.words).toEqual([{ text: 'hello', startMs: 0, endMs: 800 }, { text: 'there', startMs: 900, endMs: 2000 }])
    expect(segs.find(s => s.track === 'me')!.words).toBeUndefined()
  })
  it('saves a them line without words as a line without words', async () => {
    const save = vi.fn()
    const p = createPipeline({ meetingId: 'm1', save, emit: () => {}, transcribe: async () => [{ track: 'them', startMs: 0, endMs: 500, text: 'ok' }] })
    p.push('them', 0, chunk('them', 0).samples)
    await p.finish()
    expect((save.mock.calls.flat() as unknown[])[0]).not.toHaveProperty('words')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd app && npx vitest run test/diarizeWords.test.ts`
Expected: FAIL — saved segments have no `words`.

- [ ] **Step 3: Implement in `app/src/main/asr/pipeline.ts`**

Replace `out` (around line 106):

```ts
  // the mic's words never get saved (its lines are never re-split); the other side's are, so diarization can re-split without re-transcribing
  const out = (l: Line, hidden = false): Out => ({ meetingId: p.meetingId, track: l.track, startMs: l.startMs, endMs: l.endMs, text: spell(l.text), speaker: speakerOf(l),
    ...(l.track === 'them' && l.words?.length ? { words: l.words.map(w => ({ text: w.text, startMs: w.startMs, endMs: w.endMs })) } : {}),
    ...(hidden ? { hidden: true } : {}) })
```

(`Out = Omit<Segment, 'id'>` already carries the optional fields after Task 1. `hidden` echo lines of the `them` track do not exist in practice, but if one appears it keeps its words — harmless.)

- [ ] **Step 4: Run the tests**

Run: `cd app && npx vitest run test/diarizeWords.test.ts test/pipeline.test.ts`
Expected: PASS (both files — existing pipeline behaviour unchanged).

- [ ] **Step 5: Commit**

```bash
git add app/src/main/asr/pipeline.ts app/test/diarizeWords.test.ts
git commit -m "feat(asr): persist whisper word timings on them lines"
```

---

### Task 3: RTTM parsing and turn cleanup

**Files:**
- Create: `app/src/main/diarize/rttm.ts`
- Test: `app/test/diarizeRttm.test.ts` (new)

**Interfaces:**
- Produces (used by Tasks 4, 13):
  - `export type Turn = { key: string; startMs: number; endMs: number }`
  - `export const MIN_TURN_MS = 200`
  - `export const MERGE_GAP_MS = 300`
  - `export function parseRttm(text: string): Turn[]`
  - `export function cleanTurns(turns: Turn[]): Turn[]`

- [ ] **Step 1: Write the failing tests**

Create `app/test/diarizeRttm.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { MIN_TURN_MS, MERGE_GAP_MS, cleanTurns, parseRttm } from '../src/main/diarize/rttm'

const rttm = (speaker: string, start: number, dur: number, file = 'them') => `SPEAKER ${file} 1 ${start.toFixed(3)} ${dur.toFixed(3)} <NA> <NA> ${speaker} <NA> <NA>`

describe('parseRttm', () => {
  it('reads SPEAKER lines into ms turns', () => {
    expect(parseRttm(`${rttm('0', 1.5, 2.25)}\n${rttm('1', 4, 0.5)}`)).toEqual([
      { key: '0', startMs: 1500, endMs: 3750 },
      { key: '1', startMs: 4000, endMs: 4500 },
    ])
  })
  it('skips malformed lines and keeps the rest', () => {
    expect(parseRttm(['not rttm', rttm('0', 0, 1), 'SPEAKER x', `${rttm('1', 2, 1)} extra tail`].join('\n')).map(t => t.key)).toEqual(['0', '1'])
  })
  it('drops zero and negative durations', () => {
    expect(parseRttm(`${rttm('0', 0, 0)}\n${rttm('0', 0, -1)}\n${rttm('0', 0, 0.5)}`)).toEqual([{ key: '0', startMs: 0, endMs: 500 }])
  })
})

describe('cleanTurns', () => {
  it(`drops turns under ${MIN_TURN_MS} ms`, () => {
    expect(cleanTurns([{ key: 'a', startMs: 0, endMs: 199 }, { key: 'a', startMs: 1000, endMs: 1500 }])).toEqual([{ key: 'a', startMs: 1000, endMs: 1500 }])
  })
  it(`merges same-speaker turns under ${MERGE_GAP_MS} ms apart, and keeps other speakers apart`, () => {
    expect(cleanTurns([{ key: 'a', startMs: 0, endMs: 1000 }, { key: 'a', startMs: 1200, endMs: 2000 }, { key: 'b', startMs: 2100, endMs: 3000 }])).toEqual([
      { key: 'a', startMs: 0, endMs: 2000 },
      { key: 'b', startMs: 2100, endMs: 3000 },
    ])
  })
  it('keeps overlaps as they are (the dominant turn wins per word later)', () => {
    expect(cleanTurns([{ key: 'a', startMs: 0, endMs: 2000 }, { key: 'b', startMs: 1000, endMs: 3000 }])).toHaveLength(2)
  })
  it('sorts by start', () => {
    expect(cleanTurns([{ key: 'b', startMs: 5000, endMs: 6000 }, { key: 'a', startMs: 0, endMs: 1000 }])[0].key).toBe('a')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd app && npx vitest run test/diarizeRttm.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `app/src/main/diarize/rttm.ts`**

```ts
/**
 * One voice's turn in the recording, on meeting time. `key` is the diarizer's own label for the voice
 * (remapped to this meeting's stable keys later).
 */
export type Turn = { key: string; startMs: number; endMs: number }
export const MIN_TURN_MS = 200
export const MERGE_GAP_MS = 300

/**
 * RTTM (`SPEAKER <file> 1 <start>s <dur>s <NA> <NA> <speaker> <NA> <NA>`, seconds), one voice per line.
 * Malformed lines are skipped; zero valid turns means the meeting is left as it is.
 */
export function parseRttm(text: string): Turn[] {
  const turns: Turn[] = []
  for (const line of text.split('\n')) {
    const p = line.trim().split(/\s+/)
    if (p[0] !== 'SPEAKER' || p.length < 8) continue
    const start = Number(p[3]), dur = Number(p[4]), key = p[7]
    if (!Number.isFinite(start) || !Number.isFinite(dur) || dur <= 0 || !key) continue
    turns.push({ key, startMs: Math.round(start * 1000), endMs: Math.round((start + dur) * 1000) })
  }
  return turns.sort((a, b) => a.startMs - b.startMs)
}

/** drop sub-200 ms turns, close same-voice gaps under 300 ms; overlaps stay (alignment picks the dominant turn per word) */
export function cleanTurns(turns: Turn[]): Turn[] {
  const out: Turn[] = []
  for (const t of turns.filter(t => t.endMs - t.startMs >= MIN_TURN_MS)) {
    const last = out[out.length - 1]
    if (last && last.key === t.key && t.startMs - last.endMs < MERGE_GAP_MS) last.endMs = Math.max(last.endMs, t.endMs)
    else out.push({ ...t })
  }
  return out.sort((a, b) => a.startMs - b.startMs)
}
```

- [ ] **Step 4: Run the tests**

Run: `cd app && npx vitest run test/diarizeRttm.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/diarize/rttm.ts app/test/diarizeRttm.test.ts
git commit -m "feat(diarize): rttm parsing and turn cleanup"
```

---

### Task 4: Word-stream alignment

**Files:**
- Create: `app/src/main/diarize/align.ts`
- Test: `app/test/diarizeAlign.test.ts` (new)

**Interfaces:**
- Consumes: `Turn` from `./rttm`, `Word` from `../store`, `joinWords` from `../../shared/liveWords`.
- Produces (used by Task 13):
  - `export const NEAR_MS = 2000`
  - `export type SplitRow = { id: number; startMs: number; endMs: number; text: string; speaker: string | null; words?: Word[] }`
  - `export type SplitRun = { lineIds: number[]; key: string | null; startMs: number; endMs: number; text: string; speaker: string | null; words: Word[] }`
  - `export function splitPlan(rows: SplitRow[], turns: Turn[], spell: (t: string) => string): { keep: number[]; runs: SplitRun[] }`
  - `export function lineTurn(line: { startMs: number; endMs: number }, turns: Turn[]): Turn | null` (whole-line fallback)
  - `export function evidenceName(claims: Array<{ name: string | null; ms: number }>): string | null`

- [ ] **Step 1: Write the failing tests**

Create `app/test/diarizeAlign.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { NEAR_MS, evidenceName, lineTurn, splitPlan, type SplitRow } from '../src/main/diarize/align'
import type { Turn } from '../src/main/diarize/rttm'

const identity = (t: string) => t
const w = (text: string, startMs: number, endMs: number) => ({ text, startMs, endMs })
const row = (id: number, text: string, startMs: number, endMs: number, speaker: string | null = null): SplitRow =>
  ({ id, text, startMs, endMs, speaker, words: text.split(' ').map((t, i, a) => w(t, startMs + i * Math.round((endMs - startMs) / a.length), startMs + (i + 1) * Math.round((endMs - startMs) / a.length))) })
const turns: Turn[] = [{ key: 'v1', startMs: 0, endMs: 1000 }, { key: 'v2', startMs: 2000, endMs: 4000 }]

describe('splitPlan', () => {
  it('splits one line across a speaker change, one row per voice', () => {
    const { keep, runs } = splitPlan([row(1, 'hello there friend', 0, 3000)], turns, identity)
    expect(keep).toEqual([])
    expect(runs.map(r => [r.key, r.text])).toEqual([['v1', 'hello'], ['v2', 'there friend']])
    expect(runs[0].startMs).toBe(0)
    expect(runs[1].endMs).toBe(3000)
    expect(runs.every(r => r.lineIds.includes(1))).toBe(true)
    expect(runs[0].words.map(x => x.text)).toEqual(['hello'])
  })
  it('joins consecutive words of one voice across line boundaries', () => {
    const { runs } = splitPlan([row(1, 'hello there', 0, 2000), row(2, 'friend', 2400, 3000)], turns, identity)
    expect(runs.map(r => [r.key, r.text])).toEqual([['v1', 'hello'], ['v2', 'there friend']])
    expect(runs[1].lineIds).toEqual([1, 2])
  })
  it('words with no turn inside 2 s stay with their line: untouched rows keep their id', () => {
    const far: Turn[] = [{ key: 'v1', startMs: 0, endMs: 500 }]
    const { keep, runs } = splitPlan([row(1, 'hello', 0, 500), row(2, 'lost words here', 10000, 12000)], far, identity)
    expect(keep).toEqual([2])
    expect(runs.map(r => r.key)).toEqual(['v1'])
  })
  it('a line with both assigned and unassigned words keeps an unsplit remainder', () => {
    const mid: Turn[] = [{ key: 'v1', startMs: 0, endMs: 400 }]
    const { keep, runs } = splitPlan([row(1, 'hello lost words', 0, 1200)], mid, identity)
    expect(keep).toEqual([])
    expect(runs.map(r => [r.key, r.text])).toEqual([['v1', 'hello'], [null, 'lost words']])
    expect(runs[1].speaker).toBeNull()
  })
  it('a run's evidence name is the duration-weighted majority of its source lines' call names', () => {
    const ann = row(1, 'hello there friend', 0, 3000, 'Ann Lee')
    const { runs } = splitPlan([ann], turns, identity)
    expect(runs.map(r => r.speaker)).toEqual(['Ann Lee', 'Ann Lee'])
    const mixed = [{ ...row(1, 'a b', 0, 2000, 'Ann Lee') }, { ...row(2, 'c d', 2000, 4000, 'Bo Park') }]
    const cross: Turn[] = [{ key: 'v1', startMs: 0, endMs: 3000 }]
    expect(splitPlan(mixed, cross, identity).runs.map(r => r.speaker)).toEqual(['Ann Lee'])
  })
  it('glues punctuation without a space, like the live view does', () => {
    const glued: SplitRow = { id: 1, text: 'Sure.', startMs: 0, endMs: 500, speaker: null, words: [w('Sure', 0, 400), w('.', 400, 500)] }
    expect(splitPlan([glued], [{ key: 'v1', startMs: 0, endMs: 500 }], identity).runs[0].text).toBe('Sure.')
  })
  it('passes the text through the spell normalizer', () => {
    expect(splitPlan([row(1, 'aple', 0, 400)], [{ key: 'v1', startMs: 0, endMs: 400 }], t => t.replace('aple', 'apple')).runs[0].text).toBe('apple')
  })
  it('lines whisper gave no words for fall back to whole-line max overlap', () => {
    const noWords: SplitRow = { id: 1, text: 'old line', startMs: 1000, endMs: 3000, speaker: 'Ann Lee' }
    const { keep, runs } = splitPlan([noWords], turns, identity)
    expect(keep).toEqual([1])
    expect(lineTurn(noWords, turns)?.key).toBe('v2')
    expect(lineTurn({ startMs: 10000, endMs: 11000 }, turns)).toBeNull()
  })
})

describe('evidenceName', () => {
  it('picks the named claim with the most speech', () => {
    expect(evidenceName([{ name: null, ms: 900 }, { name: 'Ann', ms: 500 }, { name: 'Bo', ms: 400 }])).toBe('Ann')
  })
  it('ignores null (Them) claims entirely', () => {
    expect(evidenceName([{ name: null, ms: 900 }, { name: 'Ann', ms: 100 }])).toBe('Ann')
    expect(evidenceName([{ name: null, ms: 900 }])).toBeNull()
  })
  it('ties go to the earliest claim', () => {
    expect(evidenceName([{ name: 'Ann', ms: 400 }, { name: 'Bo', ms: 400 }])).toBe('Ann')
  })
})
```

Note: `NEAR_MS` is imported by the test only to pin the constant; the behaviour lives in `lineTurn`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd app && npx vitest run test/diarizeAlign.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `app/src/main/diarize/align.ts`**

```ts
import { joinWords } from '../../shared/liveWords'
import type { Word } from '../store'
import type { Turn } from './rttm'

/** a word whose turn is farther than this from anything the diarizer heard stays Them */
export const NEAR_MS = 2000

/** a them row being re-split (as the store maps it) */
export type SplitRow = { id: number; startMs: number; endMs: number; text: string; speaker: string | null; words?: Word[] }
/** one row of the new transcript: a voice's run of words, or the unsplit remainder of a line */
export type SplitRun = { lineIds: number[]; key: string | null; startMs: number; endMs: number; text: string; speaker: string | null; words: Word[] }

const overlap = (a: { startMs: number; endMs: number }, b: { startMs: number; endMs: number }) => Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs))

/** the turn with the greatest overlap (ties to the earlier turn); none, the nearest turn within 2 s; else null */
function turnFor(span: { startMs: number; endMs: number }, turns: Turn[]): Turn | null {
  let best: Turn | null = null, bestOv = 0
  for (const t of turns) { const ov = overlap(span, t); if (ov > bestOv) { best = t; bestOv = ov } }
  if (best) return best
  let near: Turn | null = null, gap = Infinity
  for (const t of turns) {
    const d = span.startMs >= t.endMs ? span.startMs - t.endMs : t.startMs >= span.endMs ? t.startMs - span.endMs : 0
    if (d < gap) { near = t; gap = d }
  }
  return gap <= NEAR_MS ? near : null
}

/** lines whisper gave no words for: the whole line goes to the turn it overlaps most */
export function lineTurn(line: { startMs: number; endMs: number }, turns: Turn[]): Turn | null { return turnFor(line, turns) }

/** a run's evidence name: the named call-app claim with the most speech (ties to the earliest); Them never claims */
export function evidenceName(claims: Array<{ name: string | null; ms: number }>): string | null {
  let best: string | null = null, bestMs = 0
  for (const c of claims) if (c.name && c.ms > bestMs) { best = c.name; bestMs = c.ms }
  return best
}

/**
 * The whole ordered word stream of the rows being diarized, split at speaker changes. Whisper's line boundaries
 * are arbitrary and often straddle a speaker change, so words are placed per turn, not per line.
 * Rows with no words (or no word the diarizer heard) stay as they are.
 */
export function splitPlan(rows: SplitRow[], turns: Turn[], spell: (t: string) => string): { keep: number[]; runs: SplitRun[] } {
  const keep = rows.filter(r => !r.words?.length).map(r => r.id)
  const runs: SplitRun[] = []
  const push = (lineIds: number[], key: string | null, words: Word[], claims: Map<string | null, number>, fallbackSpeaker: string | null) => {
    const startMs = words[0].startMs, endMs = words[words.length - 1].endMs
    runs.push({ lineIds, key, startMs, endMs, text: spell(joinWords(words)), speaker: key ? evidenceName([...claims].map(([name, ms]) => ({ name, ms }))) : fallbackSpeaker, words })
  }
  for (const row of rows) {
    const words = row.words ?? []
    // lines with words but no turn at all: kept whole (nothing changes for them)
    const assigned = words.filter(w => turnFor(w, turns))
    if (!assigned.length) { keep.push(row.id); continue }
    let curKey: string | null | undefined, curWords: Word[] = [], curClaims = new Map<string | null, number>(), curLines: number[] = []
    const flush = () => { if (curWords.length) push(curLines, curKey, curWords, curClaims, curKey ? row.speaker : null) }
    for (const word of words) {
      const t = turnFor(word, turns)
      const key = t?.key ?? null
      const sameRun = key !== null && curKey === key
      const sameLeftover = key === null && curKey === null && curWords.length > 0
      if (sameRun || sameLeftover) { curWords.push(word); curClaims.set(row.speaker, (curClaims.get(row.speaker) ?? 0) + (word.endMs - word.startMs)) }
      else { flush(); curKey = key; curWords = [word]; curClaims = new Map([[row.speaker, word.endMs - word.startMs]]); curLines = [] }
      if (!curLines.includes(row.id)) curLines.push(row.id)
    }
    flush()
  }
  return { keep, runs }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd app && npx vitest run test/diarizeAlign.test.ts`
Expected: PASS. (If the "mixed speakers" or "glue" case fails, fix `splitPlan` — the test encodes the spec.)

- [ ] **Step 5: Commit**

```bash
git add app/src/main/diarize/align.ts app/test/diarizeAlign.test.ts
git commit -m "feat(diarize): split the them word stream at speaker changes"
```

---

### Task 5: Cluster naming

**Files:**
- Create: `app/src/main/diarize/naming.ts`
- Test: `app/test/diarizeNaming.test.ts` (new)

**Interfaces:**
- Produces (used by Task 13):
  - `export const CLAIM_MIN_MS = 2000`
  - `export const CLAIM_SHARE = 0.5`
  - `export function reuseKeys(turns: Turn[], existing: Array<{ key: string; startMs: number; endMs: number }>): Map<string, string>`
  - `export function nextSpeakerNumber(names: readonly string[]): number`
  - `export function resolveNames(clusters: Array<{ key: string; claims: Array<{ name: string | null; ms: number }>; total: number }>, opts: { taken: readonly string[]; startNumber: number }): Array<{ key: string; speaker: string | null }>`

- [ ] **Step 1: Write the failing tests**

Create `app/test/diarizeNaming.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { CLAIM_MIN_MS, CLAIM_SHARE, nextSpeakerNumber, resolveNames, reuseKeys } from '../src/main/diarize/naming'
import type { Turn } from '../src/main/diarize/rttm'

describe('reuseKeys', () => {
  it('a new turn overlapping an old cluster by more than half its duration joins it', () => {
    const existing = [{ key: 'v1', startMs: 0, endMs: 5000 }]
    const turns: Turn[] = [{ key: 'a', startMs: 4000, endMs: 6000 }, { key: 'b', startMs: 8000, endMs: 9000 }]
    expect(reuseKeys(turns, existing).get('a')).toBe('v1')
    expect(reuseKeys(turns, existing).has('b')).toBe(false)
  })
  it('exactly half is not a reuse', () => {
    const existing = [{ key: 'v1', startMs: 0, endMs: 2000 }]
    expect(reuseKeys([{ key: 'a', startMs: 1000, endMs: 3000 }], existing).has('a')).toBe(false)
  })
})

describe('nextSpeakerNumber', () => {
  it('continues after the highest existing Speaker N, so a new voice never collides', () => {
    expect(nextSpeakerNumber([])).toBe(1)
    expect(nextSpeakerNumber(['Ann Lee', 'Speaker 1', 'Speaker 3'])).toBe(4)
  })
})

describe('resolveNames', () => {
  const cluster = (key: string, name: string | null, ms: number) => ({ key, claims: [{ name, ms }], total: ms })
  it(`keeps a call-app name claiming at least ${CLAIM_MIN_MS} ms and ${CLAIM_SHARE * 100}% of the cluster`, () => {
    expect(resolveNames([cluster('v1', 'Ann Lee', 3000)], { taken: [], startNumber: 1 })).toEqual([{ key: 'v1', speaker: 'Ann Lee' }])
    expect(resolveNames([cluster('v1', 'Ann Lee', 1999)], { taken: [], startNumber: 1 })).toEqual([{ key: 'v1', speaker: null }])
    expect(resolveNames([{ key: 'v1', claims: [{ name: 'Ann Lee', ms: 2000 }, { name: null, ms: 2000 }], total: 4000 }], { taken: [], startNumber: 1 }))
      .toEqual([{ key: 'v1', speaker: null }])
  })
  it('one person is one voice: a weaker cluster claiming the same name drops to Speaker N', () => {
    const a = { key: 'v1', claims: [{ name: 'Ann Lee', ms: 5000 }], total: 5000 }
    const b = { key: 'v2', claims: [{ name: 'Ann Lee', ms: 2500 }], total: 2500 }
    const out = resolveNames([a, b], { taken: [], startNumber: 1 })
    expect(out).toEqual([{ key: 'v1', speaker: 'Ann Lee' }, { key: 'v2', speaker: 'Speaker 1' }])
  })
  it('unnamed clusters number in first-appearance order; taken names are skipped', () => {
    const out = resolveNames([cluster('v1', null, 1000), cluster('v2', null, 1000)], { taken: ['Speaker 2'], startNumber: 3 })
    expect(out).toEqual([{ key: 'v1', speaker: 'Speaker 3' }, { key: 'v2', speaker: 'Speaker 4' }])
  })
  it('reused (taken) names are not reassigned; a resumed meeting's numbers continue', () => {
    const out = resolveNames([cluster('v1', 'Bo Park', 3000)], { taken: ['Bo Park'], startNumber: 2 })
    expect(out).toEqual([{ key: 'v1', speaker: 'Speaker 2' }])
  })
  it('named clusters do not consume numbers', () => {
    const out = resolveNames([cluster('v1', null, 1000), cluster('v2', 'Ann Lee', 3000)], { taken: [], startNumber: 5 })
    expect(out).toEqual([{ key: 'v1', speaker: 'Speaker 5' }, { key: 'v2', speaker: 'Ann Lee' }])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd app && npx vitest run test/diarizeNaming.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `app/src/main/diarize/naming.ts`**

```ts
import type { Turn } from './rttm'

export const CLAIM_MIN_MS = 2000
export const CLAIM_SHARE = 0.5

/** a resumed meeting's new turn that overlaps an old cluster by more than half its duration joins it (keeps its name) */
export function reuseKeys(turns: Turn[], existing: Array<{ key: string; startMs: number; endMs: number }>): Map<string, string> {
  const map = new Map<string, string>()
  for (const t of turns) {
    const dur = t.endMs - t.startMs
    for (const e of existing) {
      const ov = Math.max(0, Math.min(t.endMs, e.endMs) - Math.max(t.startMs, e.startMs))
      if (dur > 0 && ov > dur / 2) { map.set(t.key, e.key); break }
    }
  }
  return map
}

/** numbering continues after the highest Speaker N already shown; numbers are stable, never compacted */
export function nextSpeakerNumber(names: readonly string[]): number {
  let max = 0
  for (const n of names) { const m = /^Speaker (\d+)$/.exec(n); if (m) max = Math.max(max, Number(m[1])) }
  return max + 1
}

export type Cluster = { key: string; claims: Array<{ name: string | null; ms: number }>; total: number }

/**
 * One name per voice. A call-app name wins when it claims ≥ 2 s and ≥ half the cluster's speech; when two
 * clusters claim the same person, the stronger keeps it and the other falls back to Speaker N. Unnamed
 * clusters number in first-appearance order (the order the array comes in), named clusters consume no numbers.
 */
export function resolveNames(clusters: Cluster[], opts: { taken: readonly string[]; startNumber: number }): Array<{ key: string; speaker: string | null }> {
  const candidates = new Map<string, { name: string; ms: number }>()
  for (const c of clusters) {
    let best: { name: string; ms: number } | undefined
    for (const claim of c.claims) {
      if (!claim.name) continue
      if (!best || claim.ms > best.ms) best = { name: claim.name, ms: claim.ms }
    }
    if (best && best.ms >= CLAIM_MIN_MS && best.ms >= CLAIM_SHARE * c.total) candidates.set(c.key, best)
  }
  // strongest claim keeps the person's name
  const winners = [...candidates.entries()].sort((a, b) => b[1].ms - a[1].ms)
  const assigned = new Map<string, string>()
  const usedNames = new Set<string>(opts.taken)
  for (const [key, { name }] of winners) if (!usedNames.has(name)) { assigned.set(key, name); usedNames.add(name) }
  let n = opts.startNumber
  const out: Array<{ key: string; speaker: string | null }> = []
  for (const c of clusters) {
    const name = assigned.get(c.key)
    if (name) out.push({ key: c.key, speaker: name })
    else { out.push({ key: c.key, speaker: `Speaker ${n}` }); n++ }
  }
  return out
}
```

- [ ] **Step 4: Run the tests**

Run: `cd app && npx vitest run test/diarizeNaming.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/diarize/naming.ts app/test/diarizeNaming.test.ts
git commit -m "feat(diarize): per-voice naming with claims, dedupe and stable Speaker N"
```

---

### Task 6: Voice similarity matching and EMA

**Files:**
- Create: `app/src/main/diarize/match.ts`
- Test: `app/test/diarizeMatch.test.ts` (new)

**Interfaces:**
- Produces (used by Task 13):
  - `export const AUTO_NAME_MIN = 0.72`, `export const AMBIGUOUS_MIN = 0.6`, `export const BEST_MARGIN = 0.08`
  - `export type ProfileVec = { id: string; name: string; centroid: Float32Array; meetings: number }`
  - `export function normalize(v: Float32Array): Float32Array`
  - `export function cosine(a: Float32Array, b: Float32Array): number`
  - `export function blend(oldV: Float32Array, fresh: Float32Array): Float32Array`
  - `export type Match = { id: string; score: number } | { id: null; score: number } | null`
  - `export function bestMatch(vec: Float32Array, profiles: readonly ProfileVec[]): Match`

Semantics of `bestMatch`: `null` = no match at all (score < 0.60); `{ id: null, score }` = in the ambiguous band or two profiles too close; `{ id, score }` = confident auto-name.

- [ ] **Step 1: Write the failing tests**

Create `app/test/diarizeMatch.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { AMBIGUOUS_MIN, AUTO_NAME_MIN, BEST_MARGIN, bestMatch, blend, cosine, normalize, type ProfileVec } from '../src/main/diarize/match'

const unit = (dims: number, at: number): Float32Array => { const v = new Float32Array(dims); v[at] = 1; return v }
const profile = (id: string, v: Float32Array): ProfileVec => ({ id, name: id, centroid: v, meetings: 1 })

describe('vector math', () => {
  it('normalizes to unit length', () => {
    const v = normalize(new Float32Array([3, 4]))
    expect(Math.hypot(...v)).toBeCloseTo(1)
  })
  it('cosine of normalized vectors is their dot', () => {
    expect(cosine(unit(4, 0), unit(4, 0))).toBeCloseTo(1)
    expect(cosine(unit(4, 0), unit(4, 1))).toBeCloseTo(0)
  })
  it('blend is 0.7 old + 0.3 fresh, renormalized', () => {
    const old = new Float32Array([1, 0]), fresh = new Float32Array([0, 1])
    const out = blend(old, fresh)
    expect(out[0] / out[1]).toBeCloseTo(7 / 3)
    expect(Math.hypot(...out)).toBeCloseTo(1)
  })
})

describe('bestMatch', () => {
  const near = (target: Float32Array, sim: number, dims = 4): Float32Array => {
    const decoy = unit(dims, dims - 1)
    const mixed = new Float32Array(dims)
    for (let i = 0; i < dims; i++) mixed[i] = sim * target[i] + (1 - sim) * decoy[i]
    return normalize(mixed)
  }
  it(`auto-names at cosine >= ${AUTO_NAME_MIN} with a clear margin`, () => {
    const p = unit(4, 0)
    const m = bestMatch(near(p, 0.95), [profile('p1', p)])
    expect(m).toEqual({ id: 'p1', score: expect.any(Number) })
    expect(m && m.score).toBeGreaterThan(AUTO_NAME_MIN)
  })
  it('no match below the floor', () => {
    const p = unit(4, 0)
    expect(bestMatch(near(p, 0.2), [profile('p1', p)])).toBeNull()
    expect(bestMatch(unit(4, 0), [])).toBeNull()
  })
  it(`the ambiguous band (${AMBIGUOUS_MIN}–${AUTO_NAME_MIN}) matches nothing`, () => {
    const p = unit(4, 0)
    const m = bestMatch(near(p, 0.62), [profile('p1', p)])
    expect(m).toEqual({ id: null, score: expect.any(Number) })
    expect(m && m.score).toBeGreaterThanOrEqual(AMBIGUOUS_MIN)
    expect(m && m.score).toBeLessThan(AUTO_NAME_MIN)
  })
  it(`two profiles too close (margin < ${BEST_MARGIN}) match nothing`, () => {
    const a = unit(4, 0), b = normalize(near(a, 0.97))
    const m = bestMatch(a, [profile('p1', a), profile('p2', b)])
    expect(m).toEqual({ id: null, score: expect.any(Number) })
  })
  it('picks the better of two well-separated profiles', () => {
    const a = unit(4, 0), b = unit(4, 2)
    expect(bestMatch(a, [profile('p2', b), profile('p1', a)])).toMatchObject({ id: 'p1' })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd app && npx vitest run test/diarizeMatch.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `app/src/main/diarize/match.ts`**

```ts
/** profile naming only fills clusters that are still Speaker N, and only when the match is sure */
export const AUTO_NAME_MIN = 0.72
export const AMBIGUOUS_MIN = 0.6
export const BEST_MARGIN = 0.08

export type ProfileVec = { id: string; name: string; centroid: Float32Array; meetings: number }
export type Match = { id: string; score: number } | { id: null; score: number } | null

export function normalize(v: Float32Array): Float32Array {
  let sum = 0
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i]
  const n = Math.sqrt(sum) || 1
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n
  return out
}

/** both inputs are unit vectors (centroids are stored normalized; embeddings are normalized before use) */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) dot += a[i] * b[i]
  return dot
}

/** the stored voiceprint drifts toward what was heard: 0.7 old + 0.3 fresh, renormalized */
export function blend(oldV: Float32Array, fresh: Float32Array): Float32Array {
  const out = new Float32Array(Math.max(oldV.length, freshVLength(fresh)))
  for (let i = 0; i < out.length; i++) out[i] = 0.7 * (oldV[i] ?? 0) + 0.3 * (fresh[i] ?? 0)
  return normalize(out)
}
const freshVLength = (v: Float32Array) => v.length

export function bestMatch(vec: Float32Array, profiles: readonly ProfileVec[]): Match {
  const scored = profiles.map(p => ({ id: p.id, score: cosine(vec, normalize(p.centroid)) })).sort((a, b) => b.score - a.score)
  const top = scored[0]
  if (!top || top.score < AMBIGUOUS_MIN) return null
  const margin = top.score - (scored[1]?.score ?? -1)
  if (top.score >= AUTO_NAME_MIN && margin >= BEST_MARGIN) return { id: top.id, score: top.score }
  return { id: null, score: top.score }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd app && npx vitest run test/diarizeMatch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/diarize/match.ts app/test/diarizeMatch.test.ts
git commit -m "feat(diarize): cosine matching with thresholds and centroid EMA"
```

---

### Task 7: `yogurt-audio decode` subcommand (Swift + Rust helpers)

**Files:**
- Modify: `app/native/yogurt-audio/main.swift` (add `decode` dispatch + function)
- Modify: `app/native/yogurt-audio-linux/src/main.rs` (dispatch) and new `app/native/yogurt-audio-linux/src/decode.rs`
- Modify: `app/native/yogurt-audio-win/src/main.rs` (dispatch) and new `app/native/yogurt-audio-win/src/decode.rs`
- Test: Rust unit test in `app/native/yogurt-audio-linux/src/decode.rs` (runs on Linux CI and locally)

**Interfaces:**
- Consumes: Linux `ogg_opus::decode(path, sink) -> io::Result<u64>` (48 kHz f32), `resample` module; Windows `oggopus::decode(path, each) -> Option<u64>` and its `resample` module.
- Produces: `yogurt-audio decode --in FILE --out WAV` writes a 16 kHz mono 16-bit PCM WAV matching meeting time. Exit 0 on success; message + exit 1 on failure (unsupported container prints `unsupported-input` to stderr).

- [ ] **Step 1: Linux crate — write the failing Rust test**

Create `app/native/yogurt-audio-linux/src/decode.rs` with the module doc, implementation, and test below, and add `mod decode;` to `src/main.rs` plus the dispatch arm (Step 3). Write the test first:

```rust
//! yogurt-audio decode --in FILE --out WAV: a meeting's Ogg Opus recording as 16 kHz mono 16-bit PCM,
//! for the diarizer. The file's timeline is meeting time, so the WAV is too.

use crate::ogg_opus::OpusWriter;
use crate::resample;
use std::io::Write;
use std::path::Path;

pub fn decode_file(input: &Path, output: &Path) -> i32 {
    let mut pcm = Vec::new();
    if input.extension().and_then(|e| e.to_str()) == Some("ogg") {
        // the recorder writes Ogg Opus at 48 kHz mono; resample::resample takes it to 16 kHz below
        let sink = |samples: &[f32]| -> std::io::Result<()> { pcm.extend_from_slice(samples); Ok(()) };
        if crate::ogg_opus::decode(input, sink).is_err() { eprintln!("unsupported-input"); return 1 }
    } else {
        // an m4a on Windows/Linux (a cross-platform import) is not decoded in v1
        eprintln!("unsupported-input");
        return 1
    }
    let wav = match write_wav(&pcm) { Ok(w) => w, Err(e) => { eprintln!("write failed: {e}"); return 1 } };
    match std::fs::File::create(output).and_then(|mut f| f.write_all(&wav)) {
        Ok(()) => 0,
        Err(e) => { eprintln!("write failed: {e}"); 1 }
    }
}

/// 16 kHz mono s16le WAV; the recorder's Ogg Opus is 48 kHz, so it goes through the recorder's own resampler
fn write_wav(samples: &[f32]) -> std::io::Result<Vec<u8>> {
    let sixteen = resample::resample(samples, 48_000, 16_000);
    let n = sixteen.len() * 2;
    let mut b = Vec::with_capacity(44 + n);
    b.extend_from_slice(b"RIFF"); b.extend_from_slice(&(36 + n as u32).to_le_bytes()); b.extend_from_slice(b"WAVE");
    b.extend_from_slice(b"fmt "); b.extend_from_slice(&16u32.to_le_bytes()); b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes()); b.extend_from_slice(&16_000u32.to_le_bytes());
    b.extend_from_slice(&32_000u32.to_le_bytes()); b.extend_from_slice(&2u16.to_le_bytes()); b.extend_from_slice(&16u16.to_le_bytes());
    b.extend_from_slice(b"data"); b.extend_from_slice(&(n as u32).to_le_bytes());
    for s in &sixteen { b.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0).round() as i16).to_le_bytes()); }
    Ok(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_ogg_opus_to_a_16k_mono_wav() {
        let dir = std::env::temp_dir().join(format!("yogurt-decode-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let ogg = dir.join("them.ogg");
        let mut w = OpusWriter::create(&ogg).unwrap();
        // 2 seconds of a quiet sine at 48 kHz
        let samples: Vec<f32> = (0..96_000).map(|i| (i as f32 * 440.0 * 2.0 * std::f32::consts::PI / 48_000.0).sin() * 0.05).collect();
        w.write(&samples).unwrap();
        w.finish().unwrap();
        let wav = dir.join("them.wav");
        assert_eq!(decode_file(&ogg, &wav), 0);
        let bytes = std::fs::read(&wav).unwrap();
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(bytes[24..28].try_into().unwrap()), 16_000);
        assert_eq!(u16::from_le_bytes(bytes[22..24].try_into().unwrap()), 1);
        let data = u32::from_le_bytes(bytes[40..44].try_into().unwrap()) as usize;
        // 2 s of audio at 16 kHz mono 16-bit, with a small tolerance for the encoder's pre-skip
        assert!((data as i64 - 2 * 16_000 * 2).abs() < 4_000, "data bytes {data}");
        std::fs::remove_dir_all(&dir).ok();
    }
}
```

If the crate's `resample` module exposes a different function name (check `src/resample.rs`), adapt `write_wav` to it — the test stays the same. If `OpusWriter` has no `finish`, use whatever closes the stream (the writer's page-flush used by `join`).

- [ ] **Step 2: Run it to verify it fails**

Run: `cd app/native/yogurt-audio-linux && cargo test decode`
Expected: FAIL to compile (missing functions) or FAIL on assertion — this confirms the test exercises the new code.

- [ ] **Step 3: Implement the Linux decode**

Complete `decode.rs` per Step 1 (adjust `resample`/`finish` calls to the crate's real APIs), then wire it into `app/native/yogurt-audio-linux/src/main.rs`:

- Add `mod decode;` next to the other `mod` lines.
- In `main()`'s `match cmd { ... }`, add a `"decode"` arm before the `record|join|inspect|compact` arm:

```rust
        "decode" => {
            let (Some(input), Some(out)) = (arg_value(&args, "--in"), arg_value(&args, "--out")) else { fail("usage: yogurt-audio decode --in FILE --out WAV") };
            std::process::exit(decode::decode_file(Path::new(&input), Path::new(&out)));
        }
```

- Extend the usage string with `decode --in FILE --out WAV`.

Note the deliberate scope: `.ogg` only. An `.m4a` on Windows/Linux prints `unsupported-input` and exits 1 (the orchestrator logs it; no dialog).

- [ ] **Step 4: Run the Linux test and build**

Run: `cd app/native/yogurt-audio-linux && cargo test decode && cargo build --release`
Expected: test PASS, build OK.

- [ ] **Step 5: Windows crate — same subcommand**

Create `app/native/yogurt-audio-win/src/decode.rs` with the same shape, using this crate's APIs (`crate::oggopus::decode(path, each: impl FnMut(&[f32]) -> bool) -> Option<u64>`; reuse its `resample` and `out` helpers; `finish` equivalent is whatever `join.rs` calls to end a stream). Wire `"decode"` into `app/native/yogurt-audio-win/src/main.rs` exactly as on Linux, and extend `USAGE`. The crate's existing tests cover the Opus decoder; add the same WAV round-trip test as Linux (it compiles on any host even though `record` is Windows-gated — `decode` is platform-independent).

Run: `cd app/native/yogurt-audio-win && cargo test decode`
Expected: PASS.

- [ ] **Step 6: macOS helper — Swift `decode` via AVFoundation**

In `app/native/yogurt-audio/main.swift`, extend the header comment usage lines with `yogurt-audio decode --in FILE --out WAV`, and in the argument dispatch (where `record`, `join`, `speech-locales` are matched) add:

```swift
if args.count > 1, args[1] == "decode" {
  func arg(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
  }
  guard let input = arg("--in"), let output = arg("--out") else { fail("usage: yogurt-audio decode --in FILE --out WAV") }
  work.sync { exit(decodeAudio(input: URL(fileURLWithPath: input), output: URL(fileURLWithPath: output))) }
}
```

Add the function (AVFoundation decodes HE-AAC/SBR natively; Symphonia cannot):

```swift
/// A meeting's m4a as 16 kHz mono 16-bit PCM. The m4a's timeline is meeting time, so the WAV is too.
func decodeAudio(input: URL, output: URL) -> Int32 {
  guard let asset = AVURLAsset(url: input).tracks(withMediaType: .audio).first,
        let reader = try? AVAssetReader(asset: AVURLAsset(url: input)) else { log("unsupported-input"); return 1 }
  let output2 = AVAssetReaderAudioOutput(asset: asset, outputSettings: [
    AVFormatIDKey: kAudioFormatLinearPCM,
    AVSampleRateKey: 16000,
    AVNumberOfChannelsKey: 1,
    AVLinearPCMBitDepthKey: 16,
    AVLinearPCMIsFloatKey: false,
    AVLinearPCMIsBigEndianKey: false,
    AVLinearPCMIsNonInterleaved: false,
  ])
  guard reader.canAdd(output2) else { log("read failed"); return 1 }
  reader.add(output2)
  guard (try? reader.startReading()) != nil else { log("read failed"); return 1 }
  FileManager.default.createFile(atPath: output.path, contents: nil)
  guard let handle = try? FileHandle(forWritingTo: output) else { log("write failed"); return 1 }
  defer { try? handle.close() }
  // 44 bytes of header first; rewritten with the real size once the samples are in
  try? handle.write(contentsOf: wavHeader(bytes: 0))
  var bytes = 0
  while let sample = output2.nextSampleBuffer() {
    defer { sample.release() }  // CMSampleBuffer from nextSampleBuffer is retained
    let list = UnsafeMutableAudioBufferListPointer(sample.audioBufferList)
    for buf in list where buf.mData != nil {
      let n = Int(buf.mDataByteSize)
      handle.write(contentsOf: Data(bytes: buf.mData!, count: n))
      bytes += n
    }
  }
  if reader.status == .failed { log("read failed: \(reader.error?.localizedDescription ?? "")"); return 1 }
  try? handle.seek(toOffset: 0)
  try? handle.write(contentsOf: wavHeader(bytes: bytes))
  return 0
}

func wavHeader(bytes: Int) -> Data {
  var d = Data()
  func le32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
  func le16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
  d.append(contentsOf: Array("RIFF".utf8)); le32(UInt32(36 + bytes)); d.append(contentsOf: Array("WAVE".utf8))
  d.append(contentsOf: Array("fmt ".utf8)); le32(16); le16(1); le16(1)
  le32(16000); le32(32000); le16(2); le16(16)
  d.append(contentsOf: Array("data".utf8)); le32(UInt32(bytes))
  return d
}
```

Adapt names to the file's existing helpers (`log`, `fail`, `work` all exist). The output settings produce one interleaved mono Int16 buffer per sample buffer, so the buffer-list walk stays simple; `sample.release()` matches how the file handles Core Foundation returns elsewhere (check the file's own conventions and follow them).

- [ ] **Step 7: Compile check (macOS only; skip elsewhere)**

Run: `[ "$(uname)" = Darwin ] && cd app && xcrun swiftc -O -target arm64-apple-macos14.4 native/yogurt-audio/main.swift -o /tmp/yogurt-audio-check -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker native/yogurt-audio/Info.plist || echo 'skipped: not a Mac'`
Expected: compiles on a Mac; prints `skipped` elsewhere. The macOS release CI (Task 21) builds it for real.

- [ ] **Step 8: Commit**

```bash
git add app/native/yogurt-audio/main.swift app/native/yogurt-audio-linux/src app/native/yogurt-audio-win/src
git commit -m "feat(audio): yogurt-audio decode writes 16 kHz mono wav from m4a/ogg"
```

---

### Task 8: Catalog entries and schema

**Files:**
- Modify: `catalog/catalog.json` (after `"embedding"`), `catalog/licenses.json`
- Modify: `packages/picker/src/catalog-schema.ts`, `packages/picker/src/types.ts`, `packages/picker/test/catalog.test.ts`
- Test: `packages/picker/test/catalog.test.ts` (existing file, extended)

**Interfaces:**
- Produces: `Catalog.diarization: CatalogModelFile`, `Catalog.speaker: CatalogModelFile`, `Catalog.diarizationRuntime: CatalogBinary` where `CatalogModelFile = { id; name; license; url; sha256; bytes }`.

- [ ] **Step 1: Confirm the CAM++ license (do this first; it decides the catalog entry)**

Run:
```bash
curl -sSfL https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/master/README.md | grep -i -A3 "speaker"
open https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models
```
Expected: the 3D-Speaker CAM++ models are released under Apache-2.0 (3D-Speaker is an Apache-2.0 ModelScope project). If the page says otherwise, record the actual SPDX id and use it in `licenses.json`/`catalog.json` in Step 2. Note the finding in the commit message.

- [ ] **Step 2: Add the entries**

Append to `catalog/catalog.json` (inside the top-level object, after `"embedding"`):

```json
  "diarizationRuntime": {
    "id": "nemo-speech",
    "tag": "nemo-speech",
    "bundled": true,
    "note": "Built by app/scripts/native.sh and scripts/nemo-build.mjs from NeMo-Speech.cpp at the pinned commit (native.sh), so setup downloads nothing for it"
  },
  "diarization": {
    "id": "nemotron-3-diarization-q8_0",
    "name": "Nemotron 3 Diarization",
    "license": "OpenMDW-1.1",
    "url": "https://huggingface.co/nvidia/Nemotron-3-Diarization/resolve/main/Nemotron-3-Diarization.q8_0.gguf",
    "sha256": "08456d9e22cd9a323c0364d98375f3746d6e68507ebb705cd46438c534c7a3a1",
    "bytes": 107012128
  },
  "speaker": {
    "id": "3dspeaker-campplus-zh-en-16k",
    "name": "CAM++ speaker embedding",
    "license": "Apache-2.0",
    "url": "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
    "sha256": "aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2",
    "bytes": 28281164
  }
```

Add `"OpenMDW-1.1"` to `catalog/licenses.json` (keep the array sorted): `["Apache-2.0", "MIT", "CC-BY-4.0", "Gemma", "OpenMDW-1.1"]`.

- [ ] **Step 3: Schema and types**

In `packages/picker/src/catalog-schema.ts`, add next to `Embedding`:

```ts
/** one downloaded model file (no dims: the embedding length is the worker's business) */
const ModelFile = z.object({
  id: Id, name: z.string().min(1), license: z.string().min(1),
  url: z.string().url(), sha256: Sha, bytes: z.number().int().positive(),
})
```

Extend `CatalogSchema`:

```ts
  embedding: Embedding,
  diarization: ModelFile,
  speaker: ModelFile,
  diarizationRuntime: Binary,
```

In `validateCatalog`, after the embedding license check add:

```ts
  for (const key of ['diarization', 'speaker'] as const) if (!allowedLicenses.includes(parsed.data[key].license)) errors.push(`${parsed.data[key].id}: license ${parsed.data[key].license} not allowed`)
```

In `packages/picker/src/types.ts` add:

```ts
/** One downloaded model file (diarization GGUF, speaker ONNX) */
export interface CatalogModelFile {
  id: string
  name: string
  license: string
  url: string
  sha256: string
  bytes: number
}
```

and extend `interface Catalog`:

```ts
  diarization: CatalogModelFile
  speaker: CatalogModelFile
  diarizationRuntime: CatalogBinary
```

- [ ] **Step 4: Update the picker catalog test**

Extend `packages/picker/test/catalog.test.ts` (it validates the shipped catalog directly — follow the file's existing spread-the-real-catalog pattern):

```ts
  it('pins the diarization and speaker models with sha256, size and an allowed license', () => {
    const r = validateCatalog(real, licenses)
    if (!r.ok) throw new Error(r.errors.join('; '))
    expect(r.catalog.diarization.bytes).toBe(107012128)
    expect(r.catalog.diarization.sha256).toMatch(sha)
    expect(r.catalog.speaker.bytes).toBe(28281164)
    expect(r.catalog.speaker.sha256).toMatch(sha)
  })
  it('rejects a diarization or speaker model with a disallowed license', () => {
    const diarization = shipped.diarization as Record<string, unknown>
    expect(validateCatalog({ ...shipped, diarization: { ...diarization, license: 'CC-BY-NC-4.0' } }, licenses).ok).toBe(false)
    const speaker = shipped.speaker as Record<string, unknown>
    expect(validateCatalog({ ...shipped, speaker: { ...speaker, sha256: '' } }, licenses).ok).toBe(false)
  })
  it('takes a bundled diarization runtime: nothing to download', () => {
    const r = validateCatalog(real, licenses)
    if (!r.ok) throw new Error(r.errors.join('; '))
    expect(r.catalog.diarizationRuntime.bundled).toBe(true)
  })
```

Run: `cd packages/picker && npm test`
Expected: PASS (the shipped catalog carries the new entries from Step 2).

- [ ] **Step 5: Run the app-side catalog test and typecheck**

Run: `cd app && npx vitest run test/catalog.test.ts && npm run typecheck && cd ../packages/picker && npm run typecheck 2>/dev/null || true`
Expected: PASS (the bundled catalog validates with the new keys).

- [ ] **Step 6: Commit**

```bash
git add catalog packages/picker
git commit -m "feat(catalog): Nemotron-3-Diarization and CAM++ speaker models, nemo-speech runtime entry"
```

---

### Task 9: Setup downloads the diarization model; lazy speaker model

**Files:**
- Modify: `app/src/main/setup.ts`
- Test: extend `app/test/setup.test.ts` (append a `describe` block)

**Interfaces:**
- Consumes: `catalog.diarization`, `catalog.speaker` (Task 8), `Item`, `fetch`, `isVerified`.
- Produces:
  - `Installed` gains `diarization?: string`
  - `SetupController.prototype.ensureSpeakerModel(): Promise<string>` — resolves to the ONNX path, downloads on first call (cached promise), throws on failure after one retry.

- [ ] **Step 1: Write the failing tests**

Append to `app/test/setup.test.ts`:

```ts
describe('diarization models', () => {
  it('downloads the diarization gguf in the background; ready never waits for it', async () => {
    const { c, root, rec } = setup()
    await c.start()
    expect(c.state.phase).toBe('ready')
    await c.idle()
    expect(c.installed()?.diarization).toBe(join(root, 'diarization', name(catalog.diarization.url)))
    expect(existsSync(join(root, 'diarization', name(catalog.diarization.url)))).toBe(true)
    expect(rec.asked).toContain(catalog.diarization.url)
  })
  it('ensureSpeakerModel downloads the onnx only when asked', async () => {
    const { c, root } = setup()
    await c.start()
    expect(c.installed()?.diarization).toBeUndefined()
    const p = await c.ensureSpeakerModel()
    expect(p).toBe(join(root, 'speaker', name(catalog.speaker.url)))
    expect(existsSync(p)).toBe(true)
  })
})
```

Add `existsSync` to the existing `node:fs` import at the top of the file.

- [ ] **Step 2: Run to verify it fails**

Run: `cd app && npx vitest run test/setup.test.ts`
Expected: FAIL — `installed().diarization` undefined, `ensureSpeakerModel` not a function.

- [ ] **Step 3: Implement in `app/src/main/setup.ts`**

3a. `Installed` (line 36):

```ts
export type Installed = { asr: string; llm?: string; recommendedLlm?: string; /** meaning search across meetings; word search works without it */ embed?: string; /** who spoke, once it is in (diarization) */ diarization?: string }
```

3b. In `run()`, extend `dirs` and add the item; include it in the disk check:

```ts
      const dirs = { asr: join(this.deps.modelsDir, 'asr'), llm: join(this.deps.modelsDir, 'llm'), embed: join(this.deps.modelsDir, 'embed'), diarization: join(this.deps.modelsDir, 'diarization'), speaker: join(this.deps.modelsDir, 'speaker') }
      // …
      const diarItem: Item = { url: catalog.diarization.url, sha256: catalog.diarization.sha256, bytes: catalog.diarization.bytes, dir: dirs.diarization, fileName: fileNameFor(catalog.diarization.url) }
```

and change the disk check to include it: `await this.checkDisk([...waitFor, starterItem, embedItem, diarItem])`.

3c. Chain it after the embedding model (so the 107 MB GGUF lands early, before the bigger notes model):

```ts
      this.startNotes(starterItem, embedItem, later && llmItem(dirs.llm, later), diarItem)
```

and in `startNotes(first, embed, later, diar)`:

```ts
    this.background = this.background.then(() => this.startEmbedding(embed))
    if (diar) this.background = this.background.then(() => this.startDiarization(diar))
    if (later) this.background = this.background.then(() => this.startBackground(later))
```

3d. Add the two private methods (modelled on `startEmbedding`, best-effort with retries; `speakerPromise` is a new private field):

```ts
  /** The diarization model, after the embedding model. Never blocks ready; failing keeps being tried quietly. */
  private async startDiarization(item: Item) {
    const landed = (path: string) => { if (this.paths) this.paths = { ...this.paths, diarization: path } }
    try { landed(await this.fetch(item)); return } catch (err) { console.warn('the diarization model did not download yet, trying again', err) }
    const waits = this.deps.notesRetryMs ?? NOTES_RETRY_MS
    for (let i = 0; ; i++) {
      await new Promise((r) => setTimeout(r, waits[Math.min(i, waits.length - 1)]))
      try { landed(await this.fetch(item)); return } catch (err) { console.warn('the diarization model did not download yet, trying again', err) }
    }
  }

  /** The speaker embedding model, fetched the first time voice recognition is turned on. One retry, then the caller carries on without profiles. */
  async ensureSpeakerModel(): Promise<string> {
    this.speakerPromise ??= (async () => {
      const c = (await this.deps.getCatalog()).speaker
      const item: Item = { url: c.url, sha256: c.sha256, bytes: c.bytes, dir: join(this.deps.modelsDir, 'speaker'), fileName: fileNameFor(c.url) }
      try { return await this.fetch(item) } catch (err) { console.warn('the speaker model did not download, trying once more', err) }
      return this.fetch(item)
    })()
    return this.speakerPromise
  }
  private speakerPromise: Promise<string> | undefined
```

- [ ] **Step 4: Run the tests**

Run: `cd app && npx vitest run test/setup.test.ts test/setupStatus.test.ts test/notesSetup.test.ts`
Expected: PASS (progress fractions unchanged in the ready path; the background item downloads after embed in `fakeDownloadDeps`).

- [ ] **Step 5: Commit**

```bash
git add app/src/main/setup.ts app/test/setup.test.ts
git commit -m "feat(setup): download the diarization model, lazy speaker model on opt-in"
```

---

### Task 10: Build `nemo-speech` (scripts, macOS, release CI)

**Files:**
- Create: `app/scripts/nemo-build.mjs`
- Modify: `app/scripts/native.mjs` (invoke it after whisper-build), `app/scripts/native.sh` (macOS section)
- Modify: `.github/workflows/release.yml` (build `nemo-speech` on all three platforms)

**Interfaces:**
- Produces: `app/resources/bin/nemo-speech(.exe)` on the developer machine and in packaged releases. Environment: `NEMO_COMMIT=c540e21167017d2e34444f2fc2d70649065dc500`; `YOGURT_NO_NEMO=1` skips the build (fake-mode CI). `YOGURT_DIARIZE_BACKEND` is runtime-only (Task 12), never a build flag.

- [ ] **Step 1: Verify the pin**

Run: `git ls-remote https://github.com/NVIDIA/NeMo-Speech.cpp c540e21167017d2e34444f2fc2d70649065dc500`
Expected: the ref exists. If it does not, read the repo's commit list, pick the newest commit containing `fix(diar): correct speaker attribution and word timing`, and update `NEMO_COMMIT` here and in Global Constraints.

- [ ] **Step 2: Read the pinned checkout's build flags**

```bash
rm -rf /tmp/nemo-src && git clone --quiet --depth 50 https://github.com/NVIDIA/NeMo-Speech.cpp /tmp/nemo-src && git -C /tmp/nemo-src checkout --quiet --force c540e21167017d2e34444f2fc2d70649065dc500
sed -n '1,120p' /tmp/nemo-src/scripts/install.sh
grep -n "option(" /tmp/nemo-src/CMakeLists.txt
```
Note the exact CMake options for: building the `nemo-speech` binary target, backend selection (Vulkan / Metal), and disabling tests/examples. These names go into Step 3 verbatim. Expected (verify at the pin): `-DNEMO_BUILD_TESTS=OFF`-style switches, `GGML_*` backend switches mirroring whisper.cpp's, and a single `nemo-speech` executable target in the build output.

- [ ] **Step 3: Write `app/scripts/nemo-build.mjs`** (Windows/Linux; mirrors `whisper-build.mjs`)

```js
#!/usr/bin/env node
// Builds nemo-speech (speaker diarization) for Windows (x64) and Linux (x86_64) into resources/bin, like whisper-build.mjs
// builds whisper-server. The Mac build stays in native.sh. One binary with its backends as separate libraries, so at
// start it picks Vulkan when a graphics driver has it and the CPU otherwise. Needs git, cmake, a C++ compiler, and the
// Vulkan SDK (VULKAN_SDK set) — the same ones whisper-server needs.
// --cpu-only builds without Vulkan, for a quick local build without the SDK.
import { spawnSync } from 'node:child_process'
import { cpus, existsSync, readdirSync, statSync } from 'node:fs'
import { mkdirSync, cpSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const app = join(here, '..')
const out = join(app, 'resources', 'bin', process.platform === 'win32' ? 'nemo-speech.exe' : 'nemo-speech')
export const NEMO_COMMIT = 'c540e21167017d2e34444f2fc2d70649065dc500'
const cpuOnly = process.argv.includes('--cpu-only')

const run = (cmd, args, opts) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (r.status !== 0) { console.error(`${cmd} ${args.join(' ')} failed${r.error ? `: ${r.error.message}` : ''}`); process.exit(1) }
}
const out2 = (cmd, args) => spawnSync(cmd, args).stdout?.toString().trim() ?? ''
const newest = (dir) => {
  let t = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'build' || e.name.startsWith('.git')) continue
    const p = join(dir, e.name)
    t = Math.max(t, e.isDirectory() ? newest(p) : statSync(p).mtimeMs)
  }
  return t
}

mkdirSync(join(app, 'resources', 'bin'), { recursive: true })
const dir = join(app, 'native', '.nemo-build')
if (existsSync(out) && statSync(out).mtimeMs > newest(dir)) { console.log('nemo-speech is up to date'); process.exit(0) }
if (!existsSync(join(dir, '.git'))) run('git', ['clone', '--quiet', 'https://github.com/NVIDIA/NeMo-Speech.cpp', dir])
run('git', ['-C', dir, 'checkout', '--quiet', '--force', NEMO_COMMIT])
if (out2('git', ['-C', dir, 'rev-parse', 'HEAD']) !== NEMO_COMMIT) { console.error('NeMo-Speech.cpp is not at the pinned commit'); process.exit(1) }
// Flags verified at the pin in the repo's scripts/install.sh (Task 10 step 2); keep them identical there and in native.sh.
const flags = [
  '-DCMAKE_BUILD_TYPE=Release',
  '-DNEMO_BUILD_TESTS=OFF',
  '-DGGML_NATIVE=OFF',
  '-DGGML_BACKEND_DL=ON',
  ...(cpuOnly ? ['-DGGML_VULKAN=OFF'] : ['-DGGML_VULKAN=ON']),
]
run('cmake', ['-S', dir, '-B', join(dir, 'build'), ...flags], { env: { ...process.env, CMAKE_POLICY_VERSION_MINIMUM: '3.5' } })
run('cmake', ['--build', join(dir, 'build'), '--config', 'Release', '--target', 'nemo-speech', '-j', String(Math.max(1, cpus().length - 1))])
const built = join(dir, 'build', 'bin', process.platform === 'win32' ? 'nemo-speech.exe' : 'nemo-speech')
if (!existsSync(built)) { console.error('nemo-speech was not built (target name changed at the pin?)'); process.exit(1) }
cpSync(built, out)
if (process.platform !== 'win32') spawnSync('chmod', ['0755', out])
console.log(`built ${out}`)
```

Adjust `flags`/target name to what Step 2 found (whisper.cpp analogues: `GGML_VULKAN`, `GGML_BACKEND_DL`, `GGML_NATIVE` exist in NeMo-Speech.cpp's ggml checkout; use its real option names). Windows extras mirror `whisper-build.mjs` (`-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded`, no OpenMP) — copy whatever `whisper-build.mjs` passes and carry it over, plus the repo's own requirements from `docs/install.md`.

- [ ] **Step 4: Hook into `native.mjs`**

Replace the tail of `app/scripts/native.mjs`:

```js
if (process.env.YOGURT_NO_WHISPER === '1') console.log('whisper-server left out (YOGURT_NO_WHISPER=1)')
else run(process.execPath, [join(here, 'whisper-build.mjs'), ...process.argv.slice(2)])
if (process.env.YOGURT_NO_NEMO === '1') console.log('nemo-speech left out (YOGURT_NO_NEMO=1)')
else run(process.execPath, [join(here, 'nemo-build.mjs'), ...process.argv.slice(2)])
```

- [ ] **Step 5: macOS build in `native.sh`**

Append to `app/scripts/native.sh` (after the VAD section), mirroring the whisper-server section with Metal on and the Metal library embedded:

```sh
# nemo-speech: NeMo-Speech.cpp at a pinned commit, Metal on, the Metal shaders embedded so it is one file.
# Windows and Linux build it in nemo-build.mjs (Vulkan there). YOGURT_NO_NEMO=1 leaves it out.
NEMO_COMMIT=c540e21167017d2e34444f2fc2d70649065dc500
out=resources/bin/nemo-speech
if [ -n "$YOGURT_NO_NEMO" ]; then echo "nemo-speech left out (YOGURT_NO_NEMO=1)"
elif [ ! -f "$out" ] || [ native/.nemo-build -nt "$out" ]; then
  CMAKE=/opt/homebrew/bin/cmake
  [ -x "$CMAKE" ] || CMAKE=$(command -v cmake) || { echo "cmake is needed to build nemo-speech (brew install cmake)" >&2; exit 1; }
  dir=native/.nemo-build
  if [ ! -d "$dir/.git" ]; then git clone --quiet https://github.com/NVIDIA/NeMo-Speech.cpp "$dir"; fi
  git -C "$dir" checkout --quiet --force "$NEMO_COMMIT"
  [ "$(git -C "$dir" rev-parse HEAD)" = "$NEMO_COMMIT" ] || { echo "NeMo-Speech.cpp is not at the pinned commit" >&2; exit 1; }
  # flags verified at the pin against the repo's scripts/install.sh
  "$CMAKE" -S "$dir" -B "$dir/build" -DCMAKE_BUILD_TYPE=Release -DNEMO_BUILD_TESTS=OFF \
    -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DGGML_NATIVE=OFF \
    -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_DEPLOYMENT_TARGET=14.4 >/dev/null
  "$CMAKE" --build "$dir/build" --config Release --target nemo-speech -j "$(sysctl -n hw.ncpu)" >/dev/null
  cp "$dir/build/bin/nemo-speech" "$out"
  echo "built $out"
fi
```

- [ ] **Step 6: Smoke-run it (Linux)**

Run: `cd app && YOGURT_NO_WHISPER=1 node scripts/native.mjs && resources/bin/nemo-speech doctor`
Expected: the binary builds (or `nemo-speech left out` with `YOGURT_NO_NEMO=1`), and `doctor` prints the compiled backends (vulkan + cpu where the SDK was present; cpu-only otherwise).

- [ ] **Step 7: Release CI**

In `.github/workflows/release.yml`, find where whisper-server is built for each platform (the step that runs `npm run native` / `native.sh` with the Vulkan SDK setup, mirroring `native-whisper.yml`) and make sure the same job installs nothing new: `nemo-build.mjs` needs exactly the tools whisper-server needs (git, cmake, C++ compiler, Vulkan SDK on Windows/Linux). Add `YOGURT_NO_NEMO: '1'` to any job that builds with `--cpu-only` or that doesn't have the SDK, matching how whisper-server handles it. Keep `nemo-speech` out of `files:` — it ships via `extraResources` `resources/bin` (already configured in `electron-builder.yml`).

Run: `git diff --stat .github/workflows/release.yml`
Expected: only build-step lines changed.

- [ ] **Step 8: Commit**

```bash
git add app/scripts/nemo-build.mjs app/scripts/native.mjs app/scripts/native.sh .github/workflows/release.yml
git commit -m "feat(native): build nemo-speech from pinned NeMo-Speech.cpp (Vulkan/Metal/CPU)"
```

---

### Task 11: Embedding worker and client

**Files:**
- Create: `app/src/main/diarize/embed-worker.ts`, `app/src/main/diarize/embed-client.ts`
- Modify: `app/package.json` (dependency), `app/electron.vite.config.ts`, `app/electron-builder.yml`
- Test: `app/test/diarizeEmbed.test.ts` (new)

**Interfaces:**
- Produces:
  - `createEmbedClient(p: { workerPath: string; modelPath: () => string | undefined; fork?: (workerPath: string) => Fork }): EmbedClient`
  - `type Fork = { on(event: 'message', fn: (m: unknown) => void): void; postMessage(m: unknown): void; kill(): void }` (structural: satisfied by Electron's `UtilityProcess`)
  - `type EmbedClient = { embed(wav: string, ranges: Array<{ startMs: number; endMs: number }>): Promise<Float32Array[]>; dispose(): void }`
  - Worker protocol: request `{ id: number; wav: string; ranges: Array<{ startMs: number; endMs: number }> }`, response `{ id: number; vectors?: Float32Array[]; error?: string }`.
  - Ranges shorter than 800 ms yield no vector (the caller filters by index).
  - Vectors are L2-normalized, one per range, in request order (or missing at indices below the minimum length).

- [ ] **Step 1: Add the dependency**

```bash
cd app && npm install sherpa-onnx-node@2.0.1 --save
```
Expected: `package.json` gains `"sherpa-onnx-node": "2.0.1"` in `dependencies`. Confirm the prebuilt native binary exists: `ls node_modules/sherpa-onnx-node/bin` (platform-specific `.node` + onnxruntime dylib/dll/so).

- [ ] **Step 2: Write the failing tests**

Create `app/test/diarizeEmbed.test.ts`:

```ts
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createEmbedClient, type Fork } from '../src/main/diarize/embed-client'
import { writeWav } from '../src/main/diarize/wav'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'yogurt-embed-')); dirs.push(d); return d }

/** an in-process worker: answers each request with a vector sized from the range */
function fakeFork(script: (req: { id: number; ranges: Array<{ startMs: number; endMs: number }> }) => unknown): { fork: (p: string) => Fork; sent: unknown[] } {
  const sent: unknown[] = []
  const fork = (_p: string): Fork => {
    const bus = new EventEmitter() as unknown as Fork
    bus.postMessage = (m: unknown) => {
      sent.push(m)
      const req = m as { id: number; ranges: Array<{ startMs: number; endMs: number }> }
      const out = script(req)
      queueMicrotask(() => (bus as unknown as EventEmitter).emit('message', out))
    }
    bus.kill = () => {}
    return bus
  }
  return { fork, sent }
}

describe('embed client', () => {
  it('sends one request and gets normalized vectors in range order', async () => {
    const { fork } = fakeFork((req) => ({ id: req.id, vectors: req.ranges.map(r => new Float32Array([r.endMs - r.startMs, 1])) }))
    const c = createEmbedClient({ workerPath: 'unused.js', modelPath: () => 'm.onnx', fork })
    const out = await c.embed(join(tmp(), 'a.wav'), [{ startMs: 0, endMs: 1000 }, { startMs: 2000, endMs: 3600 }])
    expect(out).toHaveLength(2)
    expect(Math.hypot(...out[0])).toBeCloseTo(1)
    expect(out[1][0]).toBeGreaterThan(out[0][0])
  })
  it('ranges below the 800 ms minimum come back as holes', async () => {
    const { fork } = fakeFork((req) => ({ id: req.id, vectors: req.ranges.map(r => (r.endMs - r.startMs >= 800 ? new Float32Array([1, 0]) : null)) }))
    const c = createEmbedClient({ workerPath: 'unused.js', modelPath: () => 'm.onnx', fork })
    const out = await c.embed(join(tmp(), 'a.wav'), [{ startMs: 0, endMs: 500 }, { startMs: 0, endMs: 900 }])
    expect(out[0]).toBeUndefined()
    expect(out[1]).toHaveLength(2)
  })
  it('an error response rejects and the next request still works (worker restarts once)', async () => {
    let n = 0
    const { fork } = fakeFork((req) => (++n === 1 ? { id: req.id, error: 'boom' } : { id: req.id, vectors: [new Float32Array([1, 0])] }))
    const c = createEmbedClient({ workerPath: 'unused.js', modelPath: () => 'm.onnx', fork })
    await expect(c.embed(join(tmp(), 'a.wav'), [{ startMs: 0, endMs: 1000 }])).rejects.toThrow('boom')
    await expect(c.embed(join(tmp(), 'a.wav'), [{ startMs: 0, endMs: 1000 }])).resolves.toHaveLength(1)
  })
  it('times out a stuck worker and reports it', async () => {
    const { fork } = fakeFork(() => new Promise(() => {}))
    const c = createEmbedClient({ workerPath: 'unused.js', modelPath: () => 'm.onnx', fork, timeoutMs: 50 })
    await expect(c.embed(join(tmp(), 'a.wav'), [{ startMs: 0, endMs: 1000 }])).rejects.toThrow(/timed out/)
    c.dispose()
  })
})

describe('wav helpers', () => {
  it('writeWav/readWavSamples round-trip', () => {
    const f = join(tmp(), 'a.wav')
    writeWav(f, new Float32Array([0, 0.5, -0.5, 1]))
    const { sampleRate, samples } = readWavSamples(f)
    expect(sampleRate).toBe(16000)
    expect([...samples].map(v => Math.round(v * 1000))).toEqual([0, 500, -500, 1000])
  })
})

import { readWavSamples } from '../src/main/diarize/wav'
```

(Move the `readWavSamples` import to the top with the others — it is shown separately here only to keep the diff visible.)

- [ ] **Step 3: Run to verify it fails**

Run: `cd app && npx vitest run test/diarizeEmbed.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement `app/src/main/diarize/wav.ts`**

```ts
import { readFileSync, writeFileSync } from 'node:fs'

/** 16 kHz mono 16-bit PCM wav, for the diarizer and the embedding worker (mirrors asr/transcribe.ts wavBytes) */
export function writeWav(path: string, samples: Float32Array, sampleRate = 16000): void {
  const n = samples.length * 2
  const b = Buffer.alloc(44 + n)
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36 + n, 4); b.write('WAVE', 8, 'ascii')
  b.write('fmt ', 12, 'ascii'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22)
  b.writeUInt32LE(sampleRate, 24); b.writeUInt32LE(sampleRate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34)
  b.write('data', 36, 'ascii'); b.writeUInt32LE(n, 40)
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2)
  writeFileSync(path, b)
}

/** reads what writeWav and `yogurt-audio decode` write: PCM16 mono */
export function readWavSamples(path: string): { sampleRate: number; samples: Float32Array } {
  const b = readFileSync(path)
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a wav')
  const sampleRate = b.readUInt32LE(24)
  const start = b.indexOf('data', 12, 'ascii') + 8
  const n = (b.length - start) >> 1
  const samples = new Float32Array(n)
  for (let i = 0; i < n; i++) samples[i] = b.readInt16LE(start + i * 2) / 32768
  return { sampleRate, samples }
}
```

- [ ] **Step 5: Implement `app/src/main/diarize/embed-worker.ts`** (the utility-process entry)

```ts
import { SpeakerEmbeddingExtractor } from 'sherpa-onnx-node'
import { readWavSamples } from './wav'

/**
 * Speaker embeddings for one meeting's speech ranges, in a utility process so ONNX inference never
 * blocks recording, transcription or the interface. One CAM++ model, CPU, two threads; the process
 * lives until the client lets it go.
 * Request: { id, wav, ranges: [{ startMs, endMs }] }. Response: { id, vectors } (holes below 800 ms) or { id, error }.
 */
const MIN_RANGE_MS = 800

let extractor: InstanceType<typeof SpeakerEmbeddingExtractor> | undefined
const extractorFor = (model: string) => extractor ??= new SpeakerEmbeddingExtractor({ modelConfig: { model, numThreads: 2, provider: 'cpu', debug: 0 } })

const embedOne = (ex: InstanceType<typeof SpeakerEmbeddingExtractor>, samples: Float32Array, r: { startMs: number; endMs: number }): Float32Array | null => {
  if (r.endMs - r.startMs < MIN_RANGE_MS) return null
  const from = Math.max(0, Math.floor(r.startMs / 1000 * 16)), to = Math.min(samples.length, Math.ceil(r.endMs / 1000 * 16))
  if (to - from < MIN_RANGE_MS * 16) return null
  const stream = ex.createStream()
  stream.acceptWaveform({ sampleRate: 16000, samples: samples.subarray(from, to) })
  const v = ex.compute(stream) as Float32Array
  let sum = 0
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i]
  const n = Math.sqrt(sum) || 1
  for (let i = 0; i < v.length; i++) v[i] /= n
  return v
}

process.parentPort.on('message', (e: { data: { id: number; wav: string; model: string; ranges: Array<{ startMs: number; endMs: number }> } }) => {
  const { id, wav, model, ranges } = e.data
  try {
    const { samples } = readWavSamples(wav)
    const ex = extractorFor(model)
    const vectors = ranges.map((r) => embedOne(ex, samples, r))
    process.parentPort.postMessage({ id, vectors })
  } catch (err) {
    process.parentPort.postMessage({ id, error: err instanceof Error ? err.message : String(err) })
  }
})
```

Check the exact `sherpa-onnx-node` API at the installed version against `node_modules/sherpa-onnx-node/nodejs-examples/test_onnx_speaker_embedding.js` and adjust `createStream/acceptWaveform/compute` if named differently. The vector length comes from `extractor.dim()` (192 for CAM++).

- [ ] **Step 6: Implement `app/src/main/diarize/embed-client.ts`**

```ts
import { utilityProcess, type UtilityProcess } from 'electron'

/**
 * Main-process client for the embedding worker: lazy start, one request in flight, one restart,
 * then profiles are skipped for the session. Never blocks the interface.
 */
export type Fork = { on(event: 'message', fn: (m: unknown) => void): unknown; postMessage(m: unknown): void; kill(): void }
export type EmbedRequest = { id: number; wav: string; model: string; ranges: Array<{ startMs: number; endMs: number }> }
export type EmbedResponse = { id: number; vectors?: Array<Float32Array | null>; error?: string }

export type EmbedClient = {
  embed(wav: string, ranges: Array<{ startMs: number; endMs: number }>): Promise<Array<Float32Array | undefined>>
  dispose(): void
}

const IDLE_MS = 5 * 60_000

export function createEmbedClient(p: { workerPath: string; modelPath: () => string | undefined; fork?: (workerPath: string) => Fork; timeoutMs?: number }): EmbedClient {
  const fork = p.fork ?? ((workerPath: string) => utilityProcess.fork(workerPath, [], { serviceName: 'Yogurt Voices' }) as unknown as Fork)
  let proc: Fork | undefined
  let restarted = false
  let nextId = 1
  let inflight: { id: number; resolve: (v: Array<Float32Array | null>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | undefined
  let idleTimer: NodeJS.Timeout | undefined

  const close = () => { proc?.kill(); proc = undefined }
  const armIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(close, IDLE_MS) }

  const open = (): Fork => {
    if (proc) return proc
    const child = fork(p.workerPath)
    child.on('message', (m: unknown) => {
      const r = m as EmbedResponse
      if (!inflight || r.id !== inflight.id) return
      clearTimeout(inflight.timer)
      const f = inflight; inflight = undefined
      if (r.error) { if (!restarted) { restarted = true; close(); f.reject(new Error('embedding worker: ' + r.error)); return } f.reject(new Error('embedding worker: ' + r.error)); return }
      f.resolve(r.vectors ?? [])
    })
    proc = child
    return child
  }

  const ask = (req: EmbedRequest): Promise<Array<Float32Array | null>> => new Promise((resolve, reject) => {
    if (inflight) { reject(new Error('embedding worker is busy')); return }
    const timer = setTimeout(() => {
      const f = inflight; inflight = undefined
      close()
      f?.reject(new Error(`embedding worker timed out after ${p.timeoutMs ?? 30_000} ms`))
    }, p.timeoutMs ?? 30_000)
    inflight = { id: req.id, resolve, reject, timer }
    open().postMessage(req)
  })

  return {
    async embed(wav, ranges) {
      const model = p.modelPath()
      if (!model) throw new Error('speaker model is not downloaded yet')
      if (!ranges.length) return []
      clearTimeout(idleTimer)
      const id = nextId++
      let vectors: Array<Float32Array | null>
      try { vectors = await ask({ id, wav, model, ranges }) }
      catch (e) {
        if (restarted) throw e
        restarted = true; close()
        vectors = await ask({ id: nextId++, wav, model, ranges })
      }
      armIdle()
      return ranges.map((_, i) => vectors[i] ?? undefined)
    },
    dispose() { clearTimeout(idleTimer); inflight && clearTimeout(inflight.timer); inflight = undefined; close() },
  }
}
```

The restart-once rule: the first failure kills the worker and retries; a second failure (or a failure after a restart already happened) rejects, and the orchestrator skips profiles for the session (Task 13).

- [ ] **Step 7: Build entries and packaging**

`app/electron.vite.config.ts` — add the worker to the main rollup input:

```ts
      rollupOptions: { input: { index: resolve('src/main/index.ts'), engine: resolve('src/engine/worker.ts'), diarizeWorker: resolve('src/main/diarize/embed-worker.ts') } },
```

`app/electron-builder.yml` — extend the existing `asarUnpack` list:

```yaml
asarUnpack:
  # the notes model's engine loads native binaries; they can't run from inside the asar archive
  # (existing entries kept)
  - "out/main/diarize-worker.js"
  # sherpa-onnx-node's prebuilt N-API binding and the onnxruntime libraries
  - "**/node_modules/sherpa-onnx-node/**"
```

(Keep the existing entries exactly as they are; add these two.)

- [ ] **Step 8: Run the tests and typecheck**

Run: `cd app && npx vitest run test/diarizeEmbed.test.ts && npm run typecheck`
Expected: PASS. (The worker's sherpa import is external — typecheck needs the installed package's types; if none ship, add a local `declare module 'sherpa-onnx-node'` in `app/src/types/sherpa.d.ts` with the three methods used.)

- [ ] **Step 9: Commit**

```bash
git add app/package.json app/package-lock.json app/src/main/diarize app/electron.vite.config.ts app/electron-builder.yml app/test/diarizeEmbed.test.ts
git commit -m "feat(diarize): utility-process speaker embeddings via sherpa-onnx-node"
```

---

### Task 12: Spawn wrappers (decode + nemo-speech)

**Files:**
- Create: `app/src/main/diarize/run.ts`
- Test: `app/test/diarizeRun.test.ts` (new)

**Interfaces:**
- Consumes: `wav.ts` (Task 11).
- Produces (used by Task 13):
  - `export function probeBackend(): 'cpu' | 'vulkan' | 'metal'` — `YOGURT_DIARIZE_BACKEND` wins, else darwin → `metal`, else `vulkan`
  - `export const diarizeTimeoutMs = (audioMs: number): number` — `8 × audio + 120_000`, floor `180_000`
  - `export async function runDecode(helper: string, input: string, out: string, timeoutMs?: number): Promise<void>`
  - `export async function runDiarize(nemo: string, wav: string, model: string, rttmPath: string, backend: string, timeoutMs?: number): Promise<'gpu' | 'cpu'>` — runs `--device <backend>`; on failure with a non-cpu backend, retries once with `--device cpu` and returns `'cpu'`; returns `'gpu'` when the requested backend worked. Emits backend names to the log; never audio content.

- [ ] **Step 1: Write the failing tests**

Create `app/test/diarizeRun.test.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { diarizeTimeoutMs, probeBackend, runDecode, runDiarize } from '../src/main/diarize/run'
import { writeWav } from '../src/main/diarize/wav'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'yogurt-diarize-run-')); dirs.push(d); return d }
/** a stand-in helper: node script that mimics yogurt-audio decode */
const fakeDecode = (dir: string, fail = false) => {
  const f = join(dir, 'decode.mjs')
  writeFileSync(f, fail ? "process.stderr.write('unsupported-input'); process.exit(1)" : `
    import { writeFileSync, readFileSync } from 'node:fs'
    const a = process.argv
    const input = a[a.indexOf('--in') + 1]
    writeFileSync(a[a.indexOf('--out') + 1], readFileSync(input))
  `)
  return f
}
const fakeNemo = (dir: string, o: { failFirst?: boolean } = {}) => {
  const f = join(dir, 'nemo.mjs')
  writeFileSync(f, `
    import { appendFileSync, writeFileSync } from 'node:fs'
    const a = process.argv
    const device = a[a.indexOf('--device') + 1]
    appendFileSync(${JSON.stringify(join(dir, 'devices.txt'))}, device + '\\n')
    if (device !== 'cpu' && ${o.failFirst ? 'true' : 'false'}) process.exit(1)
    writeFileSync(a[a.indexOf('--output') + 1], 'SPEAKER them 1 0.000 1.000 <NA> <NA> 0 <NA> <NA>\\n')
  `)
  return f
}

describe('probeBackend', () => {
  it('follows YOGURT_DIARIZE_BACKEND, else metal on a mac and vulkan elsewhere', () => {
    expect(probeBackend('linux', { YOGURT_DIARIZE_BACKEND: 'cpu' })).toBe('cpu')
    expect(probeBackend('darwin', {})).toBe('metal')
    expect(probeBackend('win32', {})).toBe('vulkan')
  })
})

describe('diarizeTimeoutMs', () => {
  it('is generous but bounded', () => {
    expect(diarizeTimeoutMs(60_000)).toBe(600_000)
    expect(diarizeTimeoutMs(1000)).toBe(180_000)
  })
})

describe('runDecode', () => {
  it('copies through the helper and leaves the wav there', async () => {
    const dir = tmp(), wav = join(dir, 'in.wav')
    writeWav(wav, new Float32Array([0, 1, -1]))
    const out = join(dir, 'out.wav')
    await runDecode(fakeDecode(dir), wav, out)
    expect(existsSync(out)).toBe(true)
  })
  it('rejects with the helper's reason on failure', async () => {
    const dir = tmp()
    await expect(runDecode(fakeDecode(dir, true), join(dir, 'x.m4a'), join(dir, 'out.wav'))).rejects.toThrow(/unsupported-input/)
  })
})

describe('runDiarize', () => {
  it('writes the rttm file and reports the gpu backend', async () => {
    const dir = tmp(), rttm = join(dir, 'them.rttm')
    const where = await runDiarize(fakeNemo(dir), join(dir, 'them.wav'), 'm.gguf', rttm, 'vulkan')
    expect(where).toBe('gpu')
    expect(readFileSync(rttm, 'utf8')).toContain('SPEAKER them')
    expect(readFileSync(join(dir, 'devices.txt'), 'utf8')).toBe('vulkan')
  })
  it('falls back to cpu once when the accelerator fails', async () => {
    const dir = tmp(), rttm = join(dir, 'them.rttm')
    const where = await runDiarize(fakeNemo(dir, { failFirst: true }), join(dir, 'them.wav'), 'm.gguf', rttm, 'vulkan')
    expect(where).toBe('cpu')
    expect(readFileSync(join(dir, 'devices.txt'), 'utf8')).toBe('vulkan\ncpu')
  })
  it('does not fall back when cpu was already asked for', async () => {
    const dir = tmp()
    await expect(runDiarize(fakeNemo(dir, { failFirst: true }), join(dir, 'them.wav'), 'm.gguf', join(dir, 'r.rttm'), 'cpu', 200)).rejects.toThrow()
    expect(readFileSync(join(dir, 'devices.txt'), 'utf8')).toBe('cpu')
  })
  it('times out a stuck child', async () => {
    const dir = tmp()
    const f = join(dir, 'stuck.mjs')
    writeFileSync(f, "setInterval(() => {}, 1000)")
    await expect(runDiarize(f, join(dir, 'them.wav'), 'm.gguf', join(dir, 'r.rttm'), 'cpu', 100)).rejects.toThrow(/timed out/)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd app && npx vitest run test/diarizeRun.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `app/src/main/diarize/run.ts`**

```ts
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

/**
 * Runs the two local tools of a diarization job: the recorder helper's decode (m4a on a Mac, Ogg Opus on
 * Windows and Linux) and nemo-speech's diarize. Backends: metal on a Mac, vulkan elsewhere, cpu everywhere;
 * an accelerator that fails to start falls back to cpu once. Only backend names land in the log.
 */
export type Backend = 'cpu' | 'vulkan' | 'metal'

export function probeBackend(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): Backend {
  const asked = env.YOGURT_DIARIZE_BACKEND as Backend | undefined
  if (asked === 'cpu' || asked === 'vulkan' || asked === 'metal') return asked
  return platform === 'darwin' ? 'metal' : 'vulkan'
}

/** a stuck child is killed well after the audio itself could have been processed (model load included) */
export const diarizeTimeoutMs = (audioMs: number): number => Math.max(180_000, Math.round(audioMs * 8) + 120_000)

const exec = (cmd: string, args: string[], timeoutMs: number): Promise<void> => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  child.stderr?.on('data', (d: Buffer) => { err += d.toString() })
  const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${cmd} timed out after ${timeoutMs} ms`)) }, timeoutMs)
  child.on('error', (e) => { clearTimeout(timer); reject(e) })
  child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`${cmd} failed (${code}): ${err.trim().slice(0, 400)}`)) })
})

/** the meeting's them file as 16 kHz mono wav in a temp dir (m4a via AVFoundation on a Mac, Ogg Opus elsewhere) */
export async function runDecode(helper: string, input: string, out: string, timeoutMs = 120_000): Promise<void> {
  await exec(helper, ['decode', '--in', input, '--out', out], timeoutMs)
}

/** RTTM into rttmPath. Returns which backend won; a failed accelerator is retried once on the cpu. */
export async function runDiarize(nemo: string, wav: string, model: string, rttmPath: string, backend: Backend, timeoutMs?: number): Promise<'gpu' | 'cpu'> {
  const cap = timeoutMs ?? diarizeTimeoutMs(0)
  const once = (device: string) => exec(nemo, ['diarize', wav, '--model', model, '--format', 'rttm', '--output', rttmPath, '--device', device], cap)
  if (backend === 'cpu') { await once('cpu'); return 'cpu' }
  try {
    await once(backend)
    console.info(`DIARIZE backend: ${backend}`)
    return 'gpu'
  } catch (err) {
    console.warn(`DIARIZE ${backend} failed, trying the cpu:`, err instanceof Error ? err.message : err)
    await once('cpu')
    console.info('DIARIZE backend: cpu')
    return 'cpu'
  }
}
```

Note `runDecode`/`runDiarize` never log audio paths' contents, only tool names and backends.

- [ ] **Step 4: Run the tests**

Run: `cd app && npx vitest run test/diarizeRun.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/diarize/run.ts app/test/diarizeRun.test.ts
git commit -m "feat(diarize): spawn decode and nemo-speech with backend fallback"
```

---

### Task 13: Orchestrator

**Files:**
- Create: `app/src/main/diarize/fake.ts`, `app/src/main/diarize/index.ts`
- Modify: `app/src/main/notes/queue.ts` (`diarize` job kind)
- Test: `app/test/diarize.test.ts` (new)

**Interfaces:**
- Consumes: everything from Tasks 1–12.
- Produces:
  - `JobKind` gains `'diarize'`.
  - `createDiarizer(p: Deps): { schedule(id: string): void; finished(id: string): Promise<void> }` where

```ts
export type Deps = {
  store: Pick<Store, 'meeting' | 'segments' | 'applyDiarization' | 'meetingSpeakers' | 'markDiarized' | 'speakerOrder' | 'voiceCentroids' | 'createVoiceProfile' | 'updateVoiceCentroid' | 'bumpVoiceProfile'>
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
```

  - `finished(id)` always resolves (failure is recorded on the meeting).
  - `schedule` runs the job through `queue.enqueue(job, 'diarize', id)`.

- [ ] **Step 1: Queue kind**

In `app/src/main/notes/queue.ts`:

```ts
export type JobKind = 'names' | 'enhance' | 'chat' | 'readahead' | 'index' | 'folder' | 'diarize'
```

and in `allowed(kind)` add, as the first line:

```ts
    // diarization is a local cli, not the notes model: it waits for no download, only for the recording on a small machine
    if (kind === 'diarize') return o.smallMac ? !o.recording() : true
```

Extend `app/test/queue.test.ts` with one test: a `diarize` job runs on a big Mac while the notes model is missing (`modelReady: () => false`) and does not run on a small Mac while recording. (Mirror the file's existing queue fixtures.)

- [ ] **Step 2: Write the failing orchestrator test**

Create `app/test/diarize.test.ts`:

```ts
import { writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type Store } from '../src/main/store'
import { createDiarizer, type Deps } from '../src/main/diarize/index'
import { writeWav } from '../src/main/diarize/wav'

const dirs: string[] = []
const stores: Store[] = []
afterEach(() => { stores.splice(0).forEach((s) => s.close()); dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })) })
const fresh = () => { const d = mkdtempSync(join(tmpdir(), 'yogurt-diarize-')); dirs.push(d); const s = openStore(join(d, 'yogurt.db')); stores.push(s); return s }
const base = { title: 'Sync', endedAt: null, eventId: null, app: null, attendees: [], state: 'recording' as const }
const word = (text: string, startMs: number, endMs: number) => ({ text, startMs, endMs })

/** two voices; the call names on the rows decide the claims (pass [null, null] for a Them-only meeting) */
const seed = (s: Store, speakers: [string | null, string | null] = ['Ann Lee', null]) => {
  const m = s.createMeeting({ ...base, startedAt: 1 })
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
  const rttm = 'SPEAKER them 1 0.000 2.100 <NA> <NA> 0 <NA> <NA>\nSPEAKER them 1 2.300 2.200 <NA> <NA> 1 <NA> <NA>\n'
  const run = {
    decode: async (_helper: string, _input: string, out: string) => writeWav(out, new Float32Array(16 * 5000)),
    diarize: async (_nemo: string, _wav: string, _model: string, rttmPath: string) => { writeFileSync(rttmPath, rttm); return 'gpu' as const },
  }
  const deps: Deps = {
    store, queue: { enqueue: async (job) => { await job(new AbortController().signal) } },
    audioHelper: () => 'helper', nemoPath: () => 'nemo', modelPath: () => 'm.gguf',
    ensureSpeakerModel: async () => 'speaker.onnx', embed: undefined,
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
      ['me', 'hi', undefined],
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
    const id = seed(store)
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
    const id = seed(store, [null, null]) // no call names anywhere: both voices stay Speaker N
    const d = createDiarizer({ ...deps, embedVectors: async (_w, ranges) => ranges.map(() => new Float32Array([1, 0, 0])) })
    d.schedule(id)
    await d.finished(id)
    expect(store.voiceProfiles()).toEqual([])
    expect(store.meetingSpeakers(id).every(x => x.profileId === null)).toBe(true)
  })

  it('enrolls a named voice with no match as a new profile', async () => {
    const { store, deps } = setup({ allowed: () => true })
    const id = seed(store)
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
    const { store, deps } = setup({ run: { ...deps.run!, decode: async () => { throw new Error('unsupported-input') } } })
    const id = seed(store)
    const d = createDiarizer(deps)
    d.schedule(id)
    await d.finished(id)
    expect(store.meeting(id)).toMatchObject({ diarizeError: 'unsupported-input', diarizedAt: undefined })
    expect(store.segments(id).every(x => x.speakerKey === undefined)).toBe(true)
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
})
```

(`Deps.run` type: `{ decode: typeof runDecode; diarize: typeof runDiarize }` — export the pair type from `run.ts` for injection.)

- [ ] **Step 3: Run to verify it fails**

Run: `cd app && npx vitest run test/diarize.test.ts test/queue.test.ts`
Expected: FAIL — `createDiarizer` missing, `diarize` kind unknown.

- [ ] **Step 4: Implement `app/src/main/diarize/fake.ts`**

```ts
import { writeWav } from './wav'
import type { Turn } from './rttm'

/**
 * Fake mode: no helpers, no nemo-speech, no onnx. A deterministic two-voice diarization from the fake
 * transcript (YOGURT_FAKE_VOICES=1 puts both fake lines on one voice), a silent wav for decode, and
 * vectors hashed from a voice key so a voice matches its own profile across meetings.
 *   YOGURT_FAKE_VOICE_SIM=none|ambiguous tunes the next meeting's match (match is the default).
 *   YOGURT_FAKE_DIARIZE_FAIL=1 makes the diarizer return no turns at all (a recorded no-op, as in production).
 */

/** the fake transcript's them lines (asr/fake.ts), padded so claims are long enough */
const TURNS: Turn[] = [
  { key: 'f1', startMs: 5000, endMs: 8900 },
  { key: 'f2', startMs: 13_000, endMs: 16_000 },
]

export function fakeTurns(): Turn[] {
  if (process.env.YOGURT_FAKE_DIARIZE_FAIL === '1') return []
  if (process.env.YOGURT_FAKE_VOICES === '1') return [{ key: 'f1', startMs: TURNS[0].startMs, endMs: TURNS[1].endMs }]
  return TURNS
}

export function fakeDecode(_helper: string, _input: string, out: string): Promise<void> {
  // 20 s of silence at 16 kHz: long enough for the fake turns
  writeWav(out, new Float32Array(16 * 20_000))
  return Promise.resolve()
}

/** deterministic, signed, so different keys are near-orthogonal (unit vectors of positive numbers all correlate) */
const hash = (s: string): Float32Array => {
  const v = new Float32Array(8)
  for (let i = 0; i < s.length; i++) {
    let h = (s.charCodeAt(i) * 2654435761) >>> 0
    v[i % 8] += ((h % 200) - 100) / 100
  }
  return v
}
const unit = (v: Float32Array): Float32Array => {
  let sum = 0
  for (const x of v) sum += x * x
  const n = Math.sqrt(sum) || 1
  return Float32Array.from(v, (x) => x / n)
}
export const fakeVector = (key: string): Float32Array => unit(hash(key))

/** similarity knob: blends the voice's vector toward a decoy (1: itself; ~0.62: ambiguous band; ~0.1: no match) */
export function fakeVectorFor(key: string): Float32Array {
  const sim = { none: 0.1, ambiguous: 0.62 }[process.env.YOGURT_FAKE_VOICE_SIM ?? ''] ?? 1
  const v = fakeVector(key), decoy = fakeVector('decoy'), out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = sim * v[i] + (1 - sim) * decoy[i]
  return unit(out)
}
```

- [ ] **Step 5: Implement `app/src/main/diarize/index.ts`**

```ts
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
    | 'voiceCentroids' | 'createVoiceProfile' | 'updateVoiceCentroid' | 'bumpVoiceProfile' | 'setMeetingSpeakerProfile'>
  queue: Pick<Queue, 'enqueue'>
  audioHelper: () => string
  nemoPath: () => string | undefined
  modelPath: () => string | undefined
  ensureSpeakerModel: () => Promise<string>
  embed: EmbedClient | undefined            // undefined: profiles unavailable (fake mode uses its own vectors)
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
      rmSync(dir, { recursive: true, force: true })
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
    const clusters = new Map<string, Cluster>()
    const put = (key: string): Cluster => clusters.get(key) ?? (() => { const c: Cluster = { key, reused: reuse.has(key), claims: new Map(), total: 0, spans: [] }; clusters.set(key, c); return c })()
    for (const key of keyOf.values()) put(key)
    const keyedRuns: SplitRun[] = [], leftovers: SplitRun[] = []
    for (const r of runs) {
      if (!r.key) { leftovers.push(r); continue }
      keyedRuns.push(r)
      const c = put(r.key)
      const ms = r.endMs - r.startMs
      c.total += ms
      c.spans.push({ startMs: r.startMs, endMs: r.endMs })
      c.claims.set(r.speaker, (c.claims.get(r.speaker) ?? 0) + ms)
    }
    // names: reused clusters keep the name already shown; new clusters resolve (claims, dedupe, Speaker N)
    const reusedKeys = new Set([...reuse.values()])
    const reusedNames = existing.filter(e => reusedKeys.has(e.key)).map(e => nameOfKey(id, e.key)).filter((n): n is string => !!n)
    const live = new Set(p.store.segments(id, { hidden: true }).filter(s => s.track === 'them' && s.speaker).map(s => s.speaker!))
    const resolved = resolveNames(
      [...clusters.values()].filter(c => !c.reused).map(c => ({ key: c.key, claims: [...c.claims].map(([name, ms]) => ({ name, ms })), total: c.total })),
      { taken: [...new Set(reusedNames)], startNumber: nextSpeakerNumber([...live]) })
    const nameOf = new Map(resolved.map(r => [r.key, r.speaker]))
    const finalName = (key: string): string | null => nameOf.get(key) ?? nameOfKey(id, key)
    // voice profiles, only where the meeting allowed them (step 5 may patch cluster rows afterwards)
    // voice profiles, only where the meeting allowed them (step 5 patches cluster rows afterwards)
    await profiles(id, wav, clusters, finalName)
    // one transaction: delete re-split rows, insert runs (reused keys keep their name), leftover remainders, cluster rows
    const deleted = new Set<number>()
    for (const r of [...keyedRuns, ...leftovers]) for (const line of r.lineIds) deleted.add(line)
    for (const keptId of keep) deleted.delete(keptId)
    const insert: Array<Omit<import('../store').Segment, 'id'>> = [...keyedRuns, ...leftovers].map(r => ({
      meetingId: id, track: 'them' as const, startMs: r.startMs, endMs: r.endMs, text: r.text,
      speaker: r.key ? finalName(r.key) : r.speaker, speakerKey: r.key, ...(r.words?.length ? { words: r.words } : {}),
    }))
    const speakers = [...clusters.values()].map(c => {
      const span = spanOf(c)
      const old = existing.find(e => e.key === c.key)
      return {
        key: c.key, speaker: old ? nameOfKey(id, c.key) : finalName(c.key),
        profileId: old?.profileId ?? null, score: old?.score ?? null,
        startMs: Math.min(old?.startMs ?? span.startMs, span.startMs), endMs: Math.max(old?.endMs ?? span.endMs, span.endMs),
      }
    })
    p.store.applyDiarization(id, { deleteIds: [...deleted], insert, speakers })
    p.store.speakerOrder(id) // colour order: first-appearance order across the meeting's named voices
  }

  /** embeddings per new cluster, match against profiles, auto-name the sure ones, enroll the named ones */
  const profiles = async (id: string, wav: string, clusters: Map<string, Cluster>, finalName: (key: string) => string | null, keyedRuns: SplitRun[]) => {
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
        for (const item of items) await matchAndEnroll(id, item.key, fakeVectorFor(item.key), finalName(item.key), spanOf(clusters.get(item.key)!))
        return
      }
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
        const won = !!s.match?.id && !claimed.has(s.match.id)
        if (won) claimed.add(s.match!.id!)
        await matchAndEnroll(id, s.item.key, normalize(s.vec!), finalName(s.item.key), spanOf(clusters.get(s.item.key)!), won ? s.match : s.match && { id: null, score: s.match.score })
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

  const matchAndEnroll = async (id: string, key: string, vec: Float32Array, name: string | null, span: { startMs: number; endMs: number }, matched?: { id: string; score: number } | { id: null; score: number } | null) => {
    const dims = vec.length
    const profiles: ProfileVec[] = p.store.voiceCentroids().filter(pr => pr.dims === dims).map(pr => ({ id: pr.id, name: pr.name, centroid: normalize(pr.centroid), meetings: pr.meetings }))
    const match = matched === undefined ? bestMatch(normalize(vec), profiles) : matched
    const patch: { profileId?: string | null; score?: number | null } = {}
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
          patch.profileId = pid
        }
      } else if (match.id && name === profiles.find(pr => pr.id === match.id)!.name) {
        p.store.bumpVoiceProfile(match.id)
      }
      // matched but the names disagree: skip, never contaminate the voiceprint
    }
    p.store.setMeetingSpeakerProfile(id, key, patch)
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
```

- [ ] **Step 6: Run the tests**

Run: `cd app && npx vitest run test/diarize.test.ts test/diarizeStore.test.ts test/queue.test.ts`
Expected: PASS. Iterate on the orchestrator until all nine scenarios hold.

- [ ] **Step 7: Commit**

```bash
git add app/src/main/diarize app/src/main/notes/queue.ts app/test/diarize.test.ts app/test/queue.test.ts
git commit -m "feat(diarize): orchestrator — decode, diarize, split, name, profiles, persist"
```

---

### Task 14: Wire the main process

**Files:**
- Modify: `app/src/main/index.ts`
- Test: covered by e2e (Task 19); typecheck here.

**Interfaces:**
- Consumes: `createDiarizer`, `createEmbedClient`, `setup.ensureSpeakerModel`, store ops, `callNames.finished`.
- Produces (used by renderer via preload, Task 15):
  - IPC `transcript:rename-speaker` (id, key, name) → boolean
  - IPC `transcript:merge-speaker` (id, fromKey, intoKey) → boolean
  - IPC `voices:list` / `voices:delete` (id) / `voices:delete-all`
  - IPC `settings:set-speaker-profiles` (on)
  - `transcript:get` returns `speakerKey` on lines (automatic via store mapping)

- [ ] **Step 1: Create the diarizer and client (after `queue` is created at line ~558, before `hookNotes` at line ~573)**

In `app/src/main/index.ts`. The embedding worker needs the *downloaded* speaker model path without triggering a download, so keep the resolved path in a variable that `ensureSpeakerModel` fills:

```ts
  // voice profiles: opt-in, local; the worker stays down until a meeting needs it (fake mode uses its own vectors)
  const speakerProfiles = () => !!loadSettings(settingsFile).speakerProfiles
  let speakerModelPath: string | undefined
  const embedClient = isFake() ? undefined : createEmbedClient({
    workerPath: join(__dirname, 'diarize-worker.js'),
    modelPath: () => speakerModelPath,
  })
  let notes: ReturnType<typeof hookNotes> | undefined
  const diarizer = createDiarizer({
    store,
    queue,
    audioHelper: () => audioHelperPath(),
    nemoPath: () => nemoSpeechPath(),
    modelPath: () => setup.installed()?.diarization,
    ensureSpeakerModel: async () => { speakerModelPath = await setup.ensureSpeakerModel(); return speakerModelPath },
    embed: embedClient,
    dirOf: (id) => join(userDataDir(), 'meetings', id),
    exts: () => audioKinds,
    allowed: speakerProfiles,
    fake: isFake(),
    changed: (id) => { win?.webContents.send('transcript:speakers', id); sendWidgetTranscript('transcript:speakers', id); win?.webContents.send('meetings:changed') },
    notesRefresh: (id) => notes?.refresh(id),
  })
```

(`audioKinds` is defined further down in the file today; hoist its `const audioKinds: AudioExt[] = …` declaration above the diarizer, or read the extensions through a small `() => audioKinds` closure declared after it — keep the existing expression identical.)

Order problem: `diarizer` needs `notes.refresh`, and `hookNotes` needs `diarizer.finished`. Declare `let notes` before (as above) and assign it right after `hookNotes` returns: `notes = hookNotes({ … })`. The closure only dereferences it lazily, when a diarize job finishes.

Where does `nemoSpeechPath()` come from? Mirror `whisperServerPath()` in `app/src/main/asr/server.ts` (it already solves the dev-vs-packaged resources path): add `app/src/main/diarize/paths.ts` (new tiny file) and have `nemoSpeechPath()` return the real path with `existsSync` guard, reusing the exact mechanism `whisperServerPath()` uses (read `server.ts` first and copy its layout logic; the bundled layout is `resources/bin` next to the app, the dev layout is `app/resources/bin`). The diarization model path needs no helper: `setup.installed()?.diarization` (Task 9).

- [ ] **Step 2: Trigger and ordering**

2a. voices_allowed snapshot — add near the other `onMeetingStart` registrations (before the diarizer is used):

```ts
  // voice recognition opt-in is snapshotted per meeting: enabling it mid-call never captures the call in progress
  onMeetingStart((m) => { try { store.setVoicesAllowed(m.id, speakerProfiles()) } catch (e) { console.warn('voices_allowed snapshot failed', e) } })
```

2b. Diarize after call names settle — register **before** `hookNotes` so the diarize queue entry lands ahead of the notes job:

```ts
  // diarize once the recording, transcript and call names have settled; its queue entry lands ahead of the notes job
  onMeetingStopSaved((m) => {
    void (async () => {
      await recordingFinished(m.id); await transcriptFinished(m.id); await callNames.finished(m.id)
      diarizer.schedule(m.id)
    })().catch((e) => console.warn('diarize scheduling failed', e))
  })
```

2c. Notes dependency — in the existing `hookNotes({...})` call, change `named`:

```ts
    named: (id) => Promise.all([callNames.finished(id), diarizer.finished(id)]),
```

(`hookNotes` already caps it with `NAMES_WAIT_MS` via `upTo`.)

2d. Resume — in `meetings:resume`'s `Promise.race([...])`, add `diarizer.finished(id)` to the awaited `Promise.all([recordingFinished(id), transcriptFinished(id), callNames.finished(id), analysis.settled])` → `Promise.all([recordingFinished(id), transcriptFinished(id), callNames.finished(id), diarizer.finished(id), analysis.settled])` (still under the 30 s cap; `finished` always resolves).

- [ ] **Step 3: IPC handlers (place near `transcript:get`)**

```ts
  const speakersChanged = (id: string) => {
    win?.webContents.send('transcript:speakers', id)
    sendWidgetTranscript('transcript:speakers', id)
    win?.webContents.send('meetings:changed')
    notes?.refresh(id)
  }
  ipcMain.handle('transcript:rename-speaker', (_e, id: unknown, key: unknown, name: unknown) => {
    if (!isId(id) || typeof key !== 'string' || typeof name !== 'string') return false
    const ok = store.renameSpeaker(id, key, name)
    if (ok) speakersChanged(id)
    return ok
  })
  ipcMain.handle('transcript:merge-speaker', (_e, id: unknown, fromKey: unknown, intoKey: unknown) => {
    if (!isId(id) || typeof fromKey !== 'string' || typeof intoKey !== 'string') return false
    const ok = store.mergeSpeakers(id, fromKey, intoKey)
    if (ok) speakersChanged(id)
    return ok
  })
  ipcMain.handle('voices:list', () => store.voiceProfiles())
  ipcMain.handle('voices:delete', (_e, id: unknown) => { if (typeof id !== 'string' || !id) return; store.deleteVoiceProfile(id); win?.webContents.send('voices:changed') })
  ipcMain.handle('voices:delete-all', () => { store.deleteAllVoiceProfiles(); win?.webContents.send('voices:changed') })
```

- [ ] **Step 4: Temp sweep at launch**

After the `rejoinInterrupted` block:

```ts
  // a crash mid-diarization left a temp wav: sweep it (tmpdir has no meeting data anyone else reads)
  try {
    for (const d of readdirSync(tmpdir()).filter((n) => n.startsWith('yogurt-diarize-'))) {
      rmSync(join(tmpdir(), d), { recursive: true, force: true })
    }
  } catch { /* tmpdir unreadable: nothing to sweep */ }
```

Add `readdirSync`/`rmSync`/`tmpdir` to the existing imports.

- [ ] **Step 5: Typecheck**

Run: `cd app && npm run typecheck && npx vitest run test/transcription.test.ts test/notes.test.ts`
Expected: PASS (existing wiring tests unaffected; `named` now resolves through the diarizer's instant-resolve promise when no job was scheduled).

- [ ] **Step 6: Commit**

```bash
git add app/src/main/index.ts app/src/main/diarize/paths.ts
git commit -m "feat(main): wire diarization into job order, notes naming and IPC"
```

---

### Task 15: Preload API and transcript rename/merge UI

**Files:**
- Modify: `app/src/shared/types.ts` (YogurtApi), `app/src/preload/index.ts`
- Modify: `app/src/renderer/src/components/Transcript.tsx`
- Test: e2e (Task 19); typecheck + existing renderer tests here.

**Interfaces:**
- Consumes: IPC from Task 14; `Segment.speakerKey` (Task 1).
- Produces (used by Task 16, 19):
  - `window.yogurt.transcript.renameSpeaker(id, key, name): Promise<boolean>`
  - `window.yogurt.transcript.mergeSpeaker(id, fromKey, intoKey): Promise<boolean>`
  - `window.yogurt.voices: { list(): Promise<VoiceProfile[]>; delete(id): Promise<void>; deleteAll(): Promise<void>; onChange(cb): () => void }` where `VoiceProfile = { id: string; name: string; meetings: number; createdAt: number; updatedAt: number }` (add to `types.ts`)
  - `window.yogurt.settings.setSpeakerProfiles(on: boolean): Promise<void>` and `speakerProfiles: boolean` in `settings.get()`'s return type.

- [ ] **Step 1: types.ts**

In `YogurtApi.transcript` add:

```ts
    /** renames every line of one voice (diarization key); refuses a name another voice already has */
    renameSpeaker(meetingId: string, key: string, name: string): Promise<boolean>
    /** two voices were one person: the first joins the second, keeping its name and colour */
    mergeSpeaker(meetingId: string, fromKey: string, intoKey: string): Promise<boolean>
```

Add near `NoteView`:

```ts
/** a remembered voice: name and how many meetings it was heard in (the voiceprint itself never crosses IPC) */
export type VoiceProfile = { id: string; name: string; meetings: number; createdAt: number; updatedAt: number }
```

Add a `voices` group to `YogurtApi`:

```ts
  /** remembered voices across meetings (opt-in, local only; never the vectors) */
  voices: {
    list(): Promise<VoiceProfile[]>
    delete(id: string): Promise<void>
    deleteAll(): Promise<void>
    onChange(cb: () => void): () => void
  }
```

In `settings.get()`'s return type add `/** remember voices across meetings (opt-in) */ speakerProfiles: boolean` and add `setSpeakerProfiles(on: boolean): Promise<void>`.

- [ ] **Step 2: preload/index.ts**

```ts
  voices: {
    list: () => ipcRenderer.invoke('voices:list'),
    delete: (id) => ipcRenderer.invoke('voices:delete', id),
    deleteAll: () => ipcRenderer.invoke('voices:delete-all'),
    onChange: (cb) => {
      const on = () => cb()
      ipcRenderer.on('voices:changed', on)
      return () => { ipcRenderer.removeListener('voices:changed', on) }
    },
  },
```

In `transcript`: `renameSpeaker: (id, key, name) => ipcRenderer.invoke('transcript:rename-speaker', id, key, name)` and `mergeSpeaker: (id, from, into) => ipcRenderer.invoke('transcript:merge-speaker', id, from, into)`.
In `settings`: `setSpeakerProfiles: (on) => ipcRenderer.invoke('settings:set-speaker-profiles', on)`; and `speakerProfiles` in the `get` payload (main side: `speakerProfiles: !!loadSettings(settingsFile).speakerProfiles` — Task 16 wires the main handler; the renderer field reads it).

- [ ] **Step 3: Transcript.tsx rename/merge UI**

Replace the `<span data-testid="transcript-who" …>` (around line 397) with a small component. Add above `Transcript`:

```tsx
/** A voice of the other side: its name is editable in place, and two voices can be merged (one inline confirm; no undo). The widget transcript stays read-only. */
function WhoName({ meetingId, line, voices }: { meetingId: string; line: Line; voices: Array<{ name: string; key: string }> }) {
  const named = line.speaker
  const key = line.speakerKey
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [menu, setMenu] = useState(false)
  const [confirming, setConfirming] = useState<{ name: string; key: string } | null>(null)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { if (editing) input.current?.select() }, [editing])
  if (!key) return <span data-testid="transcript-who">{who(line)}</span>
  const commit = () => {
    const name = draft.replace(/\s+/g, ' ').trim().slice(0, 80)
    setEditing(false)
    if (name && name !== named) void window.yogurt.transcript.renameSpeaker(meetingId, key, name)
  }
  const merge = () => {
    if (!confirming) return
    setMenu(false); setConfirming(null)
    void window.yogurt.transcript.mergeSpeaker(meetingId, key, confirming.key)
  }
  const label = named ? t('Rename') : t('Name this voice')
  return (
    <span className="turn-head-name">
      {editing ? (
        <input ref={input} data-testid="speaker-name-input" value={draft} aria-label={t('Rename')}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setEditing(false); setDraft('') } }}
          onBlur={commit} spellCheck={false} className="speaker-name-input" />
      ) : (
        <>
          <button type="button" data-testid="transcript-who" className="line-who font-medium" title={label}
            onClick={() => { setDraft(named ?? ''); setEditing(true) }}>{who(line)}</button>
          <button type="button" data-testid="speaker-menu" aria-label={label} aria-haspopup="menu" aria-expanded={menu}
            onClick={() => { setConfirming(null); setMenu((m) => !m) }} className="speaker-menu-btn"><ChevronDown size={12} aria-hidden="true" /></button>
          {menu && (
            <div role="menu" data-testid="speaker-menu-list" onKeyDown={(e) => { if (e.key === 'Escape') { setMenu(false); (e.currentTarget.previousElementSibling as HTMLElement)?.focus() } }}>
              <button type="button" role="menuitem" data-testid="speaker-rename" onClick={() => { setMenu(false); setDraft(named ?? ''); setEditing(true) }}>{t('Rename')}</button>
              {confirming ? (
                <button type="button" role="menuitem" data-testid="speaker-merge-confirm" onClick={merge}>
                  {t('Merge {a} into {b}?', { a: named ?? t('Them'), b: confirming.name })}
                </button>
              ) : voices.filter((v) => v.name !== named && v.key !== key).map((v) => (
                <button type="button" role="menuitem" data-testid="speaker-merge" key={v.key} onClick={() => setConfirming(v)}>
                  {t('Merge into {name}', { name: v.name })}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </span>
  )
}
```

The parent `Transcript` computes `voices` — the meeting's distinct `them` voices, first-appearance order — and passes it to every turn head (`them` turns only; `me` lines keep the plain `who()` span):

```tsx
  const themVoices = useMemo(() => {
    const byKey = new Map<string, string>()
    for (const l of [...allLines].sort((a, b) => a.startMs - b.startMs)) if (l.track === 'them' && l.speaker && l.speakerKey) byKey.set(l.speakerKey, l.speaker)
    return [...byKey].map(([k, name]) => ({ key: k, name }))
  }, [allLines])
```

and in the turn rendering: `{me ? <span data-testid="transcript-who" …>{who(first)}</span> : <WhoName meetingId={id} line={first} voices={themVoices} />}` — keep the existing `data-color`/`data-folder-color` attributes on the rendered name element (move them onto `WhoName`'s button and plain span alike, since `speakerColors.spec.ts` reads them).

Rules honoured: click on the name → inline input (Enter commits, Escape cancels, blur commits, empty cancels); whitespace collapsed; cap 80; merge asks for one inline confirmation (`speaker-merge` opens it, `speaker-merge-confirm` performs it); keyboard reachable (`button` elements, `role="menu"`, Escape closes and returns focus).

- [ ] **Step 4: Run typecheck and renderer tests**

Run: `cd app && npm run typecheck && npx vitest run test/transcriptView.test.ts test/speakerColors.test.ts test/i18n-tables.test.ts`
Expected: `i18n-tables` FAILS on the new keys (`Merge into {name}`, `Name this voice`, `Merge {a} into {b}?`) — that is Task 18's job. Record the failure; typecheck and the other two files must PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/shared/types.ts app/src/preload/index.ts app/src/renderer/src/components/Transcript.tsx
git commit -m "feat(transcript): inline speaker rename and merge"
```

---

### Task 16: Settings — voice recognition section

**Files:**
- Modify: `app/src/main/settings.ts` (type + main handler is Task 14's IPC; `settings:get` payload), `app/src/renderer/src/screens/Settings.tsx`
- Test: extend `app/test/settingsPermissions.test.ts`-style unit? The existing settings tests are e2e-heavy; verification here is the i18n table test + typecheck; behaviour e2e is Task 19.

**Interfaces:**
- Consumes: `voices` IPC, `speakerProfiles` setting.
- Produces: Settings section **Voice recognition** with toggle, consent panel, profile rows, delete-all.

- [ ] **Step 1: settings.ts type**

In `Settings` (top of `app/src/main/settings.ts`) add:

```ts
  /** remember voices across meetings (opt-in, local only); off unless the person said yes */
  speakerProfiles?: boolean
```

In `app/src/main/index.ts`'s `settings:get` handler (find where `settings.get` payload is built), add `speakerProfiles: !!loadSettings(settingsFile).speakerProfiles`, and the handler for `settings:set-speaker-profiles`:

```ts
  ipcMain.handle('settings:set-speaker-profiles', (_e, on: unknown) => {
    updateSettings(settingsFile, { speakerProfiles: on === true ? true : undefined })
    // already-recorded meetings keep their snapshot; this only affects the next ones
  })
```

- [ ] **Step 2: Settings.tsx section**

Add a new section component in `app/src/renderer/src/screens/Settings.tsx` and render it after the **What Yogurt can use** heading:

```tsx
function VoiceRecognition() {
  const [prefs, setPrefs] = useState<{ speakerProfiles: boolean } | null>(null)
  const [profiles, setProfiles] = useState<VoiceProfile[]>([])
  const [consent, setConsent] = useState(false)
  useEffect(() => {
    void window.yogurt.settings.get().then((s) => setPrefs({ speakerProfiles: s.speakerProfiles }))
    void window.yogurt.voices.list().then(setProfiles)
    return window.yogurt.voices.onChange(() => void window.yogurt.voices.list().then(setProfiles))
  }, [])
  const setOn = (on: boolean) => {
    if (on && !consentShown()) { setConsent(true); return }
    setPrefs({ speakerProfiles: on })
    void window.yogurt.settings.setSpeakerProfiles(on)
  }
  const accept = () => {
    setConsent(false)
    localStorage.setItem('voice-consent', '1')
    setPrefs({ speakerProfiles: true })
    void window.yogurt.settings.setSpeakerProfiles(true)
  }
  const on = !!prefs?.speakerProfiles
  return (
    <section data-testid="voice-recognition">
      <h2 className="settings-section-heading">{t('Voice recognition')}</h2>
      <div className="settings-row">
        <div>
          <p>{t('Remember voices across meetings')}</p>
          <p className="text-muted text-xs">{t('Names a speaker the next time their voice is heard. The voiceprint stays on this computer.')}</p>
        </div>
        <button data-testid="voice-toggle" role="switch" aria-checked={on} onClick={() => setOn(!on)} className="settings-toggle"><span className="settings-toggle-knob" /></button>
      </div>
      {on && (profiles.length ? profiles.map((p) => (
        <div className="settings-row" data-testid="voice-profile" key={p.id}>
          <p>{p.name}<span className="text-muted text-xs"> · {t('{count} meetings', { count: p.meetings })}</span></p>
          <button data-testid="voice-delete" aria-label={t('Delete')} onClick={() => void window.yogurt.voices.delete(p.id)} className="ghost-btn"><Trash2 size={14} aria-hidden="true" /></button>
        </div>
      )) : <p className="text-muted text-xs" data-testid="voice-empty">{t('No voices remembered yet.')}</p>)}
      {!on && profiles.length > 0 && <p className="text-muted text-xs" data-testid="voice-off-note">{t('Voice profiles stay on this computer, unused, until you turn this on again.')}</p>}
      {on && profiles.length > 0 && (
        <button data-testid="voice-delete-all" className="ghost-btn" onClick={() => { if (confirmDeleteAll()) void window.yogurt.voices.deleteAll() }}>{t('Delete all voice profiles')}</button>
      )}
      {consent && (
        <div role="dialog" aria-label={t('Voice recognition')} data-testid="voice-consent" className="modal">
          <p>{t('A voiceprint is biometric data. It stays on this computer and you can delete it at any time.')}</p>
          <button data-testid="voice-consent-accept" className="modal-button primary" onClick={accept}>{t('Turn on')}</button>
          <button data-testid="voice-consent-cancel" className="modal-button" onClick={() => setConsent(false)}>{t('Cancel')}</button>
        </div>
      )}
    </section>
  )
}
```

Adapt class names to the file's existing section/row/toggle styles (`settings-row`, `ghost-btn`, `modal` already exist in this codebase's components — check `CalendarSettings`/`AiApps` in the same file for the exact wrappers and reuse them). `confirmDeleteAll` may be a `window.confirm`-style inline dialog; the repo prefers inline modals — mirror `deleteDialog` patterns if simple, else `confirm()` is acceptable for v1 (the spec asks for "with confirmation").

`consentShown()` = `localStorage.getItem('voice-consent') === '1'` — the consent panel shows once; afterwards the toggle goes straight on/off.

- [ ] **Step 3: Typecheck and i18n status**

Run: `cd app && npm run typecheck && npx vitest run test/i18n-tables.test.ts`
Expected: typecheck PASS; `i18n-tables` still failing only on the new keys (Task 18).

- [ ] **Step 4: Commit**

```bash
git add app/src/main/settings.ts app/src/main/index.ts app/src/renderer/src/screens/Settings.tsx
git commit -m "feat(settings): voice recognition section with consent and profile management"
```

---

### Task 17: Backup excludes voice profiles

**Files:**
- Modify: `app/src/main/backup.ts` (`exportBackup`)
- Test: extend `app/test/backup.test.ts`

**Interfaces:**
- Consumes: `voice_profiles`, `meeting_speakers` (Task 1).
- Produces: an export snapshot where `voice_profiles` is gone and `meeting_speakers.profile_id` is NULL; import never creates or changes voice tables.

- [ ] **Step 1: Write the failing test**

Append to `app/test/backup.test.ts` (inside the main `describe`, reusing its `fresh()` helper; note `importBackup` takes `{ db, meetingsDir, zip }`):

```ts
  it('leaves voice profiles out of the export and untouched by an import', async () => {
    const s = fresh()
    s.createVoiceProfile({ id: 'p1', name: 'Ada', model: 'campplus', dims: 8, centroid: Buffer.alloc(32) })
    const m = s.createMeeting({ ...base, startedAt: 1, state: 'done' })
    s.applyDiarization(m.id, { deleteIds: [], insert: [], speakers: [{ key: 'v1', speaker: 'Ada', profileId: 'p1', score: 0.9, startMs: 0, endMs: 100 }] })
    const out = join(mkdtempSync(join(tmpdir(), 'yogurt-export-')), 'backup.zip')
    await exportBackup({ db: s.db, meetingsDir: join(tmpdir(), 'yogurt-no-meetings'), out, appVersion: '0.0.0' })
    // read the snapshot back out of the zip
    const dir = join(mkdtempSync(join(tmpdir(), 'yogurt-unzip-')), 'x')
    await unpack(out, dir) // unpack is already imported at the top of this file
    const snap = new DatabaseSync(join(dir, 'yogurt.db'))
    expect(snap.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'voice_profiles'").get()).toBeUndefined()
    expect((snap.prepare('SELECT profile_id FROM meeting_speakers').all() as Array<{ profile_id: unknown }>).every((r) => r.profile_id === null)).toBe(true)
    snap.close()
    // importing adds the meeting but neither creates nor removes profiles here
    const into = fresh()
    into.createVoiceProfile({ id: 'p2', name: 'Bo', model: 'campplus', dims: 8, centroid: Buffer.alloc(32) })
    const r = await importBackup({ db: into.db, meetingsDir: join(tmpdir(), 'yogurt-no-meetings-into'), zip: out })
    expect(r.ok && r.added).toContain(m.id)
    expect(into.voiceProfiles().map((p) => p.id)).toEqual(['p2'])
  })
```

(`unpack` is the name this file already imports from `./zip`; check the top of `backup.test.ts` and reuse whatever it uses there — `exportNotes.test.ts` shows the unpack pattern for a raw snapshot check.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd app && npx vitest run test/backup.test.ts`
Expected: FAIL — `voice_profiles` still in the snapshot.

- [ ] **Step 3: Implement in `exportBackup`**

After the trashed-meetings scrub and before reading ids:

```ts
    // voiceprints never leave this computer: the snapshot drops them, keeping cluster rows without their profile
    if (tables(snap).has('voice_profiles')) {
      snap.exec('PRAGMA foreign_keys = OFF')
      if (columns(snap, 'meeting_speakers').some((c) => c.name === 'profile_id')) snap.exec('UPDATE meeting_speakers SET profile_id = NULL')
      snap.exec('DROP TABLE voice_profiles')
      snap.exec('VACUUM')
      snap.exec('PRAGMA foreign_keys = ON')
    }
```

Import needs no change: `plans()` copies only `meetingTables` + `carriedTables`, and neither lists `voice_profiles`.

- [ ] **Step 4: Run the tests**

Run: `cd app && npx vitest run test/backup.test.ts test/backupIpc.test.ts test/exportNotes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/backup.ts app/test/backup.test.ts
git commit -m "feat(backup): voice profiles stay local, exports carry clusters without them"
```

---

### Task 18: UI strings in every locale

**Files:**
- Modify: `app/src/shared/locales/*.json` (all 31 non-English locales)

**Interfaces:**
- Consumes: the keys introduced by Tasks 15–16.
- Produces: a green `test/i18n-tables.test.ts`.

The new keys (English source text is the key itself; `en.json` needs nothing since none has plurals):

1. `Merge into {name}`
2. `Merge {a} into {b}?`
3. `Name this voice`
4. `Voice recognition`
5. `Remember voices across meetings`
6. `Names a speaker the next time their voice is heard. The voiceprint stays on this computer.`
7. `No voices remembered yet.`
8. `Voice profiles stay on this computer, unused, until you turn this on again.`
9. `Delete all voice profiles`
10. `A voiceprint is biometric data. It stays on this computer and you can delete it at any time.`
11. `Turn on`

(`Rename`, `Delete`, `Cancel`, `Turn on` — check which already exist: `Rename`, `Delete`, `Cancel` exist everywhere; `Turn on` may not. Include `Turn on` in the list only if missing.)

- [ ] **Step 1: Run the table test to list missing keys per locale**

Run: `cd app && npx vitest run test/i18n-tables.test.ts`
Expected: FAIL, listing every missing key for each of the 31 locale files.

- [ ] **Step 2: Add the keys**

For each locale file listed, add the 11 keys with correct translations (keep `{name}`, `{a}`, `{b}` placeholders verbatim). German example:

```json
  "Merge into {name}": "Zusammenführen mit {name}",
  "Merge {a} into {b}?": "{a} mit {b} zusammenführen?",
  "Name this voice": "Diese Stimme benennen",
  "Voice recognition": "Stimmerkennung",
  "Remember voices across meetings": "Stimmen über Meetings hinweg merken",
  "Names a speaker the next time their voice is heard. The voiceprint stays on this computer.": "Benennt eine Person, wenn ihre Stimme wieder gehört wird. Der Stimmabdruck bleibt auf diesem Computer.",
  "No voices remembered yet.": "Noch keine Stimmen gemerkt.",
  "Voice profiles stay on this computer, unused, until you turn this on again.": "Stimmprofile bleiben unbenutzt auf diesem Computer, bis du sie wieder einschaltest.",
  "Delete all voice profiles": "Alle Stimmprofile löschen",
  "A voiceprint is biometric data. It stays on this computer and you can delete it at any time.": "Ein Stimmabdruck ist biometrische Daten. Er bleibt auf diesem Computer, und du kannst ihn jederzeit löschen.",
  "Turn on": "Einschalten"
```

Translate the same keys into: ar, bn, cs, da, de, el, es, fi, fil, fr, he, hi, hu, id, it, ja, ko, ms, nb, nl, pl, pt-BR, ro, ru, sv, th, tr, uk, vi, zh-CN, zh-TW.

- [ ] **Step 3: Verify**

Run: `cd app && npx vitest run test/i18n-tables.test.ts`
Expected: PASS (placeholders preserved, no empty strings, nothing stale).

- [ ] **Step 4: Commit**

```bash
git add app/src/shared/locales
git commit -m "i18n: voice recognition and rename/merge strings in every locale"
```

---

### Task 19: Fake mode diarizer

**Files:**
- Modify: `app/src/main/index.ts` (fake-mode embed client: skip the utility process)
- Test: `app/test/fakeDiarize.test.ts` (new)

**Interfaces:**
- Produces: in fake mode the diarizer uses `fakeDecode`/`fakeTurns` (already via `fake: true`) and `fakeVectorFor` instead of the embedding worker; `YOGURT_FAKE_VOICES=1` gives one voice; `YOGURT_FAKE_VOICE_SIM=none|ambiguous` tunes matching; `YOGURT_FAKE_DIARIZE_FAIL=1` makes diarization a recorded no-op.

- [ ] **Step 1: Fake embeddings without the worker**

Task 14's snippet already builds the client conditionally (`const embedClient = isFake() ? undefined : createEmbedClient(...)`) and `createDiarizer`'s fake branch never calls `p.embed`, so nothing new to wire here. Verify only that `fake.ts` (Task 13) exports `fakeTurns`, `fakeDecode`, `fakeVector`, `fakeVectorFor`.

- [ ] **Step 2: Write the failing test**

Create `app/test/fakeDiarize.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { fakeTurns, fakeVectorFor, fakeVector } from '../src/main/diarize/fake'
import { cosine } from '../src/main/diarize/match'

afterEach(() => { delete process.env.YOGURT_FAKE_VOICES; delete process.env.YOGURT_FAKE_VOICE_SIM })

describe('fake diarizer', () => {
  it('two voices from the fake transcript, one with YOGURT_FAKE_VOICES=1', () => {
    expect(fakeTurns()).toHaveLength(2)
    process.env.YOGURT_FAKE_VOICES = '1'
    expect(fakeTurns()).toHaveLength(1)
  })
  it('vectors match their own key strongly, and the sim knob tunes it', () => {
    const self = cosine(fakeVectorFor('f1'), fakeVector('f1'))
    expect(self).toBeGreaterThan(0.8)
    process.env.YOGURT_FAKE_VOICE_SIM = 'ambiguous'
    expect(cosine(fakeVectorFor('f1'), fakeVector('f1'))).toBeGreaterThan(0.6)
    expect(cosine(fakeVectorFor('f1'), fakeVector('f1'))).toBeLessThan(0.72)
    process.env.YOGURT_FAKE_VOICE_SIM = 'none'
    expect(cosine(fakeVectorFor('f1'), fakeVector('f1'))).toBeLessThan(0.6)
  })
  it('different keys differ', () => {
    expect(cosine(fakeVector('f1'), fakeVector('f2'))).toBeLessThan(0.99)
  })
})
```

- [ ] **Step 3: Run**

Run: `cd app && npx vitest run test/fakeDiarize.test.ts`
Expected: PASS (module exists from Task 13).

- [ ] **Step 4: Commit**

```bash
git add app/src/main/index.ts app/test/fakeDiarize.test.ts
git commit -m "feat(fake): deterministic fake diarization and voice vectors"
```

---

### Task 20: E2E tests

**Files:**
- Create: `app/e2e/diarize.spec.ts`, `app/e2e/voiceProfiles.spec.ts`

**Interfaces:**
- Consumes: fake mode (Task 19), rename/merge UI (Task 15), Settings section (Task 16), `speaker-key`-aware transcript (Tasks 1, 14).

- [ ] **Step 1: `app/e2e/diarize.spec.ts`**

```ts
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')

async function launch(env: Record<string, string> = {}) {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-diarize-e2e-'))
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData, ...env } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page }
}

const whoOf = (page: import('@playwright/test').Page, text: string) =>
  page.getByTestId('transcript-turn').filter({ has: page.getByTestId('transcript-line').filter({ hasText: text }) }).getByTestId('transcript-who')

test('a recorded meeting splits into two speakers with distinct colours', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_AX: 'denied' }) // no call names: Speaker 1 / Speaker 2
  try {
    await page.getByRole('button', { name: 'Start recording', exact: true }).click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    await page.getByTestId('note-stop').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'done', { timeout: 60_000 })
    await page.getByTestId('note-transcript-toggle').click()
    const lines = page.getByTestId('transcript-line')
    // the fixtures' two them lines are two voices in fake diarization
    await expect(whoOf(page, 'The site goes live on Tuesday')).toHaveText('Speaker 1', { timeout: 30_000 })
    await expect(whoOf(page, 'She will send a draft')).toHaveText('Speaker 2', { timeout: 30_000 })
    const first = await whoOf(page, 'The site goes live on Tuesday').getAttribute('data-color')
    const second = await whoOf(page, 'She will send a draft').getAttribute('data-color')
    expect(first).not.toBe(second)
  } finally { await app.close() }
})

test('inline rename updates every turn of the voice', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_AX: 'denied' })
  try {
    await record(page)
    const who = whoOf(page, 'The site goes live on Tuesday')
    await expect(who).toHaveText('Speaker 1', { timeout: 30_000 })
    const firstColor = await who.getAttribute('data-color')
    await who.click()
    const input = page.getByTestId('speaker-name-input')
    await input.fill('  Ana   Silva ')
    await input.press('Enter')
    await expect(whoOf(page, 'The site goes live on Tuesday')).toHaveText('Ana Silva')
    // the other voice is untouched, and the renamed voice keeps its colour slot
    await expect(whoOf(page, 'She will send a draft')).toHaveText('Speaker 2')
    expect(await whoOf(page, 'Ana Silva').getAttribute('data-color')).toBe(firstColor)
    // Escape cancels, blur commits, empty cancels are covered by the same flow; a reload keeps the name
    await page.reload()
    await page.getByTestId('note-transcript-toggle').click()
    await expect(whoOf(page, 'The site goes live on Tuesday')).toHaveText('Ana Silva')
  } finally { await app.close() }
})

test('merge combines two voices and keeps the other speakers' colours', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_AX: 'denied' })
  try {
    await record(page)
    await whoOf(page, 'The site goes live on Tuesday').click()
    await page.getByTestId('speaker-name-input').fill('Ana')
    await page.getByTestId('speaker-name-input').press('Enter')
    const second = whoOf(page, 'She will send a draft')
    const secondColorBefore = await second.getAttribute('data-color')
    await second.click()
    await page.getByTestId('speaker-name-input').fill('Bo')
    await page.getByTestId('speaker-name-input').press('Enter')
    await whoOf(page, 'Bo').click()
    await page.getByTestId('speaker-menu').click()
    await page.getByRole('menuitem', { name: 'Merge into Ana' }).click()
    await page.getByTestId('speaker-merge-confirm').click()
    await expect(whoOf(page, 'The site goes live on Tuesday')).toHaveText('Ana', { timeout: 15_000 })
    await expect(whoOf(page, 'She will send a draft')).toHaveText('Ana')
    // Ana keeps the first slot; the merged voice does not reshuffle others
    const firstColor = await whoOf(page, 'Ana').first().getAttribute('data-color')
    expect(firstColor).toBe('0')
  } finally { await app.close() }
})

test('diarization failure leaves the transcript usable', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_AX: 'denied', YOGURT_FAKE_DIARIZE_FAIL: '1' })
  try {
    await record(page)
    await expect(page.getByTestId('transcript-line').filter({ hasText: 'The site goes live' })).toBeVisible({ timeout: 30_000 })
    // no names arrived, nothing crashed: lines are Them
    await expect(whoOf(page, 'The site goes live on Tuesday')).toHaveText('Them')
  } finally { await app.close() }
})

async function record(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Start recording', exact: true }).click()
  await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
  await page.getByTestId('note-stop').click()
  await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'done', { timeout: 60_000 })
  await page.getByTestId('note-transcript-toggle').click()
}
```

Note: `YOGURT_FAKE_DIARIZE_FAIL=1` needs a small fake hook — in `fake.ts`'s `fakeTurns`, return `[]` when `process.env.YOGURT_FAKE_DIARIZE_FAIL === '1'` (zero valid turns = no-op, recorded as `diarize_error`), and extend `test/fakeDiarize.test.ts` with that case.

- [ ] **Step 2: `app/e2e/voiceProfiles.spec.ts`**

```ts
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')

async function launch(env: Record<string, string> = {}) {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-voices-e2e-'))
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData, ...env } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page, userData }
}

async function recordOnce(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Start recording', exact: true }).click()
  await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
  await page.getByTestId('note-stop').click()
  await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'done', { timeout: 60_000 })
}

async function settings(page: import('@playwright/test').Page) {
  await page.getByTestId('settings-nav').click()   // adapt to the app's real navigation (Settings entry point)
  await expect(page.getByTestId('voice-recognition')).toBeVisible()
}

test('opt-in, first meeting enrolls, second auto-names; ambiguous stays Speaker N', async () => {
  const { app, page } = await launch()
  try {
    await settings(page)
    await page.getByTestId('voice-toggle').click()
    await expect(page.getByTestId('voice-consent')).toBeVisible()
    await page.getByTestId('voice-consent-accept').click()
    // meeting 1: the fake call names the first voice (Ann Lee claims ≥ 2 s of it) and it is enrolled;
    // the second fake voice gets under 2 s of claim, stays Speaker N, and is never enrolled
    await recordOnce(page)
    await page.waitForTimeout(2000) // diarize job
    await settings(page)
    await expect(page.getByTestId('voice-profile')).toHaveCount(1)
    // meeting 2: the voice matches, auto-named
    await recordOnce(page)
    await page.getByTestId('note-transcript-toggle').click()
    const who = page.getByTestId('transcript-who')
    await expect(who.filter({ hasText: 'Ann Lee' }).first()).toBeVisible({ timeout: 30_000 })
    // meeting 3 with the ambiguous knob: same voice, below the auto-name bar
    await app.close()
    const { app: app2, page: page2 } = await launch({ YOGURT_FAKE_VOICE_SIM: 'ambiguous' })
    try {
      await recordOnce(page2)
      await page2.getByTestId('note-transcript-toggle').click()
      await expect(page2.getByTestId('transcript-who').filter({ hasText: 'Speaker' }).first()).toBeVisible({ timeout: 30_000 })
    } finally { await app2.close() }
  } finally { await app.close().catch(() => {}) }
})

test('opt-out meeting creates no profiles; delete and delete-all work', async () => {
  const { app, page } = await launch()
  try {
    await settings(page)
    await page.getByTestId('voice-toggle').click()
    await page.getByTestId('voice-consent-accept').click()
    await recordOnce(page)
    await settings(page)
    await expect(page.getByTestId('voice-profile').first()).toBeVisible()
    // off but kept
    await page.getByTestId('voice-toggle').click()
    await expect(page.getByTestId('voice-off-note')).toBeVisible()
    // back on, delete the one profile, then delete-all on the empty state is a no-op button hidden
    await page.getByTestId('voice-toggle').click()
    await page.getByTestId('voice-delete').first().click()
    await expect(page.getByTestId('voice-empty')).toBeVisible()
  } finally { await app.close() }
})
```

The navigation/selector details (`settings-nav`, note tabs) must be adapted to the real app locators used by `e2e/settings-*.spec.ts` and `e2e/note*.spec.ts` — copy their launch/navigation helpers instead of inventing selectors.

- [ ] **Step 3: Run the e2e suite**

Run: `cd app && npm run e2e -- --grep "diariz|voice"`
Expected: PASS (fake mode; no model downloads). If the fake `diarize` timing is flaky, poll on the visible outcome (as the specs do) rather than sleeping.

- [ ] **Step 4: Commit**

```bash
git add app/e2e/diarize.spec.ts app/e2e/voiceProfiles.spec.ts app/src/main/diarize/fake.ts app/test/fakeDiarize.test.ts
git commit -m "test(e2e): diarization split, rename, merge, voice profiles"
```

---

### Task 21: Real-engine CI

**Files:**
- Create: `.github/workflows/diarize-engine.yml`
- Modify: `.github/workflows/release.yml` only if Task 10 left a gap (verify, don't re-edit otherwise)

**Interfaces:**
- Consumes: `nemo-build.mjs` (Task 10), `yogurt-audio decode` (Task 7).
- Produces: CI proof that decode + diarize work on real engines (Linux Vulkan + CPU fallback; macOS Metal + CPU comparison).

- [ ] **Step 1: Fixture**

Two short speech clips are needed, committed as `app/test/fixtures-engine/clip1.wav` and `clip2.wav` (each ≤ 30 s, different voices, mono). Use the pinned NeMo-Speech.cpp checkout's own test audio (the repo is Apache-2.0):

```bash
rm -rf /tmp/nemo-src && git clone --quiet --depth 50 https://github.com/NVIDIA/NeMo-Speech.cpp /tmp/nemo-src && git -C /tmp/nemo-src checkout --quiet --force c540e21167017d2e34444f2fc2d70649065dc500
find /tmp/nemo-src -name '*.wav' | head -20
```

Pick two different-voice clips ≤ 30 s each, copy them into `app/test/fixtures-engine/`, and record their SHA-256 in the workflow (a `sha256sum -c` step verifies them in CI). If the checkout ships only one voice, take the second clip from a permissive source (e.g. a LibriVox public-domain sample) and pin its SHA-256 the same way; note the source and license in `app/test/fixtures-engine/README.md`.

- [ ] **Step 2: The workflow**

Create `.github/workflows/diarize-engine.yml`:

```yaml
name: diarization engines
on:
  workflow_dispatch:
  schedule:
    - cron: '0 5 * * 1'  # weekly: engines drift more than the app does
jobs:
  linux:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - name: tools
        run: sudo apt-get update && sudo apt-get install -y cmake ninja-build libpulse-dev pkg-config libvulkan-dev vulkan-tools glslc ffmpeg
      - name: build nemo-speech and helpers
        working-directory: app
        run: node scripts/native.mjs --cpu-only  # decode + nemo on the cpu; vulkan covered by the driverless SDK check below
        env: { YOGURT_NO_WHISPER: '1' }
      - name: fixture
        run: |
          # two committed clips (see Step 1), stitched into one two-voice recording, then decoded through the helper
          ffmpeg -y -i app/test/fixtures-engine/clip1.wav -i app/test/fixtures-engine/clip2.wav \
            -filter_complex "[0:a][1:a]concat=n=2:v=0:a=1,aformat=sample_rates=48000:channel_layouts=mono" -c:a libopus /tmp/them.ogg
          app/resources/bin/yogurt-audio decode --in /tmp/them.ogg --out /tmp/them.wav
      - name: diarize on cpu
        working-directory: app
        run: |
          # the model downloads here from its pinned HF URL, verified by the spec's SHA-256:
          curl -sSfL -o /tmp/diar.gguf https://huggingface.co/nvidia/Nemotron-3-Diarization/resolve/main/Nemotron-3-Diarization.q8_0.gguf
          echo "08456d9e22cd9a323c0364d98375f3746d6e68507ebb705cd46438c534c7a3a1  /tmp/diar.gguf" | sha256sum -c -
          YOGURT_DIARIZE_BACKEND=cpu resources/bin/nemo-speech diarize /tmp/them.wav --model /tmp/diar.gguf --format rttm --output /tmp/them.rttm --device cpu
          # the fixture is two voices: the RTTM names exactly two speakers
          awk '$1=="SPEAKER"{print $8}' /tmp/them.rttm | sort -u | wc -l | grep -qx 2
  macos:
    runs-on: macos-26
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - name: tools
        run: brew install cmake ffmpeg
      - name: build
        working-directory: app
        run: sh scripts/native.sh
        env: { YOGURT_NO_WHISPER: '1' }
      - name: diarize on metal, then cpu
        run: |
          curl -sSfL -o /tmp/diar.gguf https://huggingface.co/nvidia/Nemotron-3-Diarization/resolve/main/Nemotron-3-Diarization.q8_0.gguf
          echo "08456d9e22cd9a323c0364d98375f3746d6e68507ebb705cd46438c534c7a3a1  /tmp/diar.gguf" | shasum -a 256 -c -
          ffmpeg -y -i app/test/fixtures-engine/clip1.wav -i app/test/fixtures-engine/clip2.wav \
            -filter_complex "[0:a][1:a]concat=n=2:v=0:a=1,aformat=sample_rates=16000:channel_layouts=mono" -c:a pcm_s16le /tmp/two-voices.wav
          app/resources/bin/nemo-speech diarize /tmp/two-voices.wav --model /tmp/diar.gguf --format rttm --output /tmp/m.rttm --device metal
          app/resources/bin/nemo-speech diarize /tmp/two-voices.wav --model /tmp/diar.gguf --format rttm --output /tmp/c.rttm --device cpu
          for f in /tmp/m.rttm /tmp/c.rttm; do awk '$1=="SPEAKER"{print $8}' $f | sort -u | wc -l | grep -qx 2; done
```

Fixtures (`app/test/fixtures-engine/clip1.wav`, `clip2.wav`): two different-voice speech clips ≤ 30 s each, permissive license, committed with their SHA-256 recorded in the workflow (the jobs verify with `sha256sum -c`). See Step 1 for where to take them.

- [ ] **Step 3: Verify locally what this machine can run**

Run: `cd app && YOGURT_DIARIZE_BACKEND=cpu resources/bin/nemo-speech doctor 2>/dev/null | head -5 || echo 'nemo-speech not built on this machine'`
Expected: either the doctor output (backends listed) or the honest skip message.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/diarize-engine.yml
git commit -m "ci: real-engine diarization checks (linux cpu, macos metal+cpu)"
```

---

### Task 22: Full verification

- [ ] **Step 1: Unit tests and typecheck**

Run: `cd app && npm run typecheck && npm test`
Expected: all PASS, including `i18n-tables`, `backup`, `setup`, `store`, `diarize*`, `queue`, `catalog`.

Run: `cd packages/picker && npm test && npm run typecheck --if-present`
Expected: PASS.

- [ ] **Step 2: Build and fake e2e**

Run: `cd app && npm run build && npm run e2e`
Expected: the packaged build compiles (`asar` unpack entries present: check `dist/` or run `node scripts/asar-check.mjs` if wired), full e2e suite passes.

- [ ] **Step 3: Real smoke (where hardware allows)**

On a machine with the helper + model:

```bash
cd app && node scripts/native.mjs && YOGURT_DIARIZE_BACKEND=cpu resources/bin/nemo-speech doctor
```
Expected: doctor lists the compiled backends. Performance on real hardware remains a noted verification gap (spec §Verification gaps).

- [ ] **Step 4: Final commit**

```bash
git add -A && git commit -m "chore: local speaker diarization and voice profiles complete" --allow-empty
```

---

## Notes for the implementer

- The plan's orchestrator code (Task 13 Step 5) is the *contract plus scaffolding*: two marked adjustments (store patch method; fake-vector branch) must be applied while transcribing, and the module must compile clean under `npm run typecheck` before its task's tests are considered green.
- Where this plan adapts to the real APIs discovered at implementation time (resample function names, `OpusWriter.finish`, sherpa-onnx stream API, exact CMake option names in NeMo-Speech.cpp, e2e navigation selectors), the *interfaces* in each task's **Interfaces** block and the tests' assertions are fixed; the internals may match the real signatures.
- Spec coverage checklist: them-only (Tasks 1–4, 13), batch ordering (Task 14), call-app-first naming + Speaker N (Task 5), word-stream splitting (Task 4), rename/merge (Tasks 1, 15), profiles opt-in/thresholds/EMA/enrollment (Tasks 6, 13, 16), setup download + lazy speaker model (Tasks 8, 9), decode helpers (Task 7), nemo-speech build (Task 10), embeddings worker (Task 11), backup exclusion (Task 17), no-backfill (Task 1 migrations are additive), fake mode (Tasks 13, 19), e2e (Task 20), real-engine CI (Task 21), privacy/no-leak constraints (Global Constraints + Tasks 13, 17).
- Known verification gaps carried from the spec: Metal correctness is proven only on `macos-26` CI; embedding thresholds (0.72/0.60/0.08) are conservative starting values; the CAM++ license must be confirmed in Task 8 Step 1 before shipping.
