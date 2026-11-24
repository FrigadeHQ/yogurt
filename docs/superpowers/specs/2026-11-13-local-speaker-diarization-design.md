# Local speaker diarization and cross-meeting voice profiles

**Status:** approved design, ready for an implementation plan
**Date:** 2026-11-13
**App:** Yogurt 0.3.x

## Summary

A meeting records two 16 kHz mono tracks: `me` (the microphone, always the local user) and
`them` (system audio, several remote voices mixed together). Today every remote line is either
named from the call app (Zoom/Teams/Meet) or shown as **Them**. This design adds:

1. **Diarization of the `them` track**, locally, after the meeting, using
   `nvidia/Nemotron-3-Diarization`.
2. **Cluster-level naming** that keeps call-app names when they are trustworthy and otherwise
   falls back to `Speaker 1`, `Speaker 2`, ….
3. **Transcript splitting at speaker changes**, using Whisper word timings.
4. **Inline rename and merge** in the transcript.
5. **Optional cross-meeting voice profiles**, so a recognized voice is named automatically in
   later meetings.

Everything runs on the computer. No audio, transcript, embedding, or voiceprint leaves it.

## Goals

- Tell remote speakers apart in new meetings, on macOS Apple Silicon, Windows x64, and
  Linux x86_64.
- Prefer the names the call app already shows; reconcile them per voice, not per line.
- Let the user fix the result: rename a voice, merge two voices.
- Remember voices across meetings when the user opts in, and auto-name only confident matches.
- Keep every meeting usable if diarization or profiles fail.
- Keep the architecture open to future live/streaming diarization.

## Non-goals (v1)

- Diarizing the `me` track or supporting an in-person/room mode (none exists in the codebase).
- Live/streaming diarization. The batch pipeline is isolated so it can be added later.
- Per-line speaker reassignment. Corrections are rename and merge only.
- Backfilling old meetings. Diarization starts with new meetings.
- Diarizing imported recordings in the other platform's format (`m4a` on Windows/Linux, `ogg` on
  macOS) in v1.
- Speaker-aware notes beyond using the names that are already in the transcript.
- Encrypting the local database at rest.

## Requirements

- Diarization uses `nvidia/Nemotron-3-Diarization` locally; no cloud inference.
- Only the `them` track is diarized.
- Post-meeting batch processing.
- Call-app names win; one duration-weighted name per diarized voice.
- Split transcript lines at speaker changes using word timings.
- Inline rename; merge two voices into one.
- Voice profiles are opt-in, local-only, and deletable individually or all at once.
- Auto-name only high-confidence profile matches; other voices stay `Speaker N`.
- Auto-enroll named remote voices; never enroll unnamed `Speaker N` voices.
- macOS Apple Silicon, Windows x64, and Linux x86_64 in v1.
- The 107 MB diarization GGUF is part of normal setup, pinned by SHA-256.
- Decode existing `m4a`/Ogg recordings; no PCM sidecar during recording.

## Architecture

### Chosen approach: spawned native tools plus a small embedding worker

```
┌─ main process ──────────────────────────────────────────────────────────┐
│ diarize job (queue)                                                     │
│  1. yogurt-audio decode ──► temp 16 kHz mono WAV                        │
│  2. nemo-speech    ──► RTTM                                             │
│  3. parse + align  ──► segments split at speaker changes                │
│  4. reconcile names, write meeting_speakers + segments                  │
│  5. profiles on: embed worker ──► match / auto-name / enroll            │
└─────────────────────────────────────────────────────────────────────────┘
        │ subprocess                     │ utilityProcess (N-API)
        ▼                                ▼
  resources/bin/nemo-speech        sherpa-onnx-node + CAM++ ONNX
  resources/bin/yogurt-audio
```

Why this shape:

- `nemo-speech` and the Whisper server follow the same build/distribution pattern already used
  by the app.
- RTTM is a stable text contract; we do not couple to the CLI's JSON schema.
- `sherpa-onnx-node` gives speaker embeddings without writing another native tool, and its
  prebuilt N-API binaries cover all target platforms.
