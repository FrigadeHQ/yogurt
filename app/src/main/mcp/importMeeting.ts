import { NOTES_MAX } from '../notes'
import { TITLE_MAX, PEOPLE_MAX } from '../meeting'
import { Refusal, bool, list, people, str, time, type Args } from './args'
import type { Ctx, Tool } from './server'
import { parseTranscript, timedLines, toSegments, type ImportLine } from './transcriptImport'

/**
 * Meetings brought in from other notes apps (Granola, Otter, Fireflies, …) through an AI app that read them there.
 * They have no audio; they show, search and answer in Ask like meetings recorded here (source "import").
 */

/** the most lines one meeting brings, and one call across a batch */
export const IMPORT_LINES_MAX = 20_000
export const IMPORT_BATCH_MAX = 50
const BATCH_LINES_MAX = 50_000
const LINE_MAX = 10_000
const TEXT_MAX = 2_000_000

const meetingProps = {
  title: { type: 'string', description: `At most ${TITLE_MAX} characters` },
  started_at: { type: 'string', description: 'When it started, ISO time (2026-11-03T15:00:00Z)' },
  ended_at: { type: 'string', description: 'When it ended, ISO time; from the transcript when left out' },
  attendees: { type: 'array', description: `Who was in it, at most ${PEOPLE_MAX}`, items: { type: 'object', properties: { name: { type: 'string' }, email: { type: 'string' } }, required: ['name'] } },
  transcript: { type: 'string', description: 'The transcript as text, as the other app exports it: "[mm:ss] Name: words", "Name (00:12:34): words", "Name: words", or a "Name  0:05" line with the words under it. Words with no name stay unnamed.' },
  transcript_lines: { type: 'array', description: `The transcript as lines instead, at most ${IMPORT_LINES_MAX}`, items: { type: 'object', properties: { start_ms: { type: 'number' }, end_ms: { type: 'number' }, speaker: { type: 'string' }, text: { type: 'string' } }, required: ['text'] } },
  summary: { type: 'string', description: "The other app's summary (Markdown), kept as the meeting's summary" },
  my_notes: { type: 'string', description: "The person's own notes (Markdown)" },
  folder: { type: 'string', description: 'A folder to file it in: its id or name, from list_folders' },
  create_folder: { type: 'boolean', description: 'Make the folder when there is none by that name' },
  write_summary: { type: 'boolean', description: 'Have Yogurt write the summary from the transcript, instead of giving one' },
  source_id: { type: 'string', description: "The meeting's id in the other app: the same one is never brought in twice" },
}
const required = ['title', 'started_at']
const adding = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
export const importTools: Tool[] = [
  { name: 'create_meeting', description: "Brings one meeting into Yogurt from another notes app (Granola, Otter, Fireflies, …): title, start, people, the transcript (text or lines), and the other app's summary or Yogurt's own (write_summary). It has no recording. It shows in Yogurt, in search and in ask like a meeting recorded there. Gives its id.",
    inputSchema: { type: 'object', properties: meetingProps, required }, annotations: adding },
  { name: 'import_meetings', description: `Brings several meetings in at once, each as create_meeting takes it: at most ${IMPORT_BATCH_MAX} a call. Gives each one's id or why it was not brought in.`,
    inputSchema: { type: 'object', properties: { meetings: { type: 'array', items: { type: 'object', properties: meetingProps, required } } }, required: ['meetings'] }, annotations: adding },
]

/** lines given as JSON, checked one by one */
function linesOf(v: unknown[]): ImportLine[] {
  return v.map((l, i) => {
    if (!l || typeof l !== 'object') throw new Refusal(`transcript_lines[${i}] must be an object with text.`)
    const a = l as Args
    const ms = (key: string) => {
      const x = a[key]
      if (x === undefined || x === null) return null
      if (typeof x !== 'number' || !Number.isFinite(x) || x < 0) throw new Refusal(`transcript_lines[${i}].${key} must be a number of ms from the start, 0 or more.`)
      return Math.round(x)
    }
    const speaker = str(a, 'speaker', { max: 200 })
    return { startMs: ms('start_ms'), endMs: ms('end_ms'), speaker: speaker || null, text: str(a, 'text', { max: LINE_MAX, required: true })! }
  })
}

