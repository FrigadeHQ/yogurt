import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type Store } from '../src/main/store'
import { initMeetings } from '../src/main/meeting'
import { ready } from '../src/main/companion/sodium'
import { generateKeyPair, type KeyPair } from '../src/main/companion/noise'
import { notesHash } from '../src/main/companion/records'
import { createCompanion, type Companion, type CompanionDeps } from '../src/main/companion'
import { pairAsPhone, raw, session } from './helpers/companionClient'

beforeAll(() => ready())

const open: { c: Companion; dir: string }[] = []
afterEach(async () => {
  for (const { c, dir } of open.splice(0)) { await c.stop(); rmSync(dir, { recursive: true, force: true }) }
})

const base = { endedAt: 2000, eventId: null, app: null, attendees: [], state: 'done' as const }

/** A companion with a phone already paired */
async function paired(o: Partial<CompanionDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'companion-server-'))
  const store: Store = o.store ?? openStore(':memory:')
  initMeetings(store)
  const lines: string[] = []
  const c = await createCompanion({
    store, userDataDir: dir, seal: (s) => 'sealed:' + s, open: (s) => s.slice(7),
    ask: async () => ({ answer: '', sources: [] }), importRecording: async () => {}, audioFiles: async () => [],
    deviceName: () => 'Test Mac', appVersion: '9.9.9', log: (...p) => lines.push(p.join(' ')),
    ops: { notesRewrite: (id, mine) => store.setNotes(id, { mine }) },
    host: '127.0.0.1', advertiser: { publish: () => {}, stop: () => {} }, pollMs: 20,
    ...o,
  })
  open.push({ c, dir })
  const phone = generateKeyPair()
  const { code } = await c.startPairing()
  const r = await pairAsPhone(c.port()!, code, phone)
  expect(r.result.type).toBe('pairOk')
  const desktopKey = r.desktop!.key
  const connect = (key: KeyPair = phone) => session(c.port()!, key, desktopKey)
  const requests = () => lines.filter((l) => /COMPANION (pull|ask|upload|imported|audio)/.test(l))
  return { c, store, dir, phone, desktopKey, connect, lines, requests }
}

const frame = (payload: Uint8Array) => { const b = Buffer.alloc(2 + payload.length); b.writeUInt16BE(payload.length); b.set(payload, 2); return b }

