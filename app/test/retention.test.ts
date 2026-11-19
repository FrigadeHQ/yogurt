import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type Store } from '../src/main/store'
import { Library } from '../src/main/library/store'
import { dueNow, isDue, retentionOf, retentionPatch, ruleOf, sweep } from '../src/main/retention'
import { retentionDays } from '../src/shared/retention'
import { hookNotes } from '../src/main/notes'
import { createQueue } from '../src/main/notes/queue'
import { summaryAction } from '../src/renderer/src/components/NoteMenu'

const DAY = 24 * 60 * 60 * 1000, NOW = 1000 * DAY
const dirs: string[] = [], stores: Store[] = []
afterEach(() => { stores.splice(0).forEach((s) => s.close()); dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })) })
function fresh(): Store {
  const d = mkdtempSync(join(tmpdir(), 'yogurt-retention-')); dirs.push(d)
  const s = openStore(join(d, 'yogurt.db')); stores.push(s)
  return s
}
/** a finished meeting that ended `daysAgo` before NOW, with a transcript and a summary unless told otherwise */
function meeting(s: Store, daysAgo: number, o: { transcript?: boolean; summary?: boolean; state?: 'stopped' | 'done' | 'recording' } = {}) {
  const endedAt = NOW - daysAgo * DAY
  const m = s.createMeeting({ title: `Ended ${daysAgo} days ago`, startedAt: endedAt - 1000, endedAt, eventId: null, app: null, attendees: [], state: o.state ?? 'done' })
  if (o.transcript !== false) s.addSegments([
    { meetingId: m.id, track: 'them', startMs: 0, endMs: 900, text: 'the papaya shipment', speaker: null },
    { meetingId: m.id, track: 'me', startMs: 0, endMs: 900, text: 'an echo', speaker: null, hidden: true },
  ])
  s.setNotes(m.id, { mine: 'kiwi', ...(o.summary !== false ? { enhanced: '## Mango\nBudget agreed' } : {}) })
  return m
}

describe('the rules', () => {
  it('keep everything until picked; a picked rule replaces the audio switch from before rules', () => {
    expect(retentionOf({})).toEqual({ audio: null, video: null, transcript: null, meeting: null })
    expect(ruleOf({ keepRecordings: false, recordingsOffAt: 5 }, 'audio')).toEqual({ days: 0, after: 5 })
    expect(ruleOf({ keepRecordings: false }, 'audio')).toBeNull()
    expect(ruleOf({ keepRecordings: false, recordingsOffAt: 5, audioDays: 30 }, 'audio')).toEqual({ days: 30 })
    expect(retentionPatch('audio', 30)).toEqual({ audioDays: 30, keepRecordings: undefined, recordingsOffAt: undefined })
    expect(retentionPatch('meeting', null)).toEqual({ meetingDays: undefined })
  })
  it('take whole days up to ten years; only audio (once the summary is saved) and video (not kept) take 0', () => {
    expect(retentionDays('audio', 0)).toBe(0)
    expect(retentionDays('video', 0)).toBe(0)
    expect(retentionDays('transcript', 0)).toBeNull()
    expect(retentionDays('meeting', 3650)).toBe(3650)
    for (const v of [3651, -1, 1.5, '30', null, NaN]) expect(retentionDays('transcript', v)).toBeNull()
  })
  it('a meeting is due once the days since it ended have passed, and never while it has no end', () => {
    expect(isDue({ days: 30 }, NOW - 30 * DAY, NOW)).toBe(true)
    expect(isDue({ days: 30 }, NOW - 29 * DAY, NOW)).toBe(false)
    expect(isDue({ days: 0, after: NOW - 2 }, NOW - 1, NOW)).toBe(true)
    expect(isDue({ days: 0, after: NOW - 2 }, NOW - 3, NOW)).toBe(false)
    expect(isDue({ days: 0 }, null, NOW)).toBe(false)
    expect(isDue(null, 0, NOW)).toBe(false)
  })
})