export function importHandlers({ d, folderOf, log }: Ctx): Record<string, (a: Args) => Promise<string>> {
  const s = d.store
  /** one meeting, checked whole before anything is saved */
  const check = (a: Args) => {
    const title = str(a, 'title', { max: TITLE_MAX, required: true })!.replace(/\s+/g, ' ')
    const startedAt = time(a, 'started_at', { required: true })!
    const endedAt = time(a, 'ended_at')
    if (endedAt != null && endedAt < startedAt) throw new Refusal('ended_at is before started_at.')
    const attendees = people(list(a, 'attendees', { max: PEOPLE_MAX }) ?? [], 'attendees')
    const text = str(a, 'transcript', { max: TEXT_MAX, keepSpace: true })
    const given = list(a, 'transcript_lines', { max: IMPORT_LINES_MAX })
    if (text && given) throw new Refusal('Give transcript or transcript_lines, not both.')
    const lines = given ? linesOf(given) : text ? parseTranscript(text) : []
    if (lines.length > IMPORT_LINES_MAX) throw new Refusal(`The transcript has ${lines.length} lines: at most ${IMPORT_LINES_MAX}.`)
    const summary = str(a, 'summary', { max: NOTES_MAX, keepSpace: true })
    const mine = str(a, 'my_notes', { max: NOTES_MAX, keepSpace: true })
    const writeSummary = bool(a, 'write_summary') === true
    if (writeSummary && summary?.trim()) throw new Refusal('Give a summary or write_summary, not both.')
    if (writeSummary && !lines.length && !mine?.trim()) throw new Refusal('write_summary needs a transcript or my_notes to write from.')
    if (!lines.length && !summary?.trim() && !mine?.trim()) throw new Refusal('Give a transcript, a summary or my_notes: a meeting with nothing in it is not brought in.')
    const sourceId = str(a, 'source_id', { max: 200 })
    const createFolder = bool(a, 'create_folder') === true
    const folderName = str(a, 'folder', { max: 200 })
    let folder: ReturnType<typeof folderOf>
    try { folder = folderOf(folderName) } catch (e) { if (!(e instanceof Refusal) || !createFolder) throw e }
    return { title, startedAt, endedAt, attendees, lines, summary: summary?.trim() ? summary : null, mine: mine ?? '', writeSummary, sourceId, folder, newFolder: !folder && createFolder ? folderName : undefined }
  }
  const save = (m: ReturnType<typeof check>) => {
    // Avoid timing a long transcript again when a client retries a completed batch.
    const previous = m.sourceId && s.meetingFromSource('import', m.sourceId)
    if (previous) return { id: previous.id, title: previous.title, already_imported: true }
    const timed = timedLines(m.lines)
    let f = m.folder
    const { meeting, added } = s.importMeeting({ ...m, endedAt: m.endedAt ?? m.startedAt + (timed.at(-1)?.endMs ?? 0) }, (created) => {
      if (timed.length) s.addSegments(toSegments(created.id, timed, d.me()))
      if (!f && m.newFolder) f = s.folders().find((x) => x.name.toLowerCase() === m.newFolder!.toLowerCase()) ?? s.createFolder(m.newFolder)
      if (f) s.addToFolder(f.id, created.id)
    })
    if (!added) return { id: meeting.id, title: meeting.title, already_imported: true }
    log(`create_meeting made ${meeting.id}: ${timed.length} lines${m.summary ? ', a summary' : ''}${f ? `, in ${f.id}` : ''}`)
    d.app.imported(meeting.id)
    if (f) d.app.changed('folders')
    if (m.writeSummary) d.app.rewriteSummary(meeting.id, '')
    return { id: meeting.id, title: meeting.title, start: new Date(meeting.startedAt).toISOString(), lines: timed.length, folder: f ? { id: f.id, name: f.name } : null,
      summary: m.summary ? 'given' : m.writeSummary ? (d.app.notesReady() ? 'Yogurt is writing it' : 'Yogurt writes it once its notes model has downloaded') : 'none' }
  }
  return {
    async create_meeting(a) { return JSON.stringify(save(check(a)), null, 2) },
    async import_meetings(a) {
      const all = list(a, 'meetings', { max: IMPORT_BATCH_MAX, required: true })!
      const checked = all.map((m, i) => {
        if (!m || typeof m !== 'object' || Array.isArray(m)) return { index: i, error: 'Each meeting must be an object, as create_meeting takes it.' }
        try { return { index: i, meeting: check(m as Args) } } catch (e) { if (e instanceof Refusal) return { index: i, error: e.message }; throw e }
      })
      const total = checked.reduce((n, c) => n + ('meeting' in c && c.meeting ? c.meeting.lines.length : 0), 0)
      if (total > BATCH_LINES_MAX) throw new Refusal(`These meetings have ${total} transcript lines together: at most ${BATCH_LINES_MAX} a call. Send fewer at a time.`)
      return JSON.stringify(checked.map((c) => ('meeting' in c && c.meeting ? { index: c.index, ...save(c.meeting) } : c)), null, 2)
    },
  }
}