describe('companion sessions', () => {
  it('answers hello and pull over Noise KK with the paired key', async () => {
    const { c, store, connect } = await paired()
    const m = store.createMeeting({ ...base, title: 'Kiwi review', startedAt: 1000 })
    const s = await connect()
    const hello = await s.request('hello', { appVersion: '1.0', schema: 1 })
    expect(hello).toMatchObject({ type: 'ok', body: { desktopId: c.desktopId, desktopName: 'Test Mac', desktopVersion: '9.9.9' } })
    expect(typeof (hello.body as { epoch: string }).epoch).toBe('string')
    const pull = await s.request('pull', { since: 0, limit: 100 })
    expect(pull.type).toBe('ok')
    const body = pull.body as { changes: { entity: string; id: string }[]; cursor: number; more: boolean; epoch: string }
    expect(body.epoch).toBe((hello.body as { epoch: string }).epoch)
    expect(body.changes).toContainEqual(expect.objectContaining({ entity: 'meeting', id: m.id }))
    expect(body.more).toBe(false)
    expect(c.status()).toMatchObject({ connected: true, paired: { name: 'Test iPhone' } })
    expect(c.status().paired!.lastSeen).not.toBeNull()
    s.close()
    await expect.poll(() => c.status().connected).toBe(false)
  })

  it('a big reply comes in chunks and is put back together', async () => {
    const { store, connect } = await paired()
    const m = store.createMeeting({ ...base, title: 'Long one', startedAt: 1000 })
    store.addSegments(Array.from({ length: 400 }, (_, i) => ({ meetingId: m.id, track: 'me' as const, startMs: i * 1000, endMs: i * 1000 + 900, text: 'made-up words '.repeat(30), speaker: 'me' })))
    const s = await connect()
    const pull = await s.request('pull', { since: 0, limit: 100 })
    const seg = (pull.body as { changes: { entity: string; record: { segments: unknown[] } }[] }).changes.find((x) => x.entity === 'segments')!
    expect(seg.record.segments).toHaveLength(400)
    // a big request from the phone works the same way
    const ok = await s.request('op', { kind: 'setMine', meetingId: m.id, text: 'x'.repeat(200_000), baseHash: notesHash('') })
    expect(ok).toMatchObject({ type: 'ok', body: { applied: true } })
    expect(store.notes(m.id).mine).toHaveLength(200_000)
  })

  it('closes an unpaired key, a truncated frame and random bytes before any request, and keeps serving', async () => {
    const { c, connect, requests } = await paired({ limits: { handshakeMs: 300 } })
    // a phone that isn't the paired one
    await expect(connect(generateKeyPair())).rejects.toThrow()
    // half a frame, then nothing: closed by the handshake timeout
    const half = await raw(c.port()!)
    half.socket.write(Buffer.from([0x00, 0x64, 1, 2, 3]))
    await half.closed
    // random bytes in a well-formed frame
    const junk = await raw(c.port()!)
    junk.socket.write(frame(crypto.getRandomValues(new Uint8Array(80))))
    await junk.closed
    // a JSON frame that isn't a pairHello
    const json = await raw(c.port()!)
    json.sendJson({ id: '1', type: 'pull', body: { since: 0 } })
    await json.closed
    expect(requests()).toEqual([])
    const s = await connect()
    expect((await s.request('pull', { since: 0, limit: 1 })).type).toBe('ok')
  })

  it('a session that sends garbage after the handshake is closed; a newer session replaces the older one', async () => {
    const { c, connect } = await paired()
    const a = await connect()
    a.raw.socket.write(frame(crypto.getRandomValues(new Uint8Array(40))))
    await a.raw.closed
    const b = await connect()
    const d = await connect()
    await b.raw.closed
    expect((await d.request('hello', { appVersion: '1', schema: 1 })).type).toBe('ok')
    expect(c.status().connected).toBe(true)
  })

  it('answers ping with pong, and closes a session that stays quiet', async () => {
    const { connect } = await paired({ limits: { idleMs: 300 } })
    const s = await connect()
    await s.send({ id: 'p1', type: 'ping', body: {} })
    expect(await s.waitPush((m) => m.type === 'pong')).toMatchObject({ id: 'p1', type: 'pong' })
    await s.raw.closed
  })

  it('rekeys after the byte limit and carries on', async () => {
    const { connect, store } = await paired({ limits: { rekey: { bytes: 2000, ms: 3_600_000 } } })
    for (let i = 0; i < 5; i++) store.createMeeting({ ...base, title: `Meeting ${i}`, startedAt: 1000 + i })
    const s = await connect()
    for (let i = 0; i < 6; i++) expect((await s.request('pull', { since: 0, limit: 50 })).type).toBe('ok')
  })

  it('a bad request gets an error reply, not a closed connection', async () => {
    const { connect } = await paired()
    const s = await connect()
    expect(await s.request('pull', { since: -1 })).toMatchObject({ type: 'error', body: { code: 'bad-request' } })
    expect(await s.request('nope', {})).toMatchObject({ type: 'error', body: { code: 'unknown-type' } })
    expect(await s.request('hello', { schema: 2 })).toMatchObject({ type: 'error', body: { code: 'schema' } })
    expect(await s.request('op', { kind: 'rename', meetingId: 'missing', title: 'x' })).toMatchObject({ type: 'error', body: { code: 'gone' } })
    expect((await s.request('hello', { schema: 1 })).type).toBe('ok')
  })

  it('pushes changed after a store write', async () => {
    const { store, connect } = await paired()
    const s = await connect()
    await s.request('hello', { appVersion: '1', schema: 1 })
    store.createMeeting({ ...base, title: 'Fresh', startedAt: 5000 })
    const pushed = await s.waitPush((m) => m.type === 'changed')
    const cursor = (pushed.body as { cursor: number }).cursor
    const pull = await s.request('pull', { since: cursor - 1, limit: 10 })
    expect((pull.body as { changes: { record: { title: string } }[] }).changes[0].record.title).toBe('Fresh')
  })

  it('ops go through the desktop rules; a trash the desktop would refuse is refused', async () => {
    let blocked = true
    const trashed: string[] = []
    const store = openStore(':memory:')
    const { connect } = await paired({ store, ops: { notesRewrite: (id, mine) => store.setNotes(id, { mine }), trashBlocked: () => blocked, trashed: (id) => trashed.push(id) } })
    const m = store.createMeeting({ ...base, title: 'Plum', startedAt: 1000 })
    const s = await connect()
    expect(await s.request('op', { kind: 'setMine', meetingId: m.id, text: 'from the phone', baseHash: notesHash('') })).toMatchObject({ type: 'ok', body: { applied: true } })
    expect(store.notes(m.id).mine).toBe('from the phone')
    expect(await s.request('op', { kind: 'trash', meetingId: m.id })).toMatchObject({ type: 'error', body: { code: 'busy' } })
    blocked = false
    expect(await s.request('op', { kind: 'trash', meetingId: m.id })).toMatchObject({ type: 'ok' })
    expect(trashed).toEqual([m.id])
    expect(store.meeting(m.id)?.trashedAt).not.toBeNull()
  })

  it('an upload sent twice makes one meeting, imported once after all of its audio', async () => {
    const imported: { id: string; audio: string; notes: string }[] = []
    const store = openStore(':memory:')
    const { connect } = await paired({
      store,
      importRecording: async (meeting, audioPath, draft) => {
        imported.push({ id: meeting.id, audio: readFileSync(audioPath).toString(), notes: draft.myNotes })
        store.createMeeting({ ...base, title: meeting.title, startedAt: meeting.startedAt, source: 'audio-file' }, meeting.id)
      },
    })
    const meeting = { id: 'phone-meeting-1', title: 'Standup in the kitchen', startedAt: 1000, endedAt: 61_000, attendees: [] }
    const body = { meeting, myNotes: 'bring snacks', transcript: [{ startMs: 0, endMs: 900, text: 'made-up line' }] }
    const audio = ['first part,', 'second part,', 'last part']
    const chunk = (i: number) => ({ meetingId: meeting.id, chunk: Buffer.from(audio[i]).toString('base64'), index: i, of: audio.length, mime: 'audio/mp4' })
    let s = await connect()
    expect(await s.request('uploadMeeting', body)).toMatchObject({ type: 'ok', body: { accepted: true } })
    expect(await s.request('uploadAudio', chunk(0))).toMatchObject({ type: 'ok', body: { received: 0 } })
    // Wi-Fi drops mid-upload
    s.close()
    s = await connect()
    expect(await s.request('uploadMeeting', body)).toMatchObject({ type: 'ok', body: { accepted: true } })
    expect(await s.request('uploadAudio', chunk(1))).toMatchObject({ type: 'error', body: { code: 'order' } })
    for (const i of [0, 1]) expect(await s.request('uploadAudio', chunk(i))).toMatchObject({ type: 'ok', body: { received: i } })
    expect(imported).toEqual([])
    expect(await s.request('uploadAudio', chunk(2))).toMatchObject({ type: 'ok', body: { received: 2, done: true } })
    expect(imported).toEqual([{ id: meeting.id, audio: audio.join(''), notes: 'bring snacks' }])
    // sent once more (the reply was lost): nothing new
    expect(await s.request('uploadMeeting', body)).toMatchObject({ type: 'ok', body: { accepted: true, already: true } })
    expect(await s.request('uploadAudio', chunk(2))).toMatchObject({ type: 'ok', body: { done: true } })
    expect(imported).toHaveLength(1)
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM meetings WHERE id = ?').get(meeting.id)).toEqual({ n: 1 })
  })

  it('ask goes to the desktop Ask, with its scope', async () => {
    const asked: unknown[] = []
    const { connect } = await paired({ ask: async (q, scope) => { asked.push([q, scope]); return { answer: 'Tuesday [1]', sources: [{ meetingId: 'm1', title: 'Plan', atMs: 1200, text: 'we ship tuesday' }] } } })
    const s = await connect()
    const r = await s.request('ask', { question: 'When do we ship?', scope: { folderId: 'f1' } })
    expect(r).toMatchObject({ type: 'ok', body: { answer: 'Tuesday [1]', sources: [{ meetingId: 'm1', title: 'Plan', atMs: 1200, text: 'we ship tuesday' }] } })
    expect(asked).toEqual([['When do we ship?', { folderId: 'f1' }]])
  })

  it('streams a recording as audioChunks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'companion-audio-'))
    const file = join(dir, 'them.m4a')
    const bytes = randomBytes(100_000)
    writeFileSync(file, bytes)
    const store = openStore(':memory:')
    const m = store.createMeeting({ ...base, title: 'Audio', startedAt: 1000 })
    const { connect } = await paired({ store, audioFiles: async (id) => (id === m.id ? [{ track: 'them', path: file }] : []) })
    const s = await connect()
    await s.send({ id: 'a1', type: 'audio', body: { meetingId: m.id, track: 'them' } })
    const last = await s.waitPush((x) => x.type === 'audioChunk' && (x.body as { index: number; of: number }).index === (x.body as { of: number }).of - 1)
    const chunks = s.pushes.filter((x) => x.type === 'audioChunk' && x.id === 'a1').map((x) => x.body as { chunk: string; index: number; of: number })
    expect(chunks.map((x) => x.index)).toEqual([...Array((last.body as { of: number }).of).keys()])
    expect(Buffer.concat(chunks.map((x) => Buffer.from(x.chunk, 'base64')))).toEqual(Buffer.from(bytes))
    expect(await s.request('audio', { meetingId: m.id, track: 'me' })).toMatchObject({ type: 'error', body: { code: 'gone' } })
    rmSync(dir, { recursive: true, force: true })
  })

  it('logs ids and counts, never note text, names or keys', async () => {
    const { store, connect, lines, phone } = await paired()
    const m = store.createMeeting({ ...base, title: 'Secret project Zebra', startedAt: 1000 })
    store.setNotes(m.id, { mine: 'confidential words' })
    const s = await connect()
    await s.request('pull', { since: 0, limit: 100 })
    await s.request('op', { kind: 'setMine', meetingId: m.id, text: 'phone secret', baseHash: 'stale' })
    const all = lines.join('\n')
    for (const bad of ['Zebra', 'confidential', 'phone secret', 'Test iPhone', 'Test Mac', Buffer.from(phone.publicKey).toString('base64')]) expect(all).not.toContain(bad)
    expect(all).toContain('COMPANION')
  })

  it('a leftover upload folder is emptied at start', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'companion-left-'))
    const uploads = join(dir, 'companion-uploads')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(uploads, { recursive: true })
    writeFileSync(join(uploads, 'old.m4a'), 'x')
    const c = await createCompanion({
      store: openStore(':memory:'), userDataDir: dir, seal: (s) => s, open: (s) => s,
      ask: async () => ({ answer: '', sources: [] }), importRecording: async () => {}, audioFiles: async () => [],
      deviceName: () => 'Mac', log: () => {}, ops: { notesRewrite: () => {} }, host: '127.0.0.1', advertiser: { publish: () => {}, stop: () => {} },
    })
    open.push({ c, dir })
    await expect.poll(() => existsSync(join(uploads, 'old.m4a'))).toBe(false)
  })
})