describe('what a rule acts on', () => {
  it('audio and transcripts only from finished meetings with a saved transcript and summary; whole meetings once finished', () => {
    const s = fresh()
    const old = meeting(s, 40), recent = meeting(s, 10), noSummary = meeting(s, 40, { summary: false }), noLines = meeting(s, 40, { transcript: false })
    const live = meeting(s, 40, { state: 'recording' }), trashed = meeting(s, 40)
    s.trashMeeting(trashed.id, NOW)
    const due = (kind: 'audio' | 'transcript' | 'meeting') => dueNow({ store: s, hasAudio: () => true, hasVideo: () => true }, kind, { days: 30 }, NOW)
    expect(due('audio')).toEqual([old.id])
    expect(due('transcript')).toEqual([old.id])
    expect(due('meeting').sort()).toEqual([old.id, noSummary.id, noLines.id].sort())
    expect(dueNow({ store: s, hasAudio: () => false, hasVideo: () => false }, 'audio', { days: 30 }, NOW)).toEqual([])
    expect(dueNow({ store: s, hasAudio: () => true, hasVideo: () => true }, 'audio', { days: 0 }, NOW).sort()).toEqual([old.id, recent.id].sort())
    void live
  })
  it('a deleted transcript goes for good, hidden lines and the library copy too, and its notes stay', () => {
    const s = fresh(), m = meeting(s, 40), lib = new Library(s.db)
    lib.setChunks(m.id, 'sig', [], [{ startMs: 0, endMs: 900, text: 'the papaya shipment', speakers: [] }])
    s.deleteTranscript(m.id, NOW)
    expect(s.segments(m.id, { hidden: true })).toEqual([])
    expect(s.db.prepare('SELECT count(*) AS n FROM library_chunks WHERE meeting_id = ?').get(m.id)).toEqual({ n: 0 })
    expect(s.search('papaya', 10)).toEqual([])
    expect(s.search('mango', 10).map((h) => h.meetingId)).toEqual([m.id])
    expect(s.notes(m.id)).toMatchObject({ mine: 'kiwi', enhanced: '## Mango\nBudget agreed' })
    expect(s.meeting(m.id)?.transcriptDeletedAt).toBe(NOW)
    expect(dueNow({ store: s, hasAudio: () => true, hasVideo: () => true }, 'transcript', { days: 30 }, NOW)).toEqual([])
  })
  it('a database from before rules gets its column, with nothing deleted', () => {
    const s = fresh()
    s.db.exec('ALTER TABLE meetings DROP COLUMN transcript_deleted_at')
    s.db.prepare("INSERT INTO meetings (id, title, started_at, state) VALUES ('old1', 'Old', 1, 'done')").run()
    const file = (s.db.prepare('PRAGMA database_list').get() as { file: string }).file
    s.close(); stores.splice(stores.indexOf(s), 1)
    const again = openStore(file); stores.push(again)
    expect(again.meeting('old1')?.transcriptDeletedAt).toBeUndefined()
  })
})

describe('the sweep', () => {
  it('trashes first, then deletes transcripts after their audio, then audio; what fails is tried next time', async () => {
    const s = fresh()
    const ancient = meeting(s, 400), old = meeting(s, 101), stuck = meeting(s, 100), recent = meeting(s, 40), fresh1 = meeting(s, 5)
    const calls: string[] = []
    const d = {
      store: s, hasAudio: () => true, hasVideo: (id: string) => id === recent.id, removeVideo: (id: string) => { calls.push(`video ${id}`) },
      removeAudio: vi.fn(async (id: string) => { calls.push(`audio ${id}`); return id === stuck.id ? 'failed' as const : 'deleted' as const }),
      removeTranscript: (id: string) => { calls.push(`transcript ${id}`); s.deleteTranscript(id, NOW) },
      trash: (id: string) => { calls.push(`trash ${id}`); s.trashMeeting(id, NOW) },
    }
    await sweep({ ...d, settings: { meetingDays: 365, transcriptDays: 90, audioDays: 30, videoDays: 30 } }, NOW)
    // old has no transcript left, so nothing of it is due for audio again
    expect(calls).toEqual([`trash ${ancient.id}`, `audio ${old.id}`, `transcript ${old.id}`, `audio ${stuck.id}`, `audio ${stuck.id}`, `audio ${recent.id}`, `video ${recent.id}`])
    expect(s.segments(stuck.id)).toHaveLength(1)
    expect(s.segments(fresh1.id)).toHaveLength(1)
  })
  it('keeps everything when no rule is picked', async () => {
    const s = fresh(); meeting(s, 4000)
    const d = { store: s, hasAudio: () => true, hasVideo: () => true, removeAudio: vi.fn(), removeTranscript: vi.fn(), trash: vi.fn(), removeVideo: vi.fn() }
    await sweep({ ...d, settings: {} }, NOW)
    expect([d.removeAudio, d.removeTranscript, d.trash, d.removeVideo].map((f) => f.mock.calls.length)).toEqual([0, 0, 0, 0])
  })
})

describe('a meeting whose transcript was deleted', () => {
  it('keeps its summary: Write again and new people do not rewrite it from typed notes alone', async () => {
    const s = fresh(), m = meeting(s, 40)
    s.deleteTranscript(m.id, NOW)
    const chat = vi.fn(async () => 'rewritten')
    const notes = hookNotes({ store: s, queue: createQueue({ recording: () => false, smallMac: false }), model: { llm: async () => ({ contextSize: 32_000, count: async (xs: string[]) => xs.map((x) => x.length), chat }) },
      language: () => null, transcribed: async () => {}, onStop: () => {}, send: () => {}, changed: () => {}, summarized: () => {}, peopleRewriteMs: 0 })
    await notes.writeAgain(m.id)
    s.updateMeeting(m.id, { attendees: [{ name: 'Ann', email: 'ann@example.com' }] })
    notes.applyPeople(m.id)
    await new Promise((r) => setTimeout(r, 20))
    expect(chat).not.toHaveBeenCalled()
    expect(s.notes(m.id).enhanced).toBe('## Mango\nBudget agreed')
    expect(summaryAction({ hasSummary: true, hasContent: true, recording: false, busy: false, downloading: false, trashed: false, transcriptDeleted: true })).toBeUndefined()
  })
})
