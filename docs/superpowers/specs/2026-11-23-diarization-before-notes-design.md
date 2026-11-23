# Diarization before the end-of-meeting notes

## Goal

A meeting's notes are written only after its diarization has settled, so the notes see the
final speaker names instead of "Andere"/Them lines. If diarization fails or times out, the notes
are written as today.

## Current behaviour and the problem

Today, on `onMeetingStopSaved` (`app/src/main/index.ts:670`):

```
recordingFinished → transcriptFinished → callNames.finished → diarizer.schedule('diarize')
```

and, from `hookNotes`'s `onStop` (`app/src/main/notes/index.ts:228`):

```
transcribed (recording + transcript)
→ named = Promise.all([callNames.finished, diarizer.finished]) capped by NAMES_WAIT_MS (60 s)
→ queueWrite('enhance')
```

Two gaps let the notes run before diarization:

1. `diarizer.finished(id)` is `finals.get(id) ?? Promise.resolve()`
   (`app/src/main/diarize/index.ts:275`). If the notes chain asks before the scheduling hook has
   called `diarizer.schedule(id)`, the wait resolves immediately and the notes job is enqueued
   ahead of the diarization job.
2. The 60 s `NAMES_WAIT_MS` cap releases the notes while a diarization that needs longer is still
   running. The persisted speaker rows only appear when the job finishes, so those notes see the
   pre-diarization names.

Call names (Zoom/Meet/Teams/Webex on macOS and Linux) are not the problem: lines are named live as
they arrive, and the final reconciliation pass runs after transcription. Diarization already waits
for that pass, so notes that wait for diarization also see the reconciled names.

## Design

### 1. One ordering chain per meeting

New module `app/src/main/diarize/afterStop.ts` exporting `createDiarizeSchedule`:

```ts
createDiarizeSchedule({
  recordingFinished, transcriptFinished, namesFinished,
  schedule, finished, namesWaitMs, warn,
})
```

It keeps `Map<meetingId, Promise<void>>`:

- `start(id)` — creates the promise synchronously and stores it before returning:
  `recordingFinished → transcriptFinished → namesFinished` (bounded by `namesWaitMs`; `index.ts`
  passes the exported `NAMES_WAIT_MS`) `→ schedule(id) → finished(id)`. Rejects are logged via `warn`; the promise
  always settles. A second `start` for the same meeting returns the existing promise and never
  schedules twice.
- `wait(id)` — the meeting's promise, or an already-resolved promise when there is none.
- `forget(id)` — drops the entry; called on meeting start so a resumed meeting gets a fresh chain.

The entry stays in the map after it settles, so a notes chain that asks later joins the settled
promise instead of starting a second diarization run. `onMeetingStart` clears it (the same hook
that snapshots `voices_allowed` at `index.ts:668`).

The chain's wait for call names is bounded: a stuck name pass must not hold diarization (and
therefore the notes) forever. It still gets the full 60 s to provide naming evidence.

### 2. Composition in `index.ts`

- Create `diarizeSchedule` after `callNames` and `diarizer` exist.
- Register `onMeetingStart((m) => diarizeSchedule.forget(m.id))`.
- The existing `onMeetingStopSaved` hook becomes `void diarizeSchedule.start(m.id)`. It stays
  registered **before** `hookNotes`, and `start` populates the map synchronously, so the notes
  hook always finds the promise.
- `hookNotes` gets:
  - `named: (id) => callNames.finished(id)` — the capped, names-only wait (unchanged meaning),
  - `diarized: (id) => diarizeSchedule.wait(id)` — new, uncapped.

### 3. Notes hook

`app/src/main/notes/index.ts` gains an optional dependency:

```ts
/** the meeting's diarization has settled (successful or not); notes wait for it with no cap */
diarized?: (id: string) => Promise<void>
```

`afterStop` becomes:

```ts
await p.transcribed(m.id)
if (p.named) await upTo(p.named(m.id), p.namesWaitMs ?? NAMES_WAIT_MS)
if (p.diarized) await p.diarized(m.id)
if (!resuming.has(m.id)) await queueWrite(m.id)
```

The existing 60 s cap remains only for call names. No new status is shown: the note stays
"waiting" while diarization runs.

### 4. Queue priority

`app/src/main/notes/queue.ts` (`pump`, currently `:92-104`) gets one extra selection step after
`chat`:

```ts
let i = waiting.findIndex((e) => e.kind === 'chat' && allowed(e.kind))
// a meeting's voices come before the notes that describe it
if (i === -1) i = waiting.findIndex((e) => e.kind === 'diarize' && allowed(e.kind))
if (i === -1) i = waiting.findIndex((e) => e.kind !== 'readahead' && e.kind !== 'index' && e.kind !== 'folder' && allowed(e.kind))
```

So a notes job that is already queued (manual "Write again", another meeting's retry) cannot
overtake a pending diarization.

## Data flow

```
stop saved
  ├─ diarizeSchedule.start(id) ─ recording → transcript → names(≤60 s) → diarize job ─┐
  └─ notes afterStop ─ transcribed → names(≤60 s) → wait(diarizeSchedule) ────────────┤
                                                                                     ▼
                                                                       queueWrite('enhance')
                                                                   (queue picks diarize first)
```

Both waits start at stop time and overlap; the notes job is enqueued only after the chain settles.

## Error handling and bounds

- The diarize job already catches its own failures and records the reason on the meeting
  (`diarize/index.ts:52-75`); the chain's `catch` only logs. Notes always proceed.
- Existing caps bound the wait: decode 120 s, nemo `max(180 s, 8×audio + 120 s)`, call names 60 s.
- No chain (recover at launch, imported or old meetings): `wait` resolves immediately, unchanged.
- A resumed meeting: `forget` on start, new chain on the next stop.
- Resume already awaits `afterStop` and the diarization job under its own 30 s cap; that cap is
  unchanged. Starting a recording during a long diarization can therefore still fail with
  "Previous recording is still finishing", as today — the notes chain is then written by the
  after-stop path once it settles.

## Testing

- `app/test/diarizeAfterStop.test.ts` (new): one schedule per `start`; a second `start` joins;
  names wait is bounded; a failing `finished` still settles the chain; `wait` after settle does not
  re-schedule; `forget` allows a new run; `wait` without a run resolves.
- `app/test/notes.test.ts`: notes are not enqueued until `diarized` resolves (model prompt not yet
  sent); they are written when it resolves or rejects late; behaviour without `diarized` is
  unchanged (existing tests).
- `app/test/queue.test.ts`: a waiting `diarize` is chosen before an already-waiting `enhance`.
- Full checks: `npx tsc -p .` and the affected suites, then `npx vitest run`.

## Non-goals

- Read-ahead part summaries written during the recording (they cannot wait for a recording that
  has not ended).
- A new note status or label such as "Recognizing speakers…".
- Changing "Write again", people-change rewrites, launch recovery, or resume's 30 s cap.
- Any change to live transcript naming or to diarization itself.