- The embedding model lives in a utility process so ONNX inference never blocks recording,
  transcription, or the UI.

### Components

1. **`yogurt-audio decode`** — a new subcommand on the existing recorder helper; no new crate.
   - Input: the meeting's `them` file (`m4a` on macOS, `ogg` on Windows/Linux).
   - Output: temp 16 kHz mono `s16le` WAV.
   - macOS: AVFoundation (`AVAssetReader`) decodes HE-AAC natively. This is required: Symphonia's
     AAC decoder has no SBR/PS support, and the Mac recorder writes HE-AAC.
   - Windows/Linux: the Ogg Opus decode already implemented in the helper (`ogg_opus::decode` /
     `oggopus::decode`) feeds the WAV writer.
   - Cross-platform imported recordings are a v1 limitation: an `.m4a` on Windows/Linux or an
     `.ogg` on macOS is skipped with a logged reason rather than a user-facing error.

2. **`nemo-speech`** — built from pinned NeMo-Speech.cpp source into
   `resources/bin/nemo-speech`, like `whisper-server`.
   - Invocation: `nemo-speech diarize <wav> --model <gguf> --format rttm`.
   - Backends: Vulkan on Linux and Windows, Metal on macOS, CPU as the universal fallback.
   - No network access.

3. **Diarization model** — `Nemotron-3-Diarization.q8_0.gguf`
   - 107,012,128 bytes.
   - SHA-256 `08456d9e22cd9a323c0364d98375f3746d6e68507ebb705cd46438c534c7a3a1`.
   - Downloaded through the existing catalog + resumable/checksum `downloader.ts` into the
     models directory as part of normal setup.

4. **Embedding worker** — `app/src/main/diarize/embed-worker.ts`, run as an Electron
   `utilityProcess`.
   - Loads `sherpa-onnx-node`'s `SpeakerEmbeddingExtractor`.
   - Reads the same 16 kHz WAV, embeds each sufficiently long range, L2-normalizes, averages,
     and renormalizes to one vector per voice.
   - CPU provider, 2 threads, lazy start, unloads after a few idle minutes.

5. **Diarization orchestrator** — `app/src/main/diarize/`.
   - Owns temp files, subprocess calls, RTTM parsing, alignment, naming, profile match/enroll,
     persistence, and cleanup.

## Model artifacts and runtime

| Artifact | Size | SHA-256 | When | Where |
|---|---|---|---|---|
| `Nemotron-3-Diarization.q8_0.gguf` | 107,012,128 B | `08456d9e22cd9a323c0364d98375f3746d6e68507ebb705cd46438c534c7a3a1` | normal setup | `models/diarization/` |
| `3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx` | 28,281,164 B | `aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2` | first opt-in to voice profiles | `models/speaker/` |

- CAM++ was chosen over TitaNet-small: smaller (28 MB vs 40 MB) and trained on Chinese + English,
  which suits Yogurt's multi-language mode.
- Nemotron-3-Diarization is published under OpenMDW-1.1; the catalog entry and notices must reflect
  that. The CAM++ model's license must be confirmed and recorded before shipping.
- Both downloads are checksum-verified. The diarization model is required; the speaker model is
  fetched lazily only for users who enable profiles.
- Embeddings run through `sherpa-onnx-node` 2.0.1, whose prebuilt N-API binaries cover win/linux/
  darwin on x64 and arm64.

## Data model

### `segments`

```sql
ALTER TABLE segments ADD COLUMN speaker_key TEXT;   -- 'v1', 'v2', … NULL for me / undiarized
ALTER TABLE segments ADD COLUMN words TEXT;         -- JSON [{ text, startMs, endMs }], them lines only
```

- `speaker` remains the display and grouping field, as today.
- `speaker_key` is the stable per-meeting voice identity for rename and merge.
- `words` is persisted on `them` lines from now on so the transcript can be split and re-split
  without re-transcribing. Roughly 200–400 KB per hour of meeting.

### `meeting_speakers`

