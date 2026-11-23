import { createHash } from 'node:crypto'
import type { Store } from '../store'
import { renameMeeting } from '../meeting'
import { moveToTrash } from '../trash'
import { FROM_IPHONE } from '../../shared/companion'
import { AUDIO_SPEAKER } from '../../shared/audioUpload'

/**
 * What the iPhone receives on `pull`, and the edits it sends back as `op`s. The change log is the companion_changes
 * table (triggers in store.ts); each record is read fresh from the store, so a phone always gets the current state.
 *
 * Records, by entity (id in brackets):
 * - meeting [meeting id]: { id, title, startedAt, endedAt, attendees: [{ name, email }], app, trashedAt, language }
 *   startedAt/endedAt/trashedAt are ms since 1970; trashedAt null unless it is in the Trash (it can be restored there).
 * - notes [meeting id]: { meetingId, mine, summary, mineHash }: mine is My notes, summary the written notes (enhanced,
 *   null until written); mineHash = notesHash(mine), the baseHash a setMine op sends back.
 * - segments [meeting id]: { meetingId, oneMic, segments: [{ startMs, endMs, speaker, text }] }: the whole transcript in
 *   order, hidden echo lines left out; speaker 'me' on the mic, the call's name for the other side, null for Them.
 *   oneMic: one microphone in a room (an uploaded file or a phone recording), so every speaker is null.
 * - folder [folder id]: { id, name, createdAt }
 * - folderMembers [folder id]: { folderId, meetingIds }: trashed meetings stay listed (a restore puts them back).
 * - people [email]: { email, displayName }: a name the person gave someone, null for none.
 * A thing that no longer exists comes as { entity, id, deleted: true }, a meeting deleted for good from the Trash too.
 *
 * pull replies { changes, cursor, more, epoch }: epoch is a random id made once per log (companion_meta). A phone whose
 * kept epoch differs (this Mac's database was replaced or started afresh) drops its cursor and pulls from 0.
 */
export type Entity = 'meeting' | 'notes' | 'segments' | 'folder' | 'folderMembers' | 'people'
export type Change = { entity: Entity; id: string; deleted?: true; record?: object }
export type Op = { kind: 'setMine' | 'rename' | 'addToFolder' | 'removeFromFolder' | 'trash' | 'restore'; meetingId: string; folderId?: string; text?: string; title?: string; baseHash?: string }
export type OpDeps = {
  /** saves My notes the way the editor does (the notes module), so an open note shows the phone's text */
  notesRewrite: (meetingId: string, mine: string) => void
  nowMs: () => number
  /** after a change, for the windows and the search index to follow (index.ts does the same after its own IPC) */
  trashed?: (meetingId: string) => void
  restored?: (meetingId: string) => void
  foldersChanged?: () => void
}

/** Heading over the phone's My notes when both sides changed them while apart (shared with the editor). */
export { FROM_IPHONE }

/** sha256 hex of the NFC text: the same notes typed on either side hash the same */
export const notesHash = (text: string) => createHash('sha256').update(text.normalize('NFC'), 'utf8').digest('hex')

function record(store: Store, entity: Entity, id: string): object | undefined {
  switch (entity) {
    case 'meeting': {
      const m = store.meeting(id)
      return m && { id: m.id, title: m.title, startedAt: m.startedAt, endedAt: m.endedAt, attendees: m.attendees, app: m.app, trashedAt: m.trashedAt ?? null, language: m.language }
    }
    case 'notes': {
      if (!store.meeting(id)) return undefined
      const n = store.notes(id)
      return { meetingId: id, mine: n.mine, summary: n.enhanced, mineHash: notesHash(n.mine) }
    }
    case 'segments': {
      const m = store.meeting(id)
      // one microphone in a room (an uploaded file, a phone recording): nobody is named, and the phone doesn't run
      // its lines together by speaker
      return m && { meetingId: id, oneMic: m.source === 'audio-file',
        segments: store.segments(id).map((s) => ({ startMs: s.startMs, endMs: s.endMs, speaker: s.speaker === AUDIO_SPEAKER ? null : s.speaker, text: s.text })) }
    }
    case 'folder': {
      const f = store.folder(id)
      return f && { id: f.id, name: f.name, createdAt: f.createdAt }
    }
    case 'folderMembers':
      if (!store.folder(id)) return undefined
      return { folderId: id, meetingIds: (store.db.prepare('SELECT meeting_id FROM folder_meetings WHERE folder_id = ? ORDER BY added_at, meeting_id').all(id)).map((r) => String(r.meeting_id)) }
    case 'people': {
      const p = store.db.prepare('SELECT email, display_name FROM people WHERE email = ?').get(id)
      return p && { email: String(p.email), displayName: p.display_name == null ? null : String(p.display_name) }
    }
  }
}

