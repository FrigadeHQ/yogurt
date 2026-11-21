// What a paired phone can ask for once its Noise session is up. Requests are {id, type, body}; each gets
// {id, type: "ok" | "error", body} (an error body is {code}), except `audio`, which answers with audioChunk messages.
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rm, stat, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import type { Store } from '../store'
import { applyOp, changesSince, type Op, type OpDeps } from './records'
import { CHUNK_BYTES } from './frames'

export type Scope = { folderId?: string; meetingIds?: string[] }
/** n: the number the answer's [n] citations use for it */
export type AskSource = { n: number; meetingId: string; title: string; atMs?: number | null; text: string }

/** An Ask turn's sources as the phone gets them, each with its citation number */
export const askSources = (sources: { n: number; meetingId: string; title: string; atMs: number | null; excerpt?: string }[]): AskSource[] =>
  sources.map((s) => ({ n: s.n, meetingId: s.meetingId, title: s.title, atMs: s.atMs, text: s.excerpt ?? '' }))
/** titleSource: 'default' for the phone's "Meeting at 3:04 PM", 'model' when Apple's model wrote it, 'typed' when the person did */
export type UploadMeeting = { id: string; title: string; titleSource: 'default' | 'model' | 'typed'; startedAt: number; endedAt: number; attendees: { name: string; email: string | null }[] }
export type PhoneDraft = { myNotes: string; transcript: { startMs: number; endMs: number; text: string }[]; summary?: string }

export type HandlerDeps = {
  store: Store
  ask: (question: string, scope?: Scope) => Promise<{ answer: string; sources: AskSource[] }>
  /** makes the meeting with the phone's id from its audio; called once per meeting */
  importRecording: (meeting: UploadMeeting, audioPath: string, phoneDraft: PhoneDraft) => Promise<void>
  audioFiles: (meetingId: string) => Promise<{ track: 'me' | 'them'; path: string }[]>
  ops: Omit<OpDeps, 'nowMs'> & { /** a trash the desktop's own UI would refuse right now (saving, resuming) */ trashBlocked?: (meetingId: string) => boolean }
  now: () => number
  log: (...parts: unknown[]) => void
}

export type Hello = { desktopId: string; desktopName: string; desktopVersion: string }

/** Where an upload's audio collects until all of it is in */
export const MAX_AUDIO = 2 * 1024 ** 3
const MAX_CHUNKS = Math.ceil(MAX_AUDIO / 1024)
const ID = /^[\w-]{1,64}$/
// names Windows keeps for devices: companion-uploads/NUL.m4a would write nowhere
const DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)$/i
/** uploads staged at once (each can be up to MAX_AUDIO on disk) */
const MAX_UPLOADS = 4

export class RequestError extends Error {}
/** an error's kind for the log: messages can hold paths with the person's name in them */
const why = (err: unknown) => String((err as NodeJS.ErrnoException)?.code ?? (err as Error)?.name ?? 'error')
const bad = () => new RequestError('bad-request')

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown, max: number): string => { if (typeof v !== 'string' || v.length > max) throw bad(); return v }
const id = (v: unknown): string => { if (typeof v !== 'string' || !ID.test(v) || DEVICE.test(v)) throw bad(); return v }
const int = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number => { if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > max) throw bad(); return v as number }
const ms = (v: unknown): number => int(v, 0, 8.64e15)

function scopeOf(v: unknown): Scope | undefined {
  if (v === undefined || v === null) return undefined
  if (!isObject(v)) throw bad()
  const out: Scope = {}
  if (v.folderId !== undefined) out.folderId = id(v.folderId)
  if (v.meetingIds !== undefined) {
    if (!Array.isArray(v.meetingIds) || v.meetingIds.length > 500) throw bad()
    out.meetingIds = v.meetingIds.map(id)
  }
  return out
}

function meetingOf(v: unknown): UploadMeeting {
  if (!isObject(v)) throw bad()
  const startedAt = ms(v.startedAt), endedAt = ms(v.endedAt)
  if (endedAt < startedAt) throw bad()
  const attendees = v.attendees ?? []
  if (!Array.isArray(attendees) || attendees.length > 200) throw bad()
  return {
    id: id(v.id), title: str(v.title, 200).trim() || 'Recording', startedAt, endedAt,
    // anything else (left out, or from a newer phone) counts as the default title
    titleSource: v.titleSource === 'model' || v.titleSource === 'typed' ? v.titleSource : 'default',
    attendees: attendees.map((a) => {
      if (!isObject(a)) throw bad()
      return { name: str(a.name ?? '', 200), email: a.email == null ? null : str(a.email, 320) }
    }),
  }
}