```sql
CREATE TABLE meeting_speakers (
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  profile_id TEXT REFERENCES voice_profiles(id) ON DELETE SET NULL,
  score      REAL,
  start_ms   INTEGER NOT NULL,
  end_ms     INTEGER NOT NULL,
  PRIMARY KEY (meeting_id, key)
);
```

Holds cluster metadata only. The display name lives in `segments.speaker`, so there is no second
copy to drift.

### `meetings`

```sql
ALTER TABLE meetings ADD COLUMN diarized_at INTEGER;
ALTER TABLE meetings ADD COLUMN diarize_error TEXT;
ALTER TABLE meetings ADD COLUMN voices_allowed INTEGER NOT NULL DEFAULT 0;
```

`voices_allowed` is snapshotted at recording start so that enabling profiles mid-call does not
capture the call already in progress.

### `voice_profiles`

```sql
CREATE TABLE voice_profiles (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  model      TEXT NOT NULL,
  dims       INTEGER NOT NULL,
  centroid   BLOB NOT NULL,        -- float32, L2-normalised
  meetings   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

One centroid per profile, updated with an exponential moving average
(`0.7·old + 0.3·new`, renormalised).

## Pipeline

### Trigger and ordering

```
recordingFinished → transcriptFinished → callNames.finished → diarize → notes
```

- Diarization runs **after** call-name finalization so the per-line call names are already
  correct and can be used as naming evidence.
- Running it later also avoids invalidating callNames' segment ids when rows are split.
- The notes hook's existing `named` dependency becomes
  `Promise.all([callNames.finished(id), diarize.finished(id)])`, capped by `NAMES_WAIT_MS`, so
  notes see final speaker names. If diarization fails or times out, notes proceed as today.
- `diarize.finished(id)` always resolves. A failure is recorded on the meeting instead of rejecting
  the notes chain.
- Resume waits for diarization under its existing 30 s cap (notes use `NAMES_WAIT_MS`, 60 s).
  A resumed meeting is diarized only for its appended lines, so existing turns, cluster keys, and
  manual names survive.

### Step 1: decode

- Find the `them` file with the existing `trackFile()` and extension order.
- Spawn the platform helper: `yogurt-audio decode --in <file> --out <temp>/them.wav`.
  - macOS: AVFoundation, 16 kHz mono PCM.
  - Windows/Linux: Ogg Opus, 16 kHz mono PCM.
- The decoded WAV timeline matches meeting time: recording parts are joined on meeting time, and
  the recorder's `startMs` already follows that timeline.
- Delete the WAV in `finally`.

### Step 2: diarize

- Spawn `nemo-speech diarize <wav> --model <gguf> --format rttm`.
- Backend selection:
  - Linux/Windows: Vulkan.
  - macOS: Metal.
  - Runtime probe; if the accelerator fails to initialize, retry once with CPU.
  - `YOGURT_DIARIZE_BACKEND=cpu|vulkan|metal` overrides for tests and troubleshooting.
- A generous wall-clock cap derived from audio length; a stuck child is killed.
- Output: RTTM on stdout.

### Step 3: parse and align

RTTM lines are `SPEAKER <file> 1 <start> <duration> <NA> <NA> <speaker> <NA> <NA>`.

Cleanup:
- Drop turns shorter than 200 ms.
- Merge same-speaker turns separated by less than 300 ms.
- Keep overlaps; the dominant turn wins.

Alignment works on the **whole ordered word stream** of the `them` rows being diarized, not per
Whisper line. On a first run that is every `them` row; after a resume it is only the appended rows
(`speaker_key IS NULL`), so existing turns and manual names are never rewritten.

1. Read the selected `them` segments in `start_ms` order and concatenate their `words`, remembering
   each word's source line and its call-app name.
2. For each word, pick the turn with the greatest overlap with `[word.start, word.end]`
   (ties go to the earlier turn).
3. No overlap → nearest turn within 2 s; none → no speaker, stays **Them** (`speaker_key` NULL). A whole
   sentence (one whisper utterance) no turn even overlaps goes to the turn that starts within 3 s after
   it: the diarizer missed the utterance, not just its edges, and the voice that speaks next is the
   best guess available.
4. Group consecutive words with the same cluster into runs.
5. Each run becomes one `segments` row:
   - `start_ms` = first word start; `end_ms` = last word end
   - `text` = words joined with the existing `joinWords()` rules (spacing/punctuation), then
     passed through the same `spell()` normalization as today's lines
   - `speaker_key` = cluster
   - `speaker` = the run's evidence name: the duration-weighted majority of its source lines'
     call-app names, or NULL (Step 4 uses this as evidence, then replaces it with the final name)
   - `words` = the run's words
6. `me` rows and already-diarized `them` rows are untouched.
7. Steps 3–4 are computed entirely in memory and persisted in **one transaction**: delete the
   selected old rows, insert the split rows, write `meeting_speakers`, and set the final names.
   FTS triggers maintain the search index. A crash cannot leave half-split rows behind.

When a resumed meeting reuses an existing voice key (a new turn overlapping an old cluster by more
than half its duration), its rows join that cluster and keep the name already shown.

Why the word stream: Whisper's line boundaries are arbitrary and often straddle a speaker change.
Word-level splitting gives clean turns and removes a class of line-boundary edge cases.

Fallbacks:
- Lines with no `words` (old meetings, or Whisper omitted them): assign the whole line by maximum
  turn overlap. Coarser, but still diarized.
- Overlapping diarization turns: dominant turn wins; no overlap labels in v1.
- A resumed meeting is never re-split as a whole; only its new rows are diarized.

### Step 4: naming reconciliation

Input: the new clusters from this run and their rows, carrying the per-run evidence names from
Step 3. Clusters that reused an existing key keep the name already shown and are not renamed.

For each new cluster:
- `total` = summed duration of its rows.
- `claims` = per-name summed duration, ignoring NULL/Them.
- Best name wins if `claim ≥ 2 s` and `claim / total ≥ 0.5` (the spirit of callNames' `MOST`
  rule and `HOLD_MS` evidence).

Global de-duplication:
- If two clusters claim the same person, the name goes to the cluster with the strongest claim;
  the other drops to `Speaker N`.
- This keeps one person = one voice within a meeting even when the call app's talk indicator was
  noisy.

Unnamed clusters become `Speaker 1`, `Speaker 2`, … in first-appearance order. Named clusters do
not consume numbers. On a resumed meeting, numbering continues after the highest `Speaker N`
already in the meeting, so a new voice never collides with an existing label.

Numbers are stable, not compacted:
- If `Speaker 2` is later auto-named or merged away, `Speaker 3` is not renumbered.
- Renumbering would change colors and make notes references confusing; a gap is the lesser evil.

Write `meeting_speakers` rows for new clusters (`start_ms`, `end_ms`, `profile_id` NULL until
Step 5) and set every row in a cluster to the resolved name, in the same transaction as the split.
A reused key extends its existing `start_ms`/`end_ms` but keeps its name.

### Step 5: profiles (only if `voices_allowed = 1`)

- Compute one embedding per **new** cluster from clean speech ranges (≥ 0.8 s each, ≥ 2 s total).
  Existing clusters keep their names across a resume.
- Match against every profile centroid with cosine similarity.

```
AUTO_NAME_MIN   = 0.72   // auto-apply a profile name
AMBIGUOUS_MIN   = 0.60   // below this: no match at all
BEST_MARGIN     = 0.08   // best must beat second-best by this much
```

- `score ≥ 0.72` and margin `≥ 0.08` → auto-name.
- `0.60–0.72`, or two profiles too close → leave `Speaker N`.
- Below `0.60` → no match.

Precedence: call-app name → profile name → `Speaker N`. Profile naming only fills clusters that
are still `Speaker N`.

If two clusters match the same profile, only the strongest gets the name; others stay
`Speaker N`. No auto-merge in v1.

Enrollment:
- Only named, remote voices with ≥ 2 s of clean speech.
- No high-confidence match → create a profile with the display name.
- Matched profile and the names agree → update the centroid and meeting count.
- Matched profile but the names disagree → skip (do not contaminate the voiceprint).
- Name already taken by a different profile → skip auto-enrollment; the user resolves it in
  Settings.
- `Speaker N` voices are never enrolled.
- Manual transcript rename/merge enrolls the named voice from that meeting's own recording, under the
  same rules; it never relabels other meetings and never renames an existing profile.

### Step 6: persist and notify

After Steps 4–5, in one transaction where possible:

- broadcast `transcript:speakers` and `meetings:changed`
- call `notes.refresh(id)` so an open note re-renders
- set `meetings.diarized_at`; clear `diarize_error` on success or record it on failure

## Naming, rename, and merge UI

### Store operations (one transaction each)

**Rename**
```ts
renameSpeaker(meetingId, key, name):
  old = name currently on this key's segments
  UPDATE segments SET speaker = ? WHERE meeting_id = ? AND speaker_key = ?
  // speaker_order: replace old at its exact index
