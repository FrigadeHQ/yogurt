# Assign "Andere" Transcript Lines to a Speaker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An "Andere" (unlabeled) them-track line in the transcript gets an inline menu listing the meeting's speakers; picking one assigns exactly that line to them.

**Architecture:** One new store method (`assignSegment`) sets `speaker_key`/`speaker` on a single segment; a new IPC route (`transcript:assign-speaker`) exposes it with the same validation/refresh pattern as rename/merge; the renderer's `WhoName` component grows an assign menu in its keyless branch, following its existing rename/merge menu.

**Tech Stack:** TypeScript, better-sqlite3 (via `Store`), Electron IPC, React (project's hook-mock test pattern), vitest.

## Global Constraints

- All commands run from `app/` in the worktree `/home/jck/.local/share/opencode/worktree/79a9dc/diarization`.
- No new dependencies.
- i18n rule (enforced by `test/i18n-tables.test.ts`): a new key must be added to **every** locale file (`src/shared/locales/*.json`, 32 files including `en`); every translation of a `{name}` key must contain the `{name}` blank exactly; no locale may keep a key the app no longer uses.
- Follow existing code style: one-line guards, no semicolon-free style changes, German-free comments in English, `data-testid` on new interactive elements.
- The feature is one line per action; assignment is re-assignable; no bulk, no `me`-track, no un-assign, no undo (spec non-goals).

---

### Task 1: Store — `assignSegment`

**Files:**
- Modify: `app/src/main/store.ts` (add the method directly after `mergeSpeakers`, which ends near line 566)
- Test: `app/test/store.test.ts`

**Interfaces:**
- Consumes: nothing new; uses `this.db`, the existing `segments_au` FTS trigger, and the `Row` row type already used by `renameSpeakers`.
- Produces: `assignSegment(meetingId: string, segmentId: number, key: string): boolean` — used by Task 4's IPC handler.

- [ ] **Step 1: Write the failing tests**

Add to `app/test/store.test.ts` inside its existing main `describe` (follow the file's store-creation helper; if the file has a `fresh()`-style helper, use it — otherwise create the store the way neighbouring tests do). The test seeds one meeting, two them rows (one keyed `v1` named "Ann Lee", one keyless), plus `meeting_speakers` rows for `v1` and `v2`:

```ts
it('assigns an unclaimed them line to a speaker by hand', () => {
  const s = fresh()
  const m = s.createMeeting({ ...base, startedAt: 1 })
  s.addSegments([
    { meetingId: m.id, track: 'them', startMs: 0, endMs: 1000, text: 'said', speaker: 'Ann Lee', speakerKey: 'v1' },
    { meetingId: m.id, track: 'them', startMs: 2000, endMs: 3000, text: 'unclaimed', speaker: null, speakerKey: null },
    { meetingId: m.id, track: 'me', startMs: 500, endMs: 800, text: 'mine', speaker: 'me', speakerKey: null },
  ])
  s.db.exec("INSERT INTO meeting_speakers (meeting_id, key, start_ms, end_ms) VALUES ('" + m.id + "', 'v1', 0, 1000), ('" + m.id + "', 'v2', 2000, 3000)")

  expect(s.assignSegment(m.id, 2, 'v1')).toBe(true)
  const rows = s.segments(m.id).filter(x => x.track === 'them')
  expect(rows.map(x => [x.speakerKey, x.speaker])).toEqual([['v1', 'Ann Lee'], ['v1', 'Ann Lee']])

  // unknown segment, unknown key, hidden and me rows are refused
  expect(s.assignSegment(m.id, 999, 'v1')).toBe(false)
  expect(s.assignSegment(m.id, 3, 'v9')).toBe(false)
})
```

Also verify the search index follows: after assigning, `SELECT text FROM segments_fts WHERE segments_fts MATCH 'unclaimed'` still returns the row (the `segments_au` trigger handles it; this assertion pins that behaviour).

- [ ] **Step 2: Run to verify it fails**

Run: `cd app && npx vitest run test/store.test.ts`
Expected: FAIL — `s.assignSegment is not a function`.

- [ ] **Step 3: Implement**

In `src/main/store.ts`, directly after `mergeSpeakers` (and before `setVoicesAllowed`), add:

```ts
  /** a them line diarization left unclaimed: the person attributes it to one of the meeting's voices by hand */
  assignSegment(meetingId: string, segmentId: number, key: string): boolean {
    if (!key) return false
    const seg = this.db.prepare('SELECT track, hidden FROM segments WHERE meeting_id = ? AND id = ?').get(meetingId, segmentId) as Row | undefined
    if (!seg || String(seg.track) !== 'them' || Number(seg.hidden) === 1) return false
    const known = this.db.prepare('SELECT key FROM meeting_speakers WHERE meeting_id = ? AND key = ?').get(meetingId, key) as Row | undefined
    if (!known) return false
    const nameOf = (k: string) => { const r = this.db.prepare('SELECT speaker FROM segments WHERE meeting_id = ? AND speaker_key = ? AND speaker IS NOT NULL AND hidden = 0 LIMIT 1').get(meetingId, k) as Row | undefined; return r?.speaker == null ? null : String(r.speaker) }
    const name = nameOf(key)
    if (!name) return false
    this.db.prepare('UPDATE segments SET speaker_key = ?, speaker = ? WHERE id = ?').run(key, name, segmentId)
    return true
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd app && npx vitest run test/store.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add app/src/main/store.ts app/test/store.test.ts
git commit -m "feat(store): assign an unclaimed them line to a speaker by hand"
```

---

### Task 2: i18n — the two new strings in every locale

**Files:**
- Modify: all 32 files in `app/src/shared/locales/` (`en.json` + 31 translations)

**Interfaces:**
- Produces: the keys `Assign to speaker` and `Assign to {name}`, used by Task 5's menu.

- [ ] **Step 1: Add the keys with a script (idempotent, order-preserving)**

Run from `app/`:

```bash
node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
const t = {
  en: ["Assign to speaker", "Assign to {name}"],
  de: ["Sprecher zuweisen", "Zuweisen an {name}"],
  fr: ["Attribuer à un intervenant", "Attribuer à {name}"],
  es: ["Asignar a un hablante", "Asignar a {name}"],
  it: ["Assegna a un relatore", "Assegna a {name}"],
  nl: ["Toewijzen aan een spreker", "Toewijzen aan {name}"],
  "pt-BR": ["Atribuir a um palestrante", "Atribuir a {name}"],
  sv: ["Tilldela till en talare", "Tilldela till {name}"],
  da: ["Tildel til en taler", "Tildel til {name}"],
  nb: ["Tilordne til en taler", "Tilordne til {name}"],
  fi: ["Määritä puhujalle", "Määritä puhujalle {name}"],
  cs: ["Přiřadit ke řečníkovi", "Přiřadit řečníkovi {name}"],
  pl: ["Przypisz do mówcy", "Przypisz do {name}"],
  ru: ["Назначить говорящему", "Назначить как {name}"],
  uk: ["Призначити промовцю", "Призначити як {name}"],
  tr: ["Konuşmacıya ata", "{name} olarak ata"],
  el: ["Ανάθεση σε ομιλητή", "Ανάθεση ως {name}"],
  ro: ["Atribuie unui vorbitor", "Atribuie ca {name}"],
  hu: ["Hozzárendelés egy beszélőhöz", "Hozzárendelés mint {name}"],
  id: ["Tetapkan ke pembicara", "Tetapkan sebagai {name}"],
  ms: ["Tetapkan kepada pembicara", "Tetapkan sebagai {name}"],
  vi: ["Gán cho người nói", "Gán là {name}"],
  th: ["มอบหมายให้ผู้พูด", "ระบุเป็น {name}"],
  ja: ["話者に割り当てる", "{name} として割り当て"],
  ko: ["화자에게 할당", "{name}(으)로 할당"],
  "zh-CN": ["分配给说话人", "分配给 {name}"],
  "zh-TW": ["指派給說話者", "指派給 {name}"],
  ar: ["تعيين إلى متحدث", "تعيين باسم {name}"],
  he: ["שיוך לדובר", "שיוך בשם {name}"],
  hi: ["वक्ता को असाइन करें", "{name} के रूप में असाइन करें"],
  bn: ["বক্তাকে নিয়োগ করুন", "{name} হিসেবে নিয়োগ করুন"],
  fil: ["Italaga sa tagapagsalita", "Italaga bilang {name}"],
};
for (const [id, [label, item]] of Object.entries(t)) {
  const p = `src/shared/locales/${id}.json`;
  const j = JSON.parse(readFileSync(p, "utf8"));
  if (!("Assign to speaker" in j)) j["Assign to speaker"] = label;
  if (!("Assign to {name}" in j)) j["Assign to {name}"] = item;
  writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
}
console.log("locales updated");
'
```

- [ ] **Step 2: Run the i18n tables test**

Run: `cd app && npx vitest run test/i18n-tables.test.ts`
Expected: PASS (the `{name}` blank is present in every `Assign to {name}` translation; no locale gains a key the app does not use — Task 5 adds the usage, so if this task runs first the "keeps nothing" assertion still passes because it only checks locale keys ⊆ used keys and `Assign to speaker`/`Assign to {name}` will be used by Task 5; if it flags them as unused, run this test again after Task 5).

- [ ] **Step 3: Commit**

```bash
git add app/src/shared/locales
git commit -m "i18n: assign-line strings in every locale"
```

---

### Task 3: Preload + types — `assignSpeaker`

**Files:**
- Modify: `app/src/preload/index.ts` (in the `transcript:` block, after line 92's `mergeSpeaker`)
- Modify: `app/src/shared/types.ts` (in the `transcript:` block of `YogurtApi`, after line 116's `mergeSpeaker`)

**Interfaces:**
- Produces: `window.yogurt.transcript.assignSpeaker(meetingId: string, segment: number, key: string): Promise<boolean>` — used by Task 5.

- [ ] **Step 1: Preload**

In `src/preload/index.ts`, after the `mergeSpeaker` line, add:

```ts
    assignSpeaker: (id, segment, key) => ipcRenderer.invoke('transcript:assign-speaker', id, segment, key),
```

- [ ] **Step 2: Type**

In `src/shared/types.ts`, after the `mergeSpeaker` line in the `transcript:` block, add:

```ts
    assignSpeaker(meetingId: string, segment: number, key: string): Promise<boolean>
```

- [ ] **Step 3: Typecheck**

Run: `cd app && npx tsc -p .`
Expected: exit 0 (no output). The IPC handler itself does not exist yet, but preload's `invoke` is untyped against handlers, so this still passes; Task 4 adds the handler.

- [ ] **Step 4: Commit**

```bash
git add app/src/preload/index.ts app/src/shared/types.ts
git commit -m "feat(preload): expose transcript.assignSpeaker"
```

---

### Task 4: Main — the `transcript:assign-speaker` handler

**Files:**
- Modify: `app/src/main/index.ts` (directly after the `transcript:merge-speaker` handler, near line 578)

**Interfaces:**
- Consumes: `store.assignSegment` (Task 1), `speakersChanged` (already defined above the rename/merge handlers).

- [ ] **Step 1: Add the handler**

After the `transcript:merge-speaker` `ipcMain.handle(...)` block, add:

```ts
  ipcMain.handle('transcript:assign-speaker', (_e, id: unknown, segment: unknown, key: unknown) => {
    if (!isId(id) || typeof segment !== 'number' || !Number.isInteger(segment) || typeof key !== 'string') return false
    const ok = store.assignSegment(id, segment, key)
    if (ok) speakersChanged(id)
    return ok
  })
```

- [ ] **Step 2: Typecheck and run the store test again**

Run: `cd app && npx tsc -p . && npx vitest run test/store.test.ts`
Expected: typecheck exit 0; store tests pass.

- [ ] **Step 3: Commit**

```bash
git add app/src/main/index.ts
git commit -m "feat(main): assign an Andere line to a speaker over IPC"
```

---

### Task 5: Renderer — the assign menu on "Andere" lines

**Files:**
- Modify: `app/src/renderer/src/components/Transcript.tsx` (the `WhoName` component, keyless branch at its top; also `export` the component)
- Test: `app/test/assignAndere.test.ts` (new file)

**Interfaces:**
- Consumes: `window.yogurt.transcript.assignSpeaker` (Task 3), the `voices` prop already passed to `WhoName`, and the line's `id` (already on the `Line` type).
- Produces: `WhoName` exported from `Transcript.tsx` for tests.

- [ ] **Step 1: Export the component**

Change `function WhoName({ meetingId, line, voices }: ...)` to `export function WhoName({ meetingId, line, voices }: ...)`.

- [ ] **Step 2: Write the failing test**

Create `app/test/assignAndere.test.ts`, following the project's hook-mock component pattern (as in `test/resumeRequest.test.ts`):

```ts
import { beforeEach, expect, it, vi } from 'vitest'
import { isValidElement, type ReactElement, type ReactNode } from 'react'

const hooks = vi.hoisted(() => ({ values: [] as unknown[], refs: [] as { current: unknown }[], memos: [] as unknown[], effects: [] as { cleanup?: () => void }[], state: 0, ref: 0, memo: 0, effect: 0 }))
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const i = hooks.state++
    if (!(i in hooks.values)) hooks.values[i] = typeof initial === 'function' ? initial() : initial
    return [hooks.values[i], (next: unknown) => { hooks.values[i] = typeof next === 'function' ? next(hooks.values[i]) : next }]
  },
  useRef: (initial: unknown) => hooks.refs[hooks.ref++] ?? (hooks.refs[hooks.ref - 1] = { current: initial }),
  useMemo: (make: () => unknown) => { const i = hooks.memo++; return hooks.memos[i] ?? (hooks.memos[i] = make()) },
  useEffect: () => {},
}))

const assignSpeaker = vi.fn()
beforeEach(() => {
  hooks.state = 0; hooks.ref = 0; hooks.memo = 0; hooks.effect = 0
  hooks.values = []; hooks.refs = []; hooks.memos = []; hooks.effects = []
  vi.clearAllMocks()
  vi.stubGlobal('window', { yogurt: { transcript: { assignSpeaker } } })
})
afterEach(() => vi.unstubAllGlobals())

const find = (node: ReactNode, id: string): ReactElement<Record<string, unknown>> | undefined => {
  if (Array.isArray(node)) return node.map(child => find(child, id)).find(Boolean)
  if (!isValidElement<Record<string, unknown>>(node)) return
  return node.props['data-testid'] === id ? node : find(node.props.children as ReactNode, id)
}
const line = { id: 7, meetingId: 'm1', track: 'them' as const, startMs: 1000, endMs: 2000, text: ' Als Lead Engineer bei Wunderlist half', speaker: null, speakerKey: null }
const voices = [{ name: 'Speaker 1', key: 'v26' }, { name: 'Speaker 2', key: 'v27' }]

async function render() {
  const { WhoName } = await import('../src/renderer/src/components/Transcript')
  return WhoName({ meetingId: 'm1', line, voices }) as ReactNode
}

it('an Andere line offers the meeting\u2019s speakers and assigns the line to the picked one', async () => {
  const tree = await render()
  const menu = find(tree, 'speaker-menu')
  expect(menu).toBeTruthy()
  // closed until clicked
  expect(find(tree, 'speaker-assign')).toBeUndefined()
  menu!.props.onClick()
  const opened = await render()
  const items = []
  const collect = (node: ReactNode) => {
    if (Array.isArray(node)) return node.forEach(collect)
    if (!isValidElement<Record<string, unknown>>(node)) return
    if (node.props['data-testid'] === 'speaker-assign') items.push(node)
    collect(node.props.children as ReactNode)
  }
  collect(opened)
  expect(items.map(x => x.props.children)).toEqual(['Assign to Speaker 1', 'Assign to Speaker 2'])
  items[1].props.onClick()
  expect(assignSpeaker).toHaveBeenCalledWith('m1', 7, 'v27')
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd app && npx vitest run test/assignAndere.test.ts`
Expected: FAIL — the keyless branch renders no `speaker-menu` (the found `menu` is undefined → assertion `expect(menu).toBeTruthy()` fails).

- [ ] **Step 4: Implement the assign menu in the keyless branch**

In `WhoName`, replace the early-return branch:

```tsx
  if (!voiceKey) return (
    <span data-testid="transcript-who" data-color={color} data-folder-color={color === undefined ? undefined : SPEAKER_COLORS[color]} className="line-who font-medium text-muted name-in">{who(line)}</span>
  )
```

with:

```tsx
  // diarization left this line unclaimed: the person says who said it
  if (!voiceKey) return (
    <span className="turn-head-name name-in">
      <button type="button" data-testid="transcript-who" data-color={color} data-folder-color={color === undefined ? undefined : SPEAKER_COLORS[color]} className="line-who font-medium text-muted" title={t('Assign to speaker')}
        onClick={() => setMenu((m) => !m)}>{who(line)}</button>
      <button type="button" data-testid="speaker-menu" aria-label={t('Assign to speaker')} aria-haspopup="menu" aria-expanded={menu}
        onClick={() => setMenu((m) => !m)} className="speaker-menu-btn"><ChevronDown size={12} aria-hidden="true" /></button>
      {menu && (
        <div role="menu" data-testid="speaker-menu-list" onKeyDown={(e) => { if (e.key === 'Escape') setMenu(false) }}>
          {voices.map((v) => (
            <button type="button" role="menuitem" data-testid="speaker-assign" key={v.key}
              onClick={() => { setMenu(false); void window.yogurt.transcript.assignSpeaker(meetingId, line.id, v.key) }}>
              {t('Assign to {name}', { name: v.name })}
            </button>
          ))}
        </div>
      )}
    </span>
  )
```

If `line.id` is not on the renderer's `Line` type, take the id from the line object the call site already carries (`first.id`) by extending the `WhoName` props with `segment: number` and passing `segment={first.id}` at the mount site (line ~453) — prefer this variant if `Line` lacks `id`.

- [ ] **Step 5: Run to verify it passes**

Run: `cd app && npx vitest run test/assignAndere.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the whole affected set**

Run: `cd app && npx tsc -p . && npx vitest run test/assignAndere.test.ts test/i18n-tables.test.ts test/store.test.ts test/diarize.test.ts test/diarizeStore.test.ts`
Expected: typecheck exit 0, all pass.

- [ ] **Step 7: Commit**

```bash
git add app/src/renderer/src/components/Transcript.tsx app/test/assignAndere.test.ts
git commit -m "feat(transcript): assign an Andere line to a speaker from its menu"
```

---

### Task 6: Full verification

- [ ] **Step 1: Typecheck the app**

Run: `cd app && npx tsc -p .`
Expected: exit 0.

- [ ] **Step 2: Run the full unit suite**

Run: `cd app && npx vitest run`
Expected: no new failures beyond the 8 environment-failing files already known on this machine (`echoDetect`, `libraryRetrieve`, `libraryVectors`, `meetingSearch`, `searchFilters`, `searchPeople`, `searchQuery`, `zip` — locale/date/perf sensitive; they fail identically on `origin/main` here).

- [ ] **Step 3: Rebuild the running app so the feature is live**

Run: `cd app && npx electron-vite build`
Expected: exit 0. (The user's running Electron instance must be restarted afterwards to load it — coordinate with the user.)

---

## Self-Review

- Spec coverage: store method (Task 1), IPC (Task 4), preload/type (Task 3), renderer menu (Task 5), i18n (Task 2), tests (each task). Spec's "no un-assign / no bulk / no me-track" — nothing implements them ✓.
- Placeholder scan: all steps carry real code; the i18n step's script contains every translation ✓.
- Type consistency: `assignSegment(meetingId, segmentId, key)` matches between Task 1 and Task 4; `assignSpeaker(meetingId, segment, key)` matches between Task 3 and Task 5; testids `speaker-menu`/`speaker-assign` match between test and implementation ✓.
