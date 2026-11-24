# Diarization Before the End-of-Meeting Notes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A meeting's notes are written only after its diarization has settled, so the notes see the final speaker names; a failed or timed-out diarization still lets the notes be written.

**Architecture:** A new `createDiarizeSchedule` helper owns one promise per meeting: recording → transcript → call names (bounded at 60 s) → diarize job. It is started synchronously in the stop-saved hook (which runs before `hookNotes`), and the notes hook awaits that promise uncapped through a new `diarized` dependency. The model queue additionally picks a waiting `diarize` entry before `enhance`/`names`, so no notes job can overtake a pending diarization.

**Tech Stack:** TypeScript, Electron main process, vitest. No new dependencies.

## Global Constraints

- All commands run from `app/` in the worktree `/home/jck/.local/share/opencode/worktree/79a9dc/diarization`.
- The notes' wait for diarization has **no cap**. `NAMES_WAIT_MS` (60 s) applies only to call names, both in the notes hook and inside the diarization chain.
- A failed, timed-out or never-scheduled diarization must never stop the notes; the chain's promise always settles.
- Diarization runs after call names (naming evidence) and after the transcript is final.
- The queue order is unchanged except that `diarize` now goes ahead of `enhance`/`names` (after `chat`, before the existing catch-all).
- No UI/status change, no change to read-ahead part summaries, "Write again", people rewrites, launch recovery, or resume's 30 s cap.
- Follow existing style: one-line guards, `const` arrow helpers, English comments, `data-testid` not relevant here.
- No new dependencies.

---

### Task 1: The diarization ordering chain

**Files:**
- Create: `app/src/main/diarize/afterStop.ts`
- Test: `app/test/diarizeAfterStop.test.ts` (new)

**Interfaces:**
- Consumes: nothing from earlier tasks (pure module).
- Produces: `createDiarizeSchedule(p)` returning `{ start(id): Promise<void>; wait(id): Promise<void>; forget(id): void }`. Task 4 passes `index.ts`'s `recordingFinished`, `transcriptFinished`, `callNames.finished`, `diarizer.schedule`, `diarizer.finished`, `NAMES_WAIT_MS`.

- [ ] **Step 1: Write the failing test**

Create `app/test/diarizeAfterStop.test.ts`:

```ts
import { expect, it, vi } from 'vitest'
import { createDiarizeSchedule } from '../src/main/diarize/afterStop'

const tick = () => new Promise((r) => setTimeout(r, 0))
const deferred = () => {
  let resolve!: () => void, reject!: (e: unknown) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function setup(o: { names?: Promise<void>; finished?: Promise<void>; namesWaitMs?: number } = {}) {
  const order: string[] = []
  const schedule = vi.fn(() => { order.push('schedule') })
  const s = createDiarizeSchedule({
    recordingFinished: async () => { order.push('recording') },
    transcriptFinished: async () => { order.push('transcript') },
    namesFinished: () => { order.push('names'); return o.names ?? Promise.resolve() },
    schedule,
    finished: () => { order.push('finished'); return o.finished ?? Promise.resolve() },
    namesWaitMs: o.namesWaitMs ?? 50,
    warn: () => { order.push('warn') },
  })
  return { s, order, schedule }
}

it('runs recording, transcript, names, schedule and job in order, once per start', async () => {
  const { s, order, schedule } = setup()
  await s.start('m1')
  expect(order).toEqual(['recording', 'transcript', 'names', 'schedule', 'finished'])
  await s.start('m1')
  expect(schedule).toHaveBeenCalledOnce()
})

it('does not schedule before the call names arrive', async () => {
  const names = deferred()
  const { s, schedule } = setup({ names: names.promise })
  const run = s.start('m1')
  await tick()
  expect(schedule).not.toHaveBeenCalled()
  names.resolve()
  await run
  expect(schedule).toHaveBeenCalledOnce()
})

it('goes on when the call names fail', async () => {
  const { s, schedule } = setup({ names: Promise.reject(new Error('no permission')) })
  await s.start('m1')
  expect(schedule).toHaveBeenCalledOnce()
})

it('starts anyway when the call names never come', async () => {
  const { s, order } = setup({ names: new Promise(() => {}), namesWaitMs: 20 })
  await s.start('m1')
  expect(order).toEqual(['recording', 'transcript', 'names', 'schedule', 'finished'])
})

it('settles and warns when the job fails, so the notes can go on', async () => {
  const failed = deferred()
  const { s, order } = setup({ finished: failed.promise })
  const run = s.start('m1')
  await tick()
  failed.reject(new Error('nemo failed'))
  await expect(run).resolves.toBeUndefined()
  expect(order.at(-1)).toBe('warn')
})

it('a late wait joins the settled run instead of starting another', async () => {
  const { s, schedule } = setup()
  await s.start('m1')
  await s.wait('m1')
  expect(schedule).toHaveBeenCalledOnce()
})

it('waiting for a meeting that never started resolves', async () => {
  const { s } = setup()
  await expect(s.wait('m2')).resolves.toBeUndefined()
})

it('after forget the meeting can be scheduled again', async () => {
  const { s, schedule } = setup()
  await s.start('m1')
  s.forget('m1')
  await s.start('m1')
  expect(schedule).toHaveBeenCalledTimes(2)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd app && npx vitest run test/diarizeAfterStop.test.ts`
