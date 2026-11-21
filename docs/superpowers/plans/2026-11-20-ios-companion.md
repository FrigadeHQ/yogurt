# Yogurt for iPhone (companion) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A native iPhone app that pairs with desktop Yogurt over the LAN (6-digit code, CPace + Noise KK), syncs the whole meeting history both ways, records in-person meetings with on-device transcription and draft notes, and searches/asks across everything.

**Architecture:** Desktop gains `app/src/main/companion/` (crypto, change log, TCP+Bonjour server, sync handlers, Settings UI). The phone is `ios/` = a Swift package `YogurtKit` (crypto, wire protocol, SQLite store, sync client, status, summarizer) tested with `swift test` on macOS, plus an XcodeGen SwiftUI app `ios/Yogurt` that compiles for `iphoneos`.

**Tech Stack:** TypeScript/Electron/vitest (desktop); Swift 6.3, SwiftUI, iOS 26 (FoundationModels, Speech, AVFoundation, Network, LocalAuthentication), system SQLite3+FTS5, swift-sodium; libsodium-wrappers-sumo + bonjour-service on desktop; XcodeGen.

**Spec:** `docs/superpowers/specs/2026-11-20-ios-companion-design.md`

## Global Constraints

- Branch `ios-companion` in `~/Code/yogurt-ios` is LOCAL ONLY: never push, never open a PR.
- Commit as `christianmat <9771548+christianmat@users.noreply.github.com>`, no AI attribution, one task = one or more focused commits.
- Never launch Electron, `pnpm dev` or Playwright/e2e (they pop windows on the person's Mac). Desktop checks: `pnpm -C app typecheck` and `cd app && NODE_OPTIONS= npx vitest run`. iOS checks: `cd ios/YogurtKit && swift test` and `xcodebuild -project ios/Yogurt.xcodeproj -scheme Yogurt -sdk iphoneos -configuration Debug CODE_SIGNING_ALLOWED=NO build`.
- TDD: failing test first, watch it fail, then implement.
- Dependencies pinned to exact versions published ≥ 14 days ago: `libsodium-wrappers-sumo`, `bonjour-service` (desktop); `swift-sodium` (SPM, exact). Nothing else new unless a task says so.
- Desktop: every visible string through `t('English text')` and translated in every `app/src/shared/locales/*.json` (test/i18n-tables.test.ts enforces); plain friendly words, no jargon, no emoji; logical CSS classes (`ms-`, `pe-`) for RTL; `data-testid` on things tests touch.
- Desktop companion server must work on Mac, Windows and Linux and is off until the person starts pairing or a phone is paired.
- Logs never contain note text, transcript text, names or keys; ids and counts only (tag `COMPANION`).
- Phone UI copy: same plain voice as desktop, English only in v1 (strings in one `Strings.swift` so translation is easy later), SF Symbols for icons, no emoji.
- Crypto parameters are fixed: CPace ristretto255 + SHA-512 (draft-irtf-cfrg-cpace), PRS = the 6 ASCII digits, CI = `"yogurt-pair-v1"` ‖ desktop session id ‖ phone session id; pairing secrets boxed with XChaCha20-Poly1305 under keys from HKDF-SHA-512(ISK); sessions Noise `Noise_KK_25519_ChaChaPoly_BLAKE2b` with prologue `"yogurt-v1"`.
- Pairing window: 2 minutes, 5 wrong attempts then a new code; only one phone kept (a new pairing replaces the old).
- Wire: TCP, each frame = 2-byte big-endian length + Noise transport message (≤ 65535); plaintext app messages are UTF-8 JSON; payloads > 60000 bytes are split with `{chunk, of}`.

## Shared wire protocol (all tasks use these names)

Pairing frames (before Noise, plaintext JSON then binary): `pairHello {v:1, phoneSession: b64, phoneName}` → `pairStart {v:1, desktopSession: b64, desktopId, desktopName, ya: b64}` → `pairReply {yb: b64}` → `pairConfirm {box: b64}` (desktop→phone, contains desktop static pub + name + MAC) → `pairDone {box: b64}` (phone→desktop, phone static pub + name) → `pairOk {}` or `pairFail {reason: "code"|"expired"|"tooMany"}`.

Session messages `{id: string, type: string, body: object}`; replies `{id, type: "ok"|"error", body}`:
- `hello {appVersion, schema: 1}` → `{desktopId, desktopName, desktopVersion}`
- `pull {since: number, limit: number}` → `{changes: Change[], cursor: number, more: boolean}` where `Change = {entity: "meeting"|"notes"|"segments"|"folder"|"folderMembers"|"people", id: string, deleted?: true, record?: object}`
- `op {kind: "setMine"|"rename"|"addToFolder"|"removeFromFolder"|"trash"|"restore", meetingId, folderId?, text?, title?, baseHash?}` → `{applied: true, merged?: true}`
- `uploadMeeting {meeting: {id,title,startedAt,endedAt,attendees}, myNotes, transcript: [{startMs,endMs,text}], summary?}` → `{accepted: true}`; then `uploadAudio {meetingId, chunk: b64, index, of, mime: "audio/mp4"}`
- `ask {question, scope?: {folderId?, meetingIds?}}` → `{answer, sources: [{meetingId, title, atMs?, text}]}`
- `audio {meetingId, track: "me"|"them"}` → stream of `audioChunk {chunk: b64, index, of}`
- push from desktop: `changed {cursor}`; keepalive `ping {}` / `pong {}`

## Review Focus

1. Wrong code / replayed or stolen pairing transcript → pairing fails, attempt counted, no keys stored (Task 2, 6 tests).
2. A connection from an unpaired key or garbage bytes → closed before any app message is handled, server stays up (Task 6 test).
3. My notes edited on both sides while apart → neither text lost (Task 5 test: base hash mismatch merges under "From your iPhone").
4. Wi-Fi drops mid-sync or mid-upload → phone resumes from cursor / re-uploads; desktop does not create the meeting twice (Task 6 idempotent upload test, Task 9 resume test).
5. Status always truthful: unpaired, desktop app closed, different network, syncing, error → the pill reads correctly (Task 9 status test).

---

### Task 1: Test vectors and fixtures

**Files:** Create `ios/Fixtures/noise-kk-vectors.json`, `ios/Fixtures/cpace-ristretto255-vectors.json`, `ios/Fixtures/README.md` (sources + licences).

**Interfaces:** Produces the two JSON files consumed by Tasks 2 and 3 (same paths from both test suites).

- [ ] Step 1: Fetch the official Noise test vectors that include `Noise_KK_25519_ChaChaPoly_BLAKE2b` (cacophony / snow vectors, public domain/MIT) and the ristretto255 vectors from draft-irtf-cfrg-cpace's appendix; keep only those suites; record source URLs and licence in README.md.
- [ ] Step 2: Commit `test: Noise KK and CPace ristretto255 vectors for the companion`.

### Task 2: Desktop crypto — CPace and Noise KK

**Files:** Create `app/src/main/companion/cpace.ts`, `app/src/main/companion/noise.ts`, `app/src/main/companion/sodium.ts` (await ready, export instance); tests `app/test/companionCpace.test.ts`, `app/test/companionNoise.test.ts`. Modify `app/package.json` (+ `libsodium-wrappers-sumo` exact), lockfile.

**Interfaces (Produces):**
- `cpaceStart(prs: string, ci: Uint8Array, sid: Uint8Array): { ya: Uint8Array; secret: Uint8Array }`, `cpaceFinish(secret, yb: Uint8Array, ...transcript): Uint8Array /* ISK 64 bytes */` and the responder pair `cpaceRespond(prs, ci, sid, ya): { yb; isk }`.
- `pairKeys(isk): { toPhone: Uint8Array; toDesktop: Uint8Array; confirm: Uint8Array }` (HKDF-SHA-512 labels `"yogurt pair to-phone"`, `"to-desktop"`, `"confirm"`).
- `class NoiseKK { constructor(o: {initiator: boolean; s: KeyPair; rs: Uint8Array; prologue: Uint8Array}); writeMessage(payload): Uint8Array; readMessage(msg): Uint8Array; get done(): boolean; split(): {send: CipherState; recv: CipherState} }`, `CipherState.encrypt(pt) / decrypt(ct)` with nonce counter, `rekey()`.
- `generateKeyPair(): KeyPair` (`{publicKey, privateKey}` X25519).

- [ ] Step 1: Tests: every KK vector in `ios/Fixtures/noise-kk-vectors.json` reproduces its handshake and transport ciphertexts; every CPace vector reproduces Ya/Yb/ISK; a wrong PRS on one side gives different ISKs; decrypt of a tampered transport message throws.
- [ ] Step 2: Run `cd app && NODE_OPTIONS= npx vitest run test/companionCpace.test.ts test/companionNoise.test.ts` → FAIL (modules missing).
- [ ] Step 3: Implement on libsodium (`crypto_core_ristretto255_from_hash`, `crypto_scalarmult_ristretto255`, `crypto_hash_sha512`, `crypto_scalarmult` X25519, `crypto_aead_chacha20poly1305_ietf_*`, `crypto_generichash` BLAKE2b with HMAC per Noise spec §4.3).
- [ ] Step 4: Tests pass; typecheck clean. Commit.

### Task 3: YogurtKit package and Swift crypto

**Files:** Create `ios/YogurtKit/Package.swift` (platforms iOS 26, macOS 15; dependency swift-sodium exact), `Sources/YogurtKit/Crypto/{CPace.swift, Noise.swift, KeyPair.swift, HKDF.swift}`, `Tests/YogurtKitTests/{CPaceTests.swift, NoiseTests.swift}` reading `../../Fixtures/*.json`.

**Interfaces (Produces):** Swift mirrors of Task 2: `CPace.start(prs:ci:sid:) -> (ya: Data, secret: Data)`, `CPace.finish(secret:yb:transcript:) -> Data`, `CPace.respond(...)`, `PairKeys(isk:)` with `toPhone`, `toDesktop`, `confirm`; `final class NoiseKK` with `writeMessage(_:) throws -> Data`, `readMessage(_:) throws -> Data`, `isDone`, `split() -> (send: CipherState, recv: CipherState)`; `KeyPair.generate()`.

- [ ] Step 1: Tests mirror Task 2 against the same vectors.
- [ ] Step 2: `cd ios/YogurtKit && swift test` → FAIL.
- [ ] Step 3: Implement with swift-sodium (Clibsodium functions where the Swift API lacks ristretto255).
- [ ] Step 4: Pass; commit.

### Task 4: Cross-implementation interop harness

**Files:** Create `app/scripts/companion-peer.mjs` (a tiny Node peer: `node app/scripts/companion-peer.mjs <role> <port>` runs one CPace pairing or one Noise KK session using the compiled modules from Task 2 via vitest-free import of `app/src/main/companion/*.ts` through esbuild or a small build step chosen by the implementer); `ios/YogurtKit/Tests/YogurtKitTests/InteropTests.swift` (skipped with a clear message when `node` is not found).

- [ ] Step 1: Swift test: pair with the Node peer using code `"482913"` → both derive identical ISK and exchange static keys; then a Noise KK session echoes 3 messages incl. one of 65000 bytes; a wrong code fails with `pairFail{reason:"code"}`.
- [ ] Step 2: Fails, implement peer + Swift test client glue, pass, commit.

### Task 5: Desktop change log and companion store API

**Files:** Modify `app/src/main/store.ts` (migration: `companion_changes(seq INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT, entity_id TEXT, at INTEGER)` + triggers on meetings, notes, segments, folders, folder_meetings, people; `companion_devices(id TEXT PRIMARY KEY, name, public_key TEXT, paired_at INTEGER, last_seen INTEGER)`); create `app/src/main/companion/records.ts`; test `app/test/companionRecords.test.ts`.

**Interfaces (Produces):** `changesSince(store, since: number, limit: number): { changes: Change[]; cursor: number; more: boolean }` (collapses repeated entity ids, emits tombstones for deleted rows, trashed meetings as `meeting` records with `trashedAt`); `applyOp(store, op, deps: {notesRewrite, nowMs}): { applied: true; merged?: true }`; `notesHash(text: string): string` (sha256 hex of NFC text).

- [ ] Step 1: Tests: a new meeting, notes edit, transcript segments, folder add/remove each appear once after `since`; cursor advances; `limit` pages with `more`; deleting a folder yields a tombstone; `setMine` with matching baseHash replaces, with a stale baseHash keeps desktop text and appends `\n\n## From your iPhone\n` + phone text and returns `merged: true`; `trash` moves to Trash (restorable), never deletes.
- [ ] Steps 2–4: fail → implement → pass; commit.

### Task 6: Desktop companion server

**Files:** Create `app/src/main/companion/{frames.ts, pairing.ts, session.ts, server.ts, handlers.ts, index.ts}`; modify `app/src/main/index.ts` (start/stop, wiring), `app/package.json` (+ `bonjour-service` exact); tests `app/test/companionServer.test.ts`, `app/test/companionPairing.test.ts` (in-process TS client over a real localhost socket).

**Interfaces (Produces):** `createCompanion(deps: {store, userDataDir, seal, open, ask(question, scope) → Promise<{answer, sources}>, importRecording(meeting, audioPath, phoneDraft) → Promise<void>, audioFiles(meetingId) → Promise<{track, path}[]>, deviceName(): string, log})` → `{ startPairing(): {code: string; expiresAt: number}; cancelPairing(); unpair(); status(): CompanionStatus; onStatus(cb); stop() }` where `CompanionStatus = {paired: null | {name: string; lastSeen: number|null}; pairing: null | {code; expiresAt; attemptsLeft}; connected: boolean; syncing: boolean}`. Listens on 0.0.0.0, random port, persisted desktop id + static key (sealed) in `userData/companion.json`; advertises `_yogurt._tcp` only while pairing or paired.

- [ ] Step 1: Tests: full pairing with the right code stores the phone and stops advertising `pairing=1`; 5 wrong codes → `tooMany` and a fresh code; expired after 2 min (fake clock); a second pairing replaces the first phone; Noise session with the paired key answers `hello` and `pull`; an unpaired static key, a truncated frame and random bytes are each closed before any handler runs and the server keeps serving; `uploadMeeting` twice with the same id creates one meeting (idempotent) and calls `importRecording` once after all audio chunks; `changed` is pushed after a store write; `ask` proxies to deps.ask.
- [ ] Steps 2–4: fail → implement → pass; typecheck; commit.

### Task 7: Desktop Settings → Phone

**Files:** Create `app/src/renderer/src/components/PhoneSettings.tsx`; modify `components/SettingsOverlay.tsx` (new section), `app/src/preload/index.ts` + types (`companion: {status, startPairing, cancelPairing, unpair, onStatus}`), IPC in `app/src/main/companion/ipc.ts`, all `app/src/shared/locales/*.json`; test `app/test/phoneSettings.test.tsx` (pattern of existing renderer tests).

- [ ] Step 1: Tests: not paired shows "Pair a phone"; pairing shows the 6 digits large with "Open Yogurt on your iPhone and type this code" and a countdown; paired shows the phone's name, "Connected"/"Last seen …" and "Unpair"; copy: "Your iPhone talks to this computer only on the same Wi-Fi. Nothing goes through the internet."
- [ ] Steps 2–4; i18n tables complete (translate every new string in every locale); commit.

### Task 8: YogurtKit store

**Files:** Create `ios/YogurtKit/Sources/YogurtKit/Store/{Database.swift, Models.swift, Store.swift, Search.swift}`; tests `StoreTests.swift`, `SearchTests.swift`.

**Interfaces (Produces):** models `Meeting`, `Notes(mine, summary, summarySource: .desktop|.phoneDraft)`, `Segment`, `Folder`, `Person`, `PendingOp`, `LocalRecording`; `final class Store { init(url: URL) throws; apply(_ changes: [Change], cursor: Int) throws; cursor: Int; meetings(folder: String?) -> [Meeting]; meeting(id) ; notes(id); segments(id); folders(); enqueue(_ op: PendingOp); pendingOps() -> [PendingOp]; markSent(opId); saveLocalRecording(...); search(_ q: String, limit: Int) -> [SearchHit] }` (FTS5 over title, mine, summary, transcript); database file created with `FileProtectionType.complete`.

- [ ] Step 1: Tests: applying a page of changes inserts/updates/tombstones; cursor persists; a local edit queued as PendingOp survives reopen; search finds words in title/notes/transcript with snippets; a desktop record replaces a phone draft summary but keeps local My notes edits not yet sent.
- [ ] Steps 2–4; commit.

### Task 9: YogurtKit sync client and status

**Files:** Create `Sources/YogurtKit/Sync/{Transport.swift (protocol + NWConnection impl), Discovery.swift (NWBrowser `_yogurt._tcp`), Pairing.swift, Session.swift, SyncEngine.swift, Status.swift, Keychain.swift}`; tests `SyncEngineTests.swift`, `StatusTests.swift` (fake transport), extend `InteropTests.swift` (against a Node server from Task 6 started with a headless script `app/scripts/companion-server-harness.mjs` + fake store fixture).

**Interfaces (Produces):** `enum ConnectionStatus { case notPaired, searching, connecting(name), connected(name, syncing: Int?), offline(name, lastSync: Date?), error(String) }` with `label: String` (e.g. "Connected to MacBook · Synced just now", "Syncing 12 meetings…", "Not on the same Wi-Fi · last synced 2 h ago", "Not paired"); `@MainActor final class SyncEngine: ObservableObject { @Published status; func pair(with: DiscoveredDesktop, code: String) async throws; func syncNow() async; func unpair(); func ask(_ q: String, scope:) async throws -> RemoteAnswer; func audioURL(meetingId:) async throws -> URL; func upload(_ rec: LocalRecording) async throws }`.

- [ ] Step 1: Tests: pull loops until `more == false`; a dropped connection mid-pull resumes from the stored cursor; pending ops are sent in order and cleared only after `ok`; an upload interrupted after chunk 3 restarts and the desktop gets one meeting; statuses map correctly for each case (no keys → notPaired; browsing → searching; handshake → connecting; pulling n → syncing n; no desktop found for 10 s → offline with last sync; auth failure → error "This computer doesn't recognise this iPhone any more. Pair again."); interop: pair + pull + op + ask against the Node harness.
- [ ] Steps 2–4; commit.

### Task 10: iOS app shell, theme and reading screens

**Files:** Create `ios/project.yml` (XcodeGen; app `Yogurt`, bundle id `so.yogurt.ios`, iOS 26, depends on local package YogurtKit; Info.plist keys `NSLocalNetworkUsageDescription`, `NSBonjourServices` [`_yogurt._tcp`], `NSMicrophoneUsageDescription`, `NSSpeechRecognitionUsageDescription`, `NSFaceIDUsageDescription`, `UIBackgroundModes` [audio]); `ios/Yogurt/{YogurtApp.swift, Theme.swift (desktop tokens: bg #FFFFFF, card #F6F6F8, ink #23242A, muted #6E6F7B, line #E6E6EC, accent #7142E8, accent-soft #EDE6FC, live #416D48, danger #C13E51 + dark variants from styles.css; Hanken Grotesk bundled from app resources if licence allows, else system), Strings.swift, Views/{StatusPill, PairingView, HomeView, MeetingRow, NoteView, SearchView, SettingsView}.swift}`; generated `ios/Yogurt.xcodeproj` committed.

- [ ] Step 1: Build check is the test: `xcodegen --spec ios/project.yml && xcodebuild … -sdk iphoneos CODE_SIGNING_ALLOWED=NO build` succeeds; SwiftUI previews compile with fixture data.
- [ ] Step 2: Screens: Pairing (list of computers in pairing mode → 6-digit code field with one box per digit, plain help text); Home (status pill at top, Record button, meetings by day like desktop cards, folder filter); Note (title, date, Summary / My notes / Transcript tabs, edit My notes with autosave → PendingOp, rename, folders, Trash); Search; Settings (computer name, status, Sync now, Unpair, Face ID lock toggle, storage used).
- [ ] Step 3: Build passes; commit.

### Task 11: Recording on the phone, draft notes, upload

**Files:** `ios/YogurtKit/Sources/YogurtKit/Summary/{Chunker.swift, Summarizer.swift (protocol)}`, tests `ChunkerTests.swift`; app `ios/Yogurt/Recording/{Recorder.swift (AVAudioEngine → m4a, level meter, background audio), LiveTranscriber.swift (SpeechAnalyzer/SpeechTranscriber, fallback SFSpeechRecognizer on-device), AppleSummarizer.swift (FoundationModels LanguageModelSession, availability check), RecordView.swift}`.

**Interfaces:** `Chunker.chunks(_ segments: [Segment], maxChars: Int = 6000) -> [String]`; `protocol Summarizer { func summarize(transcript: [Segment], myNotes: String) async throws -> String }` producing Markdown with headings like desktop notes (`## Summary`, `## Decisions`, `## Next steps`); map-reduce: summarize each chunk, then combine.

- [ ] Step 1: Tests: chunker splits on line boundaries under maxChars and never drops text; a fake summarizer is called per chunk then once to combine.
- [ ] Step 2: Record screen: big timer, level, live transcript, My notes field, Stop → saves LocalRecording, writes draft summary (or "Notes will be written when your computer has it" when the model is unavailable), queues upload; Home shows "Recorded on this iPhone · waiting for your computer" until replaced.
- [ ] Step 3: swift test + iphoneos build pass; commit.

### Task 12: Ask, Face ID lock, polish, install guide

**Files:** `ios/Yogurt/Views/AskView.swift`, `ios/Yogurt/Security/AppLock.swift`, `ios/YogurtKit/Sources/YogurtKit/Ask/LocalAsk.swift` (+ test), `ios/README.md`.

- [ ] Step 1: Test `LocalAsk`: picks the top passages from search for the question, builds a prompt ≤ 3500 tokens (4 chars/token estimate) with numbered sources, and maps the model's `[n]` citations back to meetings.
- [ ] Step 2: Ask screen: when connected → remote Ask with sources (tap opens the note); offline → local Ask labelled "Answered on this iPhone"; Face ID lock on launch/foreground when enabled; Data Protection verified on the database file.
- [ ] Step 3: `ios/README.md`: open `ios/Yogurt.xcodeproj` in Xcode, sign in with Apple ID, pick team, plug in iPhone, Run; pair from desktop Settings → Phone. Builds pass; commit.

### Task 13: Whole-branch verification

- [ ] Run all desktop unit tests + typecheck, `swift test`, iphoneos build; fix anything; commit. Never push.