function draftOf(body: Record<string, unknown>): PhoneDraft {
  const transcript = body.transcript ?? []
  if (!Array.isArray(transcript) || transcript.length > 100_000) throw bad()
  return {
    myNotes: str(body.myNotes ?? '', 1_000_000),
    transcript: transcript.map((s) => {
      if (!isObject(s)) throw bad()
      return { startMs: int(s.startMs), endMs: int(s.endMs), text: str(s.text, 100_000) }
    }),
    ...(body.summary == null ? {} : { summary: str(body.summary, 1_000_000) }),
  }
}

type Upload = { meeting: UploadMeeting; draft: PhoneDraft; file?: FileHandle; base: string; path: string; mime: string; next: number; of: number; size: number }
/** what a phone may send: WAV (16 kHz mono, every platform transcribes it), or m4a from an older phone (Mac only) */
const AUDIO_TYPES: Record<string, string> = { 'audio/wav': '.wav', 'audio/mp4': '.m4a' }

/** One phone's requests. `uploadDir` holds audio being received; it's emptied when the handlers are made. */
export function createHandlers(d: HandlerDeps & { hello: () => Hello; uploadDir: string }) {
  const uploads = new Map<string, Upload>()
  /** imports running now: a re-sent upload waits for its import to say whether the meeting really is in */
  const importing = new Map<string, Promise<void>>()
  /** true once the meeting is in for good; false when an import was running and failed (the phone sends it again) */
  const imported = async (meetingId: string): Promise<boolean> => {
    const running = importing.get(meetingId)
    if (running) return running.then(() => true, () => false)
    return !!d.store.meeting(meetingId)
  }
  const cleared = rm(d.uploadDir, { recursive: true, force: true }).catch(() => {})

  const drop = async (u: Upload) => {
    await u.file?.close().catch(() => {})
    u.file = undefined
    await rm(u.path, { force: true }).catch(() => {})
  }

  async function uploadMeeting(body: Record<string, unknown>) {
    const meeting = meetingOf(body.meeting)
    const draft = draftOf(body)
    // sent again after a dropped connection: the meeting is made once. imported only when it is really in; until
    // then the phone keeps its copy
    if (await imported(meeting.id)) return { accepted: true, imported: true }
    const old = uploads.get(meeting.id)
    if (old) await drop(old)
    else if (uploads.size >= MAX_UPLOADS) throw new RequestError('busy')
    await cleared
    await mkdir(d.uploadDir, { recursive: true })
    const base = join(d.uploadDir, `${meeting.id}-${randomUUID()}`)
    uploads.set(meeting.id, { meeting, draft, base, path: `${base}.m4a`, mime: 'audio/mp4', next: 0, of: 0, size: 0 })
    d.log('COMPANION', 'upload', meeting.id)
    return { accepted: true }
  }

  async function uploadAudio(body: Record<string, unknown>) {
    const meetingId = id(body.meetingId)
    const index = int(body.index, 0, MAX_CHUNKS), of = int(body.of, 1, MAX_CHUNKS)
    const mime = body.mime === undefined ? 'audio/mp4' : body.mime
    if (index >= of || typeof mime !== 'string' || !AUDIO_TYPES[mime]) throw bad()
    if (importing.has(meetingId)) {
      if (await imported(meetingId)) return { received: index, done: true, imported: true }
      throw new RequestError('gone')
    }
    if (d.store.meeting(meetingId)) return { received: index, done: true, imported: true }
    const u = uploads.get(meetingId)
    if (!u) throw new RequestError('gone')
    const chunk = Buffer.from(str(body.chunk, 4 * CHUNK_BYTES), 'base64')
    // index 0 starts the audio over (a resumed upload); otherwise chunks come in order, a repeat of the last is fine
    if (index === 0) { await drop(u); u.mime = mime; u.path = u.base + AUDIO_TYPES[mime]; u.file = await open(u.path, 'w'); u.next = 0; u.size = 0; u.of = of }
    else if (mime !== u.mime) throw bad()
    else if (index === u.next - 1 && of === u.of) return { received: index }
    else if (index !== u.next || of !== u.of || !u.file) throw new RequestError('order')
    u.size += chunk.length
    if (u.size > MAX_AUDIO) { await drop(u); uploads.delete(meetingId); throw new RequestError('too-big') }
    await u.file!.write(chunk)
    u.next = index + 1
    if (u.next < of) return { received: index }
    await u.file!.sync(); await u.file!.close(); u.file = undefined
    uploads.delete(meetingId)
    const job = d.importRecording(u.meeting, u.path, u.draft)
    importing.set(meetingId, job)
    try {
      await job
      d.log('COMPANION', 'imported', meetingId, `chunks=${of}`)
    } catch (err) {
      d.log('COMPANION', 'import failed', meetingId, why(err))
      throw new RequestError('failed')
    } finally {
      importing.delete(meetingId)
      await rm(u.path, { force: true }).catch(() => {})
    }
    return { received: index, done: true, imported: true }
  }

  async function op(body: Record<string, unknown>) {
    const kinds = ['setMine', 'rename', 'addToFolder', 'removeFromFolder', 'trash', 'restore']
    if (typeof body.kind !== 'string' || !kinds.includes(body.kind)) throw bad()
    const o: Op = {
      kind: body.kind as Op['kind'], meetingId: id(body.meetingId),
      ...(body.folderId !== undefined ? { folderId: id(body.folderId) } : {}),
      ...(body.text !== undefined ? { text: str(body.text, 1_000_000) } : {}),
      ...(body.title !== undefined ? { title: str(body.title, 200) } : {}),
      ...(body.baseHash !== undefined ? { baseHash: str(body.baseHash, 64) } : {}),
    }
    if (o.kind === 'trash' && d.ops.trashBlocked?.(o.meetingId)) throw new RequestError('busy')
    try {
      return applyOp(d.store, o, { ...d.ops, nowMs: d.now })
    } catch (err) {
      const code = (err as Error).message
      throw new RequestError(['gone', 'recording', 'bad-op'].includes(code) ? code : 'failed')
    }
  }

  /** Streams one track as audioChunk messages under the request's id */
  async function audio(reqId: string, body: Record<string, unknown>, send: (m: object) => Promise<void>) {
    const meetingId = id(body.meetingId)
    if (body.track !== 'me' && body.track !== 'them') throw bad()
    const m = d.store.meeting(meetingId)
    if (!m || m.trashedAt != null) throw new RequestError('gone')
    const file = (await d.audioFiles(meetingId)).find((f) => f.track === body.track)
    if (!file) throw new RequestError('gone')
    const { size } = await stat(file.path)
    const of = Math.max(1, Math.ceil(size / CHUNK_BYTES))
    let index = 0
    for await (const part of createReadStream(file.path, { highWaterMark: CHUNK_BYTES })) {
      await send({ id: reqId, type: 'audioChunk', body: { chunk: (part as Buffer).toString('base64'), index: index++, of } })
    }
    if (index === 0) await send({ id: reqId, type: 'audioChunk', body: { chunk: '', index: 0, of: 1 } })
    d.log('COMPANION', 'audio', meetingId, `chunks=${of}`)
  }

  /** Answers one request; long ones (ask, audio) are awaited by the caller off the main queue. */
  async function handle(msg: Record<string, unknown>, send: (m: object) => Promise<void>): Promise<void> {
    const reqId = typeof msg.id === 'string' && msg.id.length <= 64 ? msg.id : null
    if (reqId === null) throw new Error('handlers: request without an id')
    const body = isObject(msg.body) ? msg.body : {}
    const ok = (b: object) => send({ id: reqId, type: 'ok', body: b })
    try {
      switch (msg.type) {
        case 'hello': {
          if (body.schema !== 1) throw new RequestError('schema')
          return await ok({ ...d.hello(), epoch: changesSince(d.store, Number.MAX_SAFE_INTEGER, 1).epoch })
        }
        case 'pull': {
          const since = int(body.since ?? 0), limit = int(body.limit ?? 200, 1, 10_000)
          const page = changesSince(d.store, since, limit)
          d.log('COMPANION', 'pull', `since=${since}`, `changes=${page.changes.length}`, `more=${page.more}`)
          return await ok(page)
        }
        case 'op': return await ok(await op(body))
        case 'uploadMeeting': return await ok(await uploadMeeting(body))
        case 'uploadAudio': return await ok(await uploadAudio(body))
        case 'ask': {
          const question = str(body.question, 4000)
          if (!question.trim()) throw bad()
          const r = await d.ask(question, scopeOf(body.scope))
          d.log('COMPANION', 'ask', `sources=${r.sources.length}`)
          return await ok(r)
        }
        case 'audio': return await audio(reqId, body, send)
        default: throw new RequestError('unknown-type')
      }
    } catch (err) {
      if (!(err instanceof RequestError)) d.log('COMPANION', 'request failed', String(msg.type).slice(0, 20), why(err))
      await send({ id: reqId, type: 'error', body: { code: err instanceof RequestError ? err.message : 'failed' } })
    }
  }

  return {
    handle,
    /** the connection went: audio half received is dropped (the phone sends it again from the start) */
    async reset() {
      // taken out first: an upload a new session stages meanwhile is its own
      const old = [...uploads.values()]
      uploads.clear()
      for (const u of old) await drop(u)
    },
  }
}