Expected: FAIL — cannot resolve `../src/main/diarize/afterStop`.

- [ ] **Step 3: Implement the module**

Create `app/src/main/diarize/afterStop.ts`:

```ts
/**
 * One diarization run per meeting after it stops: the recording, transcript and (briefly) the call's names settle
 * first, then the job is queued, and this promise settles with it. A failure is only warned about: the notes of the
 * meeting wait on this promise and must always be able to go on.
 */
export type DiarizeSchedule = ReturnType<typeof createDiarizeSchedule>

export function createDiarizeSchedule(p: {
  recordingFinished: (id: string) => Promise<void>
  transcriptFinished: (id: string) => Promise<void>
  /** the names from the call: naming evidence for diarization, waited for but never longer than namesWaitMs */
  namesFinished: (id: string) => Promise<void>
  schedule: (id: string) => void
  finished: (id: string) => Promise<void>
  namesWaitMs: number
  warn?: (message: string, error: unknown) => void
}) {
  const runs = new Map<string, Promise<void>>()
  /** wait for something, but never longer than this */
  const upTo = async (wait: Promise<void>, ms: number) => {
    let timer: NodeJS.Timeout | undefined
    await Promise.race([wait.catch(() => {}), new Promise<void>((r) => { timer = setTimeout(r, ms) })])
    clearTimeout(timer)
  }
  return {
    /** the run for this meeting; a second start joins the first and never schedules twice */
    start(id: string): Promise<void> {
      const had = runs.get(id)
      if (had) return had
      const done = (async () => {
        await p.recordingFinished(id)
        await p.transcriptFinished(id)
        await upTo(p.namesFinished(id), p.namesWaitMs)
        p.schedule(id)
        await p.finished(id)
      })().catch((e) => (p.warn ?? console.warn)('diarization after the meeting failed', e))
      runs.set(id, done)
      return done
    },
    /** the run for this meeting, or nothing to wait for (an imported meeting, or one never scheduled) */
    wait: (id: string): Promise<void> => runs.get(id) ?? Promise.resolve(),
    /** the meeting records again: its next stop starts a fresh run */
    forget: (id: string) => { runs.delete(id) },
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd app && npx vitest run test/diarizeAfterStop.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/diarize/afterStop.ts app/test/diarizeAfterStop.test.ts
git commit -m "feat(diarize): one ordering chain per stopped meeting"
```

---

### Task 2: The notes hook waits for diarization