/** At most this many changes in one pull, and about this many bytes of records (one huge transcript still goes alone) */
export const PAGE_MAX = 500
export const PAGE_BYTES = 1_000_000

/**
 * The changes after `since`, oldest first, at most `limit` (clamped to 1..PAGE_MAX) and about PAGE_BYTES; cursor is
 * the `since` for the next pull. epoch names this log: when it differs from the one the phone kept, it pulls from 0.
 */
export function changesSince(store: Store, since: number, limit: number): { changes: Change[]; cursor: number; more: boolean; epoch: string } {
  const max = Math.min(PAGE_MAX, Math.max(1, Math.floor(limit) || 1))
  const epoch = String(store.db.prepare("SELECT value FROM companion_meta WHERE key = 'epoch'").get()?.value)
  const rows = store.db.prepare('SELECT seq, entity, entity_id FROM companion_changes WHERE seq > ? ORDER BY seq LIMIT ?').all(since, max + 1)
  const changes: Change[] = []
  let cursor = since, bytes = 0
  for (const r of rows.slice(0, max)) {
    const entity = String(r.entity) as Entity, id = String(r.entity_id)
    const rec = record(store, entity, id)
    const change: Change = rec ? { entity, id, record: rec } : { entity, id, deleted: true }
    const size = Buffer.byteLength(JSON.stringify(change))
    if (changes.length && bytes + size > PAGE_BYTES) break
    changes.push(change); bytes += size; cursor = Number(r.seq)
  }
  return { changes, cursor, more: rows.some((r) => Number(r.seq) > cursor), epoch }
}

/** An edit from the phone, through the same functions the desktop's own UI uses. Throws 'gone', 'recording' or 'bad-op'. */
export function applyOp(store: Store, op: Op, deps: OpDeps): { applied: true; merged?: true } {
  const meeting = store.meeting(op.meetingId)
  if (!meeting) throw new Error('gone')
  switch (op.kind) {
    case 'setMine': {
      if (typeof op.text !== 'string') throw new Error('bad-op')
      const desk = store.notes(op.meetingId).mine
      // the same text: nothing to write, and no change to echo back to the phone
      if (notesHash(op.text) === notesHash(desk)) return { applied: true }
      if (op.baseHash === notesHash(desk)) {
        deps.notesRewrite(op.meetingId, op.text)
        return { applied: true }
      }
      // both sides changed: the desktop's text stays, the phone's goes under it. Only its own block counts as already
      // there (a retry): last, or followed by another block. A short phone text inside the desktop's words ("ok" in
      // "book"), or one that only starts an earlier block ("phone" of "phone edit"), is still added.
      const block = (FROM_IPHONE + op.text).normalize('NFC'), there = desk.normalize('NFC')
      const retry = there.endsWith(block) || there.includes(block + FROM_IPHONE)
      if (op.text.trim() && !retry) deps.notesRewrite(op.meetingId, desk.trim() ? desk.trimEnd() + FROM_IPHONE + op.text : op.text)
      return { applied: true, merged: true }
    }
    case 'rename':
      if (typeof op.title !== 'string' || !renameMeeting(op.meetingId, op.title)) throw new Error('bad-op')
      return { applied: true }
    case 'addToFolder':
    case 'removeFromFolder':
      if (!op.folderId || !store.folder(op.folderId)) throw new Error('gone')
      if (op.kind === 'addToFolder') store.addToFolder(op.folderId, op.meetingId)
      else store.removeFromFolder(op.folderId, op.meetingId)
      deps.foldersChanged?.()
      return { applied: true }
    case 'trash': {
      const r = moveToTrash(op.meetingId, { store: { meeting: (id) => store.meeting(id), trashMeeting: (id) => store.trashMeeting(id, deps.nowMs()) }, moved: (id) => deps.trashed?.(id) })
      if (r !== 'trashed') throw new Error(r === 'recording' ? 'recording' : 'gone')
      return { applied: true }
    }
    case 'restore':
      if (meeting.trashedAt != null) { store.restoreMeeting(op.meetingId); deps.restored?.(op.meetingId) }
      return { applied: true }
    default:
      throw new Error('bad-op')
  }
}
