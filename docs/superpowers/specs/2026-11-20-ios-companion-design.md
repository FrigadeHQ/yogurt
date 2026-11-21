# Yogurt for iPhone (companion app) — design

Local branch `ios-companion` only. Never pushed.

## Intent

People are in live, in-person meetings without their laptop. The phone records them, transcribes and drafts notes on its
own, and carries the person's whole meeting history from their computer so they can read, search and ask across it
anywhere. When the phone and the computer are on the same Wi-Fi, the computer does the heavy lifting (better
transcription and notes) and the two stay in sync. Nothing ever goes through a server.

## Goals (v1)

- Native iPhone app (Swift, SwiftUI), iOS 26+, that looks and feels like desktop Yogurt (same colours, type, spacing,
  cards, plain friendly copy, no emoji, lucide-style line icons → SF Symbols).
- Pair with **one** desktop Yogurt over the local network: the computer shows a 6-digit code, the phone finds it with
  Bonjour and the person types the code. No accounts, no server.
- State-of-the-art, open-source cryptography: CPace (password-authenticated key exchange, ristretto255/SHA-512) for
  pairing, then Noise `KK_25519_ChaChaPoly_BLAKE2b` for every session. libsodium on both sides (swift-sodium,
  libsodium-wrappers-sumo). Both implementations tested against published vectors and against each other.
- Sync the whole history from the computer: meetings (title, time, attendees, app), My notes, the written summary,
  transcripts, folders and membership, and the people list. Audio stays on the computer (streamed on demand on Wi-Fi).
- Phone edits flow back: My notes, title, folder membership, move to Trash / restore. Same rules as desktop; nothing is
  deleted for good from the phone.
- Record in-person meetings on the phone: audio (m4a), live transcript with Apple's on-device speech
  (SpeechAnalyzer/SFSpeechRecognizer), My notes typed during the meeting, and a draft summary written on the phone by
  Apple's built-in model (Foundation Models), chunked for long meetings. On older phones without the model, the summary
  waits for the computer.
- When connected, phone recordings are uploaded; the computer re-transcribes them with its own speech model and
  rewrites the summary with its notes model, and that replaces the phone's draft. Typed My notes are never touched.
- Search across everything offline (SQLite FTS5 on the phone).
- Ask across meetings: offline with Apple's model over the best-matching passages; when connected, the question goes to
  the computer's Ask, which answers with sources.
- An always-visible connection and sync status: "Connected to MacBook · Synced just now", "Syncing 12 meetings…",
  "Not on the same Wi-Fi · last synced 2 h ago", "Not paired".
- The phone's copy is protected at rest by iOS Data Protection (complete) and an optional Face ID lock.

## Non-goals (v1)

- More than one computer per phone, or more than one phone per computer (the computer keeps the latest pairing).
- Sync away from the local network (no relay, no cloud).
- Android, iPad-specific layouts, widgets, Watch, Live Activities.
- Calendar on the phone, call detection, speaker names on the phone, MCP on the phone, voice splitting.
- App Store release (TestFlight/App Store later). v1 is installed from Xcode onto the person's own iPhone.

## Anti-goals

- Anything that lets someone on the same Wi-Fi read or change meetings without the pairing code.
- A connection that silently fails: the person must always be able to tell whether they are connected and synced.
- Losing anything typed on either side because of sync.

## Constraints

- Desktop rules from the repo apply to the desktop half: TDD, plain words, every visible string wrapped in `t()` and
  translated in every locale table, pinned dependencies at least 14 days old, cross-platform (the companion server must
  run on Mac, Windows and Linux; it is off until a phone is paired).
- The desktop's local network port is only reachable on the LAN; it answers nothing before a valid Noise handshake from
  the paired phone's static key, except the pairing exchange, which is only accepted while the person has the pairing
  screen open (2 minutes, 5 attempts, then a new code).
- This Mac has no iOS simulator runtime: Swift logic lives in a Swift package (`YogurtKit`) tested with `swift test` on
  macOS; the app target must compile for `iphoneos`. The person signs and installs on their own iPhone.

## Approaches considered

- **A. Native Swift app restyled to match desktop (chosen).** Best for background recording, Apple speech and
  Foundation Models, Face ID, Keychain, Bonjour; native feel. Cost: screens are built a second time.
- B. Wrap the desktop React UI in Capacitor. Same look nearly free, but web-view feel, desktop layouts need rework for a
  phone, and every native capability needs a plugin anyway.
- React Native: dropped; reuses no desktop UI (it is DOM) and is not native in the same way as A.

## How it works

### Pairing

1. Desktop → Settings → Phone → "Pair a phone": the companion server starts (if not already), advertises
   `_yogurt._tcp` with a TXT record (`v=1`, `id=<desktop id>`, `name=<computer name>`, `pairing=1`) and shows a 6-digit
   code (2 minutes, regenerated after 5 wrong attempts).
2. Phone: lists computers in pairing mode; the person picks one and types the code.
3. CPace over the TCP connection with PRS = code, channel identifier = `yogurt-pair-v1` + both random session ids.
   The resulting ISK keys an XChaCha20-Poly1305 exchange of each side's long-term X25519 public key and display name,
   with key confirmation in both directions. A wrong code fails confirmation and counts as an attempt.
4. Desktop stores the phone's public key and name (secrets encrypted with Electron safeStorage); phone stores its own
   private key and the desktop's public key and id in the Keychain (this device only, after first unlock).

### Sessions

- Every later connection: Bonjour to find the desktop by id (or the last known host/port), TCP, Noise KK handshake (both
  static keys known), then length-prefixed Noise transport messages (≤ 65535 bytes each; larger payloads chunked).
- Application messages are JSON `{id, type, body}` with request/response and server push (`changed`).
- A rekey after 1 GiB or 1 hour; idle sessions are closed after 2 minutes without a ping.

### Sync protocol

- The desktop keeps a monotonic change log (`companion_changes(seq, entity, entity_id)`) filled by store writes
  (meetings, notes, segments, folders, folder membership, people). The phone asks `pull {since}` and receives full
  current records for each changed entity, paged, plus the new cursor; deletions are explicit tombstones.
- Phone edits are operations: `setMine {meetingId, text, baseHash}`, `rename`, `addToFolder`, `removeFromFolder`,
  `trash`, `restore`. The desktop applies them through the same functions as its own UI. If `baseHash` no longer
  matches (edited on both), the desktop keeps its text and appends the phone's under a "From your iPhone" heading, so
  nothing is lost.
- Phone recordings: `uploadMeeting {id, title, startedAt, endedAt, myNotes, transcript[], summary}` then the audio in
  chunks; the desktop creates the meeting with the same id, saves the audio, transcribes it and writes notes; the result
  comes back through the change log and replaces the phone's draft.
- `ask {question, scope}` → the desktop's Ask (non-streaming, with sources). `audio {meetingId}` streams a recording.

### Phone app

- Screens: Pairing; Home (meetings by day, folders, the sync status pill); Note (Summary / My notes / Transcript, edit
  My notes, title, folders); Record (timer, level, live transcript, My notes, stop → draft summary); Search; Ask;
  Settings (connected computer, sync now, unpair, Face ID lock, storage).
- Local store: SQLite (system SQLite3, FTS5) in the app's container with complete file protection.
- Status model: `notPaired`, `searching`, `connecting`, `connected(syncing: n?)`, `offline(lastSync)`, `error(message)`.

## Left to the builder

File layout inside `ios/` and `app/src/main/companion/`, exact SwiftUI composition, message field names beyond the
ones above, chunk sizes, retry and backoff, how the status pill animates, the exact Foundation Models prompts.