```
- FTS updates fire through the existing `segments_au` trigger.
- Renaming to another live speaker's name routes to the merge flow rather than creating two
  clusters with one name.

**Merge**
```ts
mergeSpeakers(meetingId, fromKey, intoKey):
  UPDATE segments SET speaker_key = intoKey, speaker = targetName
    WHERE meeting_id = ? AND speaker_key = fromKey
  DELETE FROM meeting_speakers WHERE key = fromKey
  meeting_speakers[into]: start = min, end = max,
    profile_id = target.profile_id ?? from.profile_id
```
- The source name is left in `speaker_order` as an unused slot. Colors are `indexOf(name)`-based;
  keeping the slot preserves every other speaker's color.
- `me` and `Them` are not merge candidates.

Both operations broadcast `transcript:speakers` and `meetings:changed`, and call `notes.refresh(id)`.
`notes.applyPeople` is not enough here: it rewrites notes only when the attendee set changed, and
speaker names are not attendees.

### Transcript UI

In `Transcript.tsx`, the `<span data-testid="transcript-who">` becomes a button for `them` turns:

- **Click** → in-place text input. Enter commits, Escape cancels, blur commits. Empty cancels.
  Whitespace is collapsed and the name capped at 80 characters.
- **Chevron** (hover/focus) opens a menu:
  - *Rename* (focuses the input)
  - *Merge into…* → lists the meeting's other voices as `Merge into Alice`
- Merge asks for one inline confirmation; there is no undo in v1.
- All strings go through `t()`; controls are keyboard reachable (`button`, `role="menu"`, Escape
  returns focus).
- The widget transcript stays read-only.

### Colors

No change to `speakerColors.ts`. Rename replaces in place and merge keeps the source slot, so
`order.indexOf(name)` stays stable for unaffected speakers. New clusters append in first-appearance
order.

### Notes

Rename/merge and diarization refresh the notes view but do **not** automatically rewrite generated
notes: their prose is not name-keyed, and a rewrite costs a model call. The existing **Write again**
action regenerates them on request. User-edited notes are left alone, as today. If real use shows
speaker names matter in notes, a “names changed” hint can be added later.

## Voice profiles: settings and lifecycle

- Speaker separation itself has its own master switch, `speakerDiarization?: boolean` in
  `settings.json`, **off by default**: off, a meeting never diarizes, the notes never wait for one,
  neither the diarization model nor the speaker model downloads, and transcripts render plain
  **Them** heads — the pre-diarization behaviour. Meetings already diarized keep their labels.
  Voice profiles only apply while it is on (the Settings switch for them waits, dimmed, until it is).
- `speakerLabels?: boolean` in `settings.json`, **off by default**: on, a diarized meeting whose
  transcript still has voices called `Speaker N`, voices without a name, or lines nobody claimed
  holds its summary until everything is labeled — however long that takes. Renaming, merging and
  assigning re-check; a **Summarize now** button on the note releases the meeting for good
  (`meetings.labels_released`), and the wait also survives an app restart (the recovery re-arms it
  instead of summarizing silently). Meetings that never diarized, or whose diarization failed,
  summarize at once. While it is on, the tray icon shows a red exclamation mark on the Yogurt logo
  for a stopped, diarized, unreleased meeting **with no summary written yet** that is less than a
  day old — the same rule the banner follows, so the icon never nags about a meeting the app is
  not actually waiting for. The recording dot stays on top while recording; the tooltip names the
  wait and the menu lists it.
- New setting `speakerProfiles?: boolean` in `settings.json`, **off by default**.
- First enable shows a consent panel explaining that a voiceprint is biometric data, stays on this
  computer, and can be deleted at any time.
- At recording start, snapshot the setting into `meetings.voices_allowed`.
- Turning it off stops matching and enrollment immediately. Existing profiles remain on disk,
  listed but unused.
- Settings section **Voice recognition**:
  - toggle **Remember voices across meetings**
  - per-profile row: name, meeting count, last used, delete
  - **Delete all voice profiles** with confirmation
  - empty state and an “off but kept” note
- New IPC: `settings:set-speaker-profiles`, `voices:list`, `voices:delete`, `voices:delete-all`.
  Only names and counts cross IPC, never vectors.
- Deleting a profile sets `meeting_speakers.profile_id` to NULL but never rewrites transcript
  names.

## Privacy

- All processing is local. The only network calls remain model downloads, verified by SHA-256.
- No embeddings, audio, or similarity scores in logs; counts and backend names only.
- Temp WAV deleted after the job; a launch sweep removes leftovers from a crash.
- Voice profiles are excluded from backup exports:
  - in the export snapshot, with foreign keys off, `meeting_speakers.profile_id` is set to NULL,
    `voice_profiles` is dropped, and the snapshot is vacuumed before packing
  - import never touches voice tables
- New code paths avoid attaching audio or embedding data to crash reports.
- No at-rest encryption in v1; OS disk encryption is the protection. `safeStorage` is future work.

## Errors and fallbacks

| Stage | On failure |
|---|---|
| Decode | log, `diarize_error`, transcript stays single **Them** |
| `nemo-speech` missing/crash/timeout | same; one warning per meeting |
| Accelerator init | retry once with CPU; log which backend won |
| RTTM parse | skip malformed lines; zero valid turns = no-op |
| Alignment | no words → line-level max overlap; no turns → leave transcript |
| Embedding worker crash | restart once, then skip profiles for the session |
| Profile match/enroll | skip; diarization names remain |

- Jobs run through the existing queue, one meeting at a time.
- No new error dialogs.
- `meetings.diarize_error` records the reason for diagnostics.

## Migrations

Idempotent, following the existing `PRAGMA table_info` pattern:

- `segments.speaker_key`, `segments.words`
- `meetings.diarized_at`, `meetings.diarize_error`, `meetings.voices_allowed`
- `CREATE TABLE IF NOT EXISTS voice_profiles (...)` (before `meeting_speakers`, which references it)
- `CREATE TABLE IF NOT EXISTS meeting_speakers (...)`

Old meetings have NULL `speaker_key`/`words`/`diarized_at` and `voices_allowed = 0`; they render
exactly as today and are never backfilled. `speaker_order` is untouched. Older builds ignore the
new tables; newer builds import older backups unchanged. The removed legacy `speakers` table is not
reintroduced.

## Build and packaging

- Windows/Linux: add the `decode` subcommand to the existing `yogurt-audio` crate, reusing its Ogg
  Opus decoder; add `app/scripts/nemo-build.mjs` modeled on `whisper-build.mjs` for a pinned
  NeMo-Speech.cpp commit.
- macOS: add the `decode` subcommand to the Swift `yogurt-audio` helper using AVFoundation; add the
  `nemo-speech` CMake build to `app/scripts/native.sh` and to the macOS release path in
  `.github/workflows/release.yml`. No Rust is added to the Mac build.
- Vulkan SDK for Windows/Linux CI mirrors the existing `native-whisper.yml` setup.
- `sherpa-onnx-node` is a runtime dependency; `.node` binaries and onnxruntime libraries must be
  `asarUnpack`ed. The embedding worker gets its own `electron.vite.config.ts` main-process entry so
  `utilityProcess.fork` has a built file to load.
- Models are downloaded at runtime, not bundled.

## Fake mode

- Fake diarizer produces a deterministic RTTM from the fake transcript (two voices by default;
  `YOGURT_FAKE_VOICES` varies it), bypassing `nemo-speech`.
- Fake embedding worker returns deterministic unit vectors hashed from a voice key;
  `YOGURT_FAKE_VOICE_SIM` controls match/no-match/ambiguous cases.
- Fake decode writes a valid 16 kHz WAV so the rest of the pipeline runs unchanged.
- `fakeDownloadDeps` covers the new model files.

## Testing

**Unit (vitest)**
- RTTM parsing, turn cleanup, word-stream splitting, fallback without `words`.
- Cluster naming: thresholds, majority, duplicate resolution, `Speaker N` numbering.
- Rename/merge store operations: rows, `speaker_order` indices, `meeting_speakers`, profile
  transfer.
- Matcher: auto-name, margin, floor, two clusters matching one profile.
- EMA update, short-speech guard, enrollment collision/conflict rules.
- Backup export excludes voice tables; import leaves them untouched.
- Migration from a pre-diarization database.

**End-to-end (fake mode)**
- A recorded meeting splits into two speakers with distinct colors.
- Inline rename updates every turn; merge combines them and keeps other colors.
- Two speakers, two profiles; the next meeting auto-names high-confidence matches and leaves
  low-confidence voices as `Speaker N`.
- Opt-out meeting creates no profiles; delete and delete-all work.
- Diarization failure leaves the transcript usable.

**Real engine (CI)**
- `yogurt-audio decode` native tests: output is 16 kHz mono PCM with the expected duration
  (AVFoundation on macOS, Ogg Opus on Linux; Windows helper is covered by its existing crate tests).
- Linux: build `nemo-speech`, run a fixed fixture WAV, assert RTTM shape and speaker count; assert
  CPU fallback works without Vulkan. The existing `yogurt-audio` helper provides decode.
- macOS (`macos-26`): same with Metal, plus a `--backend cpu` comparison.
- Fixture: a short permissively licensed two-voice clip fetched by pinned hash, not bundled.

**Verification gaps**
- Metal correctness comes from macOS CI only; real-hardware performance is unverified until a Mac
  smoke run. Metal cannot be executed on Linux, and no Metal implementation exists there.
- Decoded WAV time and Whisper word time are assumed to share meeting time. Codec priming/delay
  could introduce a small offset; the real fixture should check alignment drift over a long file.
- Embedding thresholds are conservative starting values to be tuned against real recordings.
- The speaker-model license must be confirmed when pinning it in the catalog.

## Decisions log

| Decision | Choice |
|---|---|
| Scope | `them` track only |
| Timing | post-meeting batch, streaming-ready boundaries |
| Naming | call-app names first, one duration-weighted name per cluster, else `Speaker N` |
| Alignment | word-stream splitting using Whisper word timings |
| Corrections | rename + merge; no per-line reassignment |
| Profiles | included in v1, opt-in, local, deletable |
| Enrollment | named remote voices only, ≥ 2 s clean speech |
| Precedence | call app → high-confidence profile → `Speaker N` |
| Architecture | spawned native tools + utility-process embeddings |
| Decode | existing `yogurt-audio` helper: AVFoundation on macOS (HE-AAC), Ogg Opus on Windows/Linux |
| Imported recordings | other-platform formats not diarized in v1 |
| Backends | Vulkan on Linux/Windows, Metal on macOS, automatic CPU fallback |
| Diarization model | `Nemotron-3-Diarization.q8_0.gguf`, normal setup |
| Speaker model | CAM++, lazy download on first opt-in |
| Old meetings | no backfill |
| Numbers | stable, may have gaps |
| Merge colors | source name kept as an unused slot in `speaker_order` |
| Backups | voice profiles excluded |
| Notes | view refreshed; no automatic rewrite |

## Out of scope / future work

- Live/streaming diarization.
- Per-line speaker reassignment.
- Auto-merging clusters that match the same profile.
- “Possible match: Alice” suggestions for ambiguous scores.
- Encrypting voiceprints at rest.
- Backfilling old meetings.