**Files:**
- Modify: `app/src/main/notes/index.ts` (the `hookNotes` dependency type near `:31` and `afterStop` near `:228-237`)
- Test: `app/test/notes.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1; the new dependency is injected by Task 4.
- Produces: `hookNotes` accepts `diarized?: (id: string) => Promise<void>`, awaited after the capped `named` wait and before `queueWrite`.

- [ ] **Step 1: Write the failing test**

In `app/test/notes.test.ts`, extend the `setup` options type and the `hookNotes` call:

```ts
function setup(o: { me?: string; named?: () => Promise<void>; diarized?: () => Promise<void>; namesWaitMs?: number; reply?: string | ((prompt: string) => string); during?: () => void; load?: Promise<void>; title?: string; recording?: () => boolean; smallMac?: boolean; showLoading?: boolean } = {}) {
```

and in the `hookNotes({ ... })` call add `diarized: o.diarized,` directly after `named: o.named,`:

```ts
    transcribed: () => transcript, named: o.named, diarized: o.diarized, namesWaitMs: o.namesWaitMs, language: () => 'spanish',
```

Then add these two tests next to the existing "waits for the names from the call before it writes" test:

```ts
  it('waits for diarization before it writes, with no cap', async () => {
    let diarized!: () => void
    const s = setup({ diarized: () => new Promise<void>((r) => { diarized = r }) })
    s.stop(); s.transcribed(); await wait(40)
    expect(s.prompts).toEqual([])
    // diarization names the line before the notes are asked for
    s.store.setSegmentSpeakers([{ id: s.store.segments(s.m.id)[0].id, speaker: 'Ann Lee' }])
    diarized(); await s.notes.written(s.m.id)
    expect(s.prompts[0]).toContain('Ann Lee: We ship Tuesday.')
  })

  it('a failed diarization still lets the notes be written', async () => {
    const s = setup({ diarized: () => Promise.reject(new Error('nemo failed')) })
    s.stop(); s.transcribed()
    await s.notes.written(s.m.id)
    expect(s.store.notes(s.m.id).enhanced).not.toBeNull()
  })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd app && npx vitest run test/notes.test.ts`
Expected: FAIL — the first new test times out waiting for `written` (notes run before `diarized` resolves) and the second may pass by accident; the first failure is the signal.

- [ ] **Step 3: Implement**

In `app/src/main/notes/index.ts`, add the dependency after `named?`:

```ts
  /** the names from the call are on its lines (callNames) */
  named?: (id: string) => Promise<void>
  /** the meeting's diarization has settled (successful or not); the notes wait for it with no cap */
  diarized?: (id: string) => Promise<void>
```

In `afterStop` (currently `:228-237`), add the uncapped wait after the capped names wait and before `queueWrite`:

```ts
  p.onStop((m) => {
    set(m.id, 'waiting')
    const done = (async () => {
      await p.transcribed(m.id)
      // the names from the call are quick; a stuck pass never holds the notes back for long
      if (p.named) await upTo(p.named(m.id), p.namesWaitMs ?? NAMES_WAIT_MS)
      // the notes describe the voices, so a diarization still running is waited for however long it takes;
      // a broken one settles its promise too and must not keep the notes away
      if (p.diarized) await p.diarized(m.id).catch(() => {})
      if (!resuming.has(m.id)) await queueWrite(m.id)
    })().catch((e) => console.error('notes after the meeting failed', e)).finally(() => afterStop.delete(m.id))
    afterStop.set(m.id, done)
  })
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd app && npx vitest run test/notes.test.ts`
Expected: PASS (all existing tests still pass; the two new ones pass).

- [ ] **Step 5: Commit**

```bash
git add app/src/main/notes/index.ts app/test/notes.test.ts
git commit -m "feat(notes): wait for the meeting's diarization before writing"
```

---

### Task 3: Queue gives diarization the place ahead of notes

**Files:**
- Modify: `app/src/main/notes/queue.ts` (`pump`, currently `:92-104`)
- Test: `app/test/queue.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the selection order `chat` → `diarize` → other immediate jobs (FIFO) → `readahead` → `index`/`folder`.

- [ ] **Step 1: Write the failing test**

Add at the end of the `describe('notes queue', ...)` block in `app/test/queue.test.ts`:

```ts
  it('a waiting diarization goes before an already-waiting notes job', async () => {
    const q = createQueue({ recording: () => false, smallMac: false })
    const log: string[] = []
    let release!: () => void
    const blocker = q.enqueue(() => new Promise<void>((r) => { release = r }), 'enhance')
    const notes = q.enqueue(async () => { log.push('notes') }, 'enhance')
    const voices = q.enqueue(async () => { log.push('diarize') }, 'diarize')
    release()
    await Promise.all([blocker, notes, voices])
    expect(log).toEqual(['diarize', 'notes'])
  })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd app && npx vitest run test/queue.test.ts`
Expected: FAIL — `log` is `['notes', 'diarize']` (the earlier-queued notes runs first).

- [ ] **Step 3: Implement**

In `app/src/main/notes/queue.ts`, replace the selection block in `pump` (currently):

```ts
    // a question first (someone is waiting on it), reading ahead only once nothing else can run
    let i = waiting.findIndex((e) => e.kind === 'chat' && allowed(e.kind))
    if (i === -1) i = waiting.findIndex((e) => e.kind !== 'readahead' && e.kind !== 'index' && e.kind !== 'folder' && allowed(e.kind))
```

with:

```ts
    // a question first (someone is waiting on it), then a meeting's voices before the notes that describe them,
    // reading ahead only once nothing else can run
    let i = waiting.findIndex((e) => e.kind === 'chat' && allowed(e.kind))
    if (i === -1) i = waiting.findIndex((e) => e.kind === 'diarize' && allowed(e.kind))
    if (i === -1) i = waiting.findIndex((e) => e.kind !== 'readahead' && e.kind !== 'index' && e.kind !== 'folder' && allowed(e.kind))
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd app && npx vitest run test/queue.test.ts`
Expected: PASS (all tests, including the existing order expectations around `names`/`enhance`).

- [ ] **Step 5: Commit**

```bash
git add app/src/main/notes/queue.ts app/test/queue.test.ts
git commit -m "feat(queue): run a meeting's diarization before its notes"
```

---

### Task 4: Wire the chain into the app

**Files:**
- Modify: `app/src/main/index.ts` (imports at `:63` and `:66`; the block currently at `:667-681`)

**Interfaces:**
- Consumes: `createDiarizeSchedule` (Task 1) and `hookNotes`'s `diarized` dependency (Task 2).
- Produces: the running app starts one chain per stop and passes `diarizeSchedule.wait(id)` to the notes hook.

- [ ] **Step 1: Add the imports**

```ts
import { hookNotes, NAMES_WAIT_MS } from './notes'
import { createDiarizeSchedule } from './diarize/afterStop'
```

- [ ] **Step 2: Create the chain and replace the stop hook**

Replace this block (after `createDiarizer({...})`, currently `:667-675`):

```ts
  // voice recognition opt-in is snapshotted per meeting: enabling it mid-call never captures the call in progress
  onMeetingStart((m) => { try { store.setVoicesAllowed(m.id, speakerProfiles()) } catch (e) { console.warn('voices_allowed snapshot failed', e) } })
  // diarize once the recording, transcript and call names have settled; its queue entry lands ahead of the notes job
  onMeetingStopSaved((m) => {
    void (async () => {
      await recordingFinished(m.id); await transcriptFinished(m.id); await callNames.finished(m.id)
      diarizer.schedule(m.id)
    })().catch((e) => console.warn('diarize scheduling failed', e))
  })
```

with:

```ts
  // one diarization run per stop: the notes wait for it (see diarize/afterStop.ts), a resume starts a fresh one
  const diarizeSchedule = createDiarizeSchedule({
    recordingFinished, transcriptFinished, namesFinished: (id) => callNames.finished(id),
    schedule: (id) => diarizer.schedule(id), finished: (id) => diarizer.finished(id),
    namesWaitMs: NAMES_WAIT_MS, warn: (message, error) => console.warn(message, error),
  })
  // voice recognition opt-in is snapshotted per meeting: enabling it mid-call never captures the call in progress
  onMeetingStart((m) => { try { store.setVoicesAllowed(m.id, speakerProfiles()) } catch (e) { console.warn('voices_allowed snapshot failed', e) }; diarizeSchedule.forget(m.id) })
  // diarize once the recording, transcript and call names have settled; the notes of the meeting wait for the chain
  onMeetingStopSaved((m) => { void diarizeSchedule.start(m.id) })
```

- [ ] **Step 3: Pass the two dependencies to `hookNotes`**

In the `hookNotes({ ... })` call, replace:

```ts
    store, queue, model, language: meetingLanguage, onStop: onMeetingStopSaved, named: async (id) => { await Promise.all([callNames.finished(id), diarizer.finished(id)]) }, earlier: (id) => readAhead.parts(id), me,
```

with:

```ts
    store, queue, model, language: meetingLanguage, onStop: onMeetingStopSaved, named: (id) => callNames.finished(id), diarized: (id) => diarizeSchedule.wait(id), earlier: (id) => readAhead.parts(id), me,
```

- [ ] **Step 4: Typecheck and run the affected suites**

Run: `cd app && npx tsc -p . && npx vitest run test/diarizeAfterStop.test.ts test/notes.test.ts test/queue.test.ts test/diarize.test.ts test/diarizeStore.test.ts`
Expected: typecheck exit 0; all tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/index.ts
git commit -m "feat: diarize a meeting before its notes are written"
```

---

### Task 5: Full verification and build

- [ ] **Step 1: Typecheck**

Run: `cd app && npx tsc -p .`
Expected: exit 0.

- [ ] **Step 2: Full unit suite**

Run: `cd app && npx vitest run`
Expected: no new failures beyond the known environment-sensitive files on this machine (`test/meetingSearch.test.ts`, `test/searchFilters.test.ts`, `test/searchPeople.test.ts`, `test/searchQuery.test.ts`; date/locale sensitive, identical on `origin/main`).

- [ ] **Step 3: Build the app**

Run: `cd app && npx electron-vite build`
Expected: exit 0.

- [ ] **Step 4: Manual check (after restarting the app)**

Stop the running Electron instance, start it again (`cd app && npx electron .`), record a short meeting, and stop it. In the log, `DIARIZE` lines must appear before the `NOTES writing the notes of …` line for that meeting, and the note must show diarized speaker names rather than "Andere" lines.

---

## Self-Review

- **Spec coverage:** ordering chain (Task 1), uncapped notes wait + failure tolerance (Task 2), queue priority (Task 3), composition/forget-on-start/single start (Task 4), verification (Task 5). Non-goals are untouched by every task.
- **Placeholders:** none; every code step carries complete code and exact commands.
- **Type consistency:** `createDiarizeSchedule({ recordingFinished, transcriptFinished, namesFinished, schedule, finished, namesWaitMs, warn })` is identical in Task 1's implementation and Task 4's call; `start/wait/forget` names match; `diarized?: (id: string) => Promise<void>` matches between Task 2 and Task 4's `diarized: (id) => diarizeSchedule.wait(id)`.
