// The desktop's real companion server (src/main/companion) with a throwaway profile, for YogurtKit's interop tests:
// a temp userData folder, an in-memory store seeded with made-up meetings, a stub Ask, no Bonjour, localhost only.
//   node app/scripts/companion-server-harness.mjs
// Opens pairing and prints {"port", "code", "desktopId", "meetings": {name: id}} as one JSON line. Then each JSON line
// on stdin is a question answered on stdout: {"cmd":"meeting","id"} → {"meeting": {title, trashedAt}},
// {"cmd":"notes","id"} → {"notes": mine}, {"cmd":"add","title"} → {"added": id}. An import prints {"imported": id, bytes}.
// Exits when stdin closes. Never touches the real Yogurt profile. Not shipped; test use only.
import { build } from 'esbuild'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'

const src = join(dirname(fileURLToPath(import.meta.url)), '../src/main')
const dir = mkdtempSync(join(tmpdir(), 'companion-harness-'))
const cleanup = () => rmSync(dir, { recursive: true, force: true })
process.on('exit', cleanup)
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0))

// the modules use extensionless imports, so they're bundled first
const outfile = join(dir, 'harness.mjs')
await build({
  stdin: {
    contents: ["export { createCompanion } from './companion'", "export { openStore } from './store'", "export { initMeetings } from './meeting'"].join('\n'),
    resolveDir: src, loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'error',
  // the translation tables load through Vite's import.meta.glob; English (no tables) is all the harness needs
  define: { 'import.meta.glob': '__noGlob' }, // bundled CommonJS (bonjour-service) asks for Node's built-ins through require
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); const __noGlob = () => ({});" },
})
const { createCompanion, openStore, initMeetings } = await import(pathToFileURL(outfile).href)

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const store = openStore(':memory:')
initMeetings(store)
const base = { eventId: null, app: null, attendees: [], state: 'done' }
const banana = store.createMeeting({ ...base, title: 'Banana sync', startedAt: 1_700_000_000_000, endedAt: 1_700_000_600_000 })
store.setNotes(banana.id, { mine: 'buy apples', enhanced: '## Decisions\n- Bananas.' })
store.addSegments([
  { meetingId: banana.id, track: 'me', startMs: 0, endMs: 900, text: 'hello there', speaker: 'me' },
  { meetingId: banana.id, track: 'them', startMs: 1000, endMs: 1900, text: 'we chose bananas', speaker: null },
])
const cherry = store.createMeeting({ ...base, title: 'Cherry review', startedAt: 1_700_100_000_000, endedAt: 1_700_100_600_000 })
const fruit = store.createFolder('Fruit')
store.addToFolder(fruit.id, banana.id)
// a made-up "them" track for Banana sync, a few chunks long
const audio = join(dir, 'them.m4a')
writeFileSync(audio, Buffer.from(Array.from({ length: 100_000 }, (_, i) => i % 251)))

const companion = await createCompanion({
  store, userDataDir: dir,
  seal: (s) => s, open: (s) => s,
  ask: async (question) => ({ answer: `Made-up answer to: ${question}`, sources: [{ n: 1, meetingId: banana.id, title: 'Banana sync', atMs: 1200, text: 'we chose bananas' }] }),
  importRecording: async (meeting, path, draft) => {
    const bytes = statSync(path).size
    store.createMeeting({ ...base, title: meeting.title, startedAt: meeting.startedAt, endedAt: meeting.endedAt }, meeting.id)
    store.setNotes(meeting.id, { mine: draft.myNotes })
    out({ imported: meeting.id, bytes })
  },
  audioFiles: async (id) => id === banana.id ? [{ track: 'them', path: audio }] : [],
  deviceName: () => 'Harness Mac', appVersion: '0.0.0-harness', log: () => {},
  ops: { notesRewrite: (id, mine) => store.setNotes(id, { mine }) },
  host: '127.0.0.1', advertiser: { publish: () => {}, stop: () => {} }, pollMs: 50,
})
const { code } = await companion.startPairing()
out({ port: companion.port(), code, desktopId: companion.desktopId, meetings: { banana: banana.id, cherry: cherry.id }, folders: { fruit: fruit.id } })

const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const q = JSON.parse(line)
  if (q.cmd === 'meeting') { const m = store.meeting(q.id); out({ meeting: m && { title: m.title, trashedAt: m.trashedAt ?? null } }) }
  else if (q.cmd === 'notes') out({ notes: store.notes(q.id).mine })
  else if (q.cmd === 'add') out({ added: store.createMeeting({ ...base, title: q.title, startedAt: 1_700_200_000_000, endedAt: 1_700_200_600_000 }).id })
})
// the test owns this process: when it goes away, so does the harness
lines.on('close', async () => { await companion.stop(); process.exit(0) })
