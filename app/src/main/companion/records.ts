import { createHash } from 'node:crypto'
import type { Store } from '../store'
import { renameMeeting } from '../meeting'
import { moveToTrash } from '../trash'

/**
 * What the iPhone receives on `pull`, and the edits it sends back as `op`s. The change log is the companion_changes
 * table (triggers in store.ts); each record is read fresh from the store, so a phone always gets the current state.
 *
 * Records, by entity (id in brackets):
 * - meeting [meeting id]: { id, title, startedAt, endedAt, attendees: [{ name, email }], app, trashedAt, language }
 *   startedAt/endedAt/trashedAt are ms since 1970; trashedAt null unless it is in the Trash (it can be restored there).
 * - notes [meeting id]: { meetingId, mine, summary, mineHash }: mine is My notes, summary the written notes (enhanced,
 *   null until written); mineHash = notesHash(mine), the baseHash a setMine op sends back.
 * - segments [meeting id]: { meetingId, segments: [{ startMs, endMs, speaker, text }] }: the whole transcript in order,
 *   hidden echo lines left out; speaker 'me' on the mic, the call's name for the other side, null for Them.
 * - folder [folder id]: { id, name, createdAt }
 * - folderMembers [folder id]: { folderId, meetingIds }: trashed meetings stay listed (a restore puts them back).
 * - people [email]: { email, displayName }: a name the person gave someone, null for none.
 * A thing that no longer exists comes as { entity, id, deleted: true }, a meeting deleted for good from the Trash too.
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

/** Heading over the phone's My notes when both sides changed them while apart; neither text is lost. */
export const FROM_IPHONE = '\n\n## From your iPhone\n\n'

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
    case 'segments':
      return store.meeting(id) && { meetingId: id, segments: store.segments(id).map((s) => ({ startMs: s.startMs, endMs: s.endMs, speaker: s.speaker, text: s.text })) }
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

/** The changes after `since`, oldest first, at most `limit`; cursor is the `since` for the next pull. */
export function changesSince(store: Store, since: number, limit: number): { changes: Change[]; cursor: number; more: boolean } {
  const rows = store.db.prepare('SELECT seq, entity, entity_id FROM companion_changes WHERE seq > ? ORDER BY seq LIMIT ?').all(since, limit + 1)
  const page = rows.slice(0, limit)
  const changes = page.map((r): Change => {
    const entity = String(r.entity) as Entity, id = String(r.entity_id)
    const rec = record(store, entity, id)
    return rec ? { entity, id, record: rec } : { entity, id, deleted: true }
  })
  return { changes, cursor: page.length ? Number(page.at(-1)!.seq) : since, more: rows.length > limit }
}

/** An edit from the phone, through the same functions the desktop's own UI uses. Throws 'gone', 'recording' or 'bad-op'. */
export function applyOp(store: Store, op: Op, deps: OpDeps): { applied: true; merged?: true } {
  const meeting = store.meeting(op.meetingId)
  if (!meeting) throw new Error('gone')
  switch (op.kind) {
    case 'setMine': {
      if (typeof op.text !== 'string') throw new Error('bad-op')
      const desk = store.notes(op.meetingId).mine
      if (op.baseHash === notesHash(desk) || notesHash(op.text) === notesHash(desk)) {
        deps.notesRewrite(op.meetingId, op.text)
        return { applied: true }
      }
      // both sides changed: the desktop's text stays, the phone's goes under it (once, however often it is sent)
      if (op.text.trim() && !desk.normalize('NFC').includes(op.text.normalize('NFC'))) deps.notesRewrite(op.meetingId, desk.trim() ? desk.trimEnd() + FROM_IPHONE + op.text : op.text)
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
