import { SPOKEN } from '../../shared/spoken'
import { isLocale, LOCALES } from '../../shared/i18n'
import { MAX_TERM, MAX_TERMS } from '../../shared/jargon'
import { REWRITE_NOTE_MAX } from '../../shared/rewriteNote'
import { NOTES_MAX } from '../notes'
import { TITLE_MAX, PEOPLE_MAX } from '../meeting'
import { Refusal, day, list, oneOf, people, str, type Args } from './args'
import type { Ctx, SaveOutcome, Tool } from './server'

/**
 * The changes an AI app can make, only with "Let AI apps make changes" on in Settings: filing, renaming, notes,
 * recording and a few settings. Each goes through the function behind the app's own button. Nothing here deletes a
 * meeting or its audio for good, empties the Trash, or touches privacy, permission or AI-app settings.
 */

const id = { type: 'string', description: 'The meeting id, from list_meetings or search' }
const folder = { type: 'string', description: 'The folder: its id or name, from list_folders' }
/** a change the person may want to confirm first; destructive: it replaces or removes something */
const change = (destructive = false) => ({ readOnlyHint: false, destructiveHint: destructive, idempotentHint: false, openWorldHint: false })
const tool = (name: string, description: string, properties: object, required: string[] = [], destructive = false): Tool =>
  ({ name, description, inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) }, annotations: change(destructive) })

export const changeTools: Tool[] = [
  tool('create_folder', 'Makes a new folder for filing meetings. Gives its id and name.', { name: { type: 'string', description: 'At most 200 characters' } }, ['name']),
  tool('rename_folder', 'Renames a folder.', { folder, name: { type: 'string', description: 'The new name, at most 200 characters' } }, ['folder', 'name']),
  tool('delete_folder', 'Deletes a folder. Its meetings stay, just no longer filed in it.', { folder }, ['folder'], true),
  tool('add_to_folder', 'Files a meeting in a folder (a meeting can be in several).', { folder, id }, ['folder', 'id']),
  tool('remove_from_folder', 'Takes a meeting out of a folder. The meeting stays.', { folder, id }, ['folder', 'id']),
  tool('accept_folder_suggestion', "Files a meeting in the folder Yogurt suggests for it (get_meeting's suggested_folder).", { id }, ['id']),
  tool('dismiss_folder_suggestion', 'Turns down the folder Yogurt suggests for a meeting, so it stops offering it.', { id }, ['id']),
  tool('rename_meeting', "Gives a meeting the person's own title.", { id, title: { type: 'string', description: 'At most 200 characters' } }, ['id', 'title']),
  tool('set_attendees', 'Sets who was in a meeting, replacing the list. Unedited summaries are written again with the new people.',
    { id, attendees: { type: 'array', description: `At most ${PEOPLE_MAX}`, items: { type: 'object', properties: { name: { type: 'string' }, email: { type: 'string' } }, required: ['name'] } } }, ['id', 'attendees'], true),
  tool('link_calendar_event', "Links a meeting to a calendar event (event_id from upcoming_meetings or calendar_day): it takes the event's title and people, unless the person set their own.",
    { id, event_id: { type: 'string' }, date: { type: 'string', description: "The event's day, like 2026-11-03 (the meeting's own day when left out)" } }, ['id', 'event_id']),
  tool('unlink_calendar_event', "Unlinks a meeting from its calendar event. Its title, people and notes stay.", { id }, ['id']),
  tool('trash_meeting', 'Moves a meeting to the Trash, where it can be restored for 30 days (restore_meeting). Never while it records.', { id }, ['id'], true),
  tool('restore_meeting', 'Brings a meeting back from the Trash (ids from list_trash).', { id: { type: 'string', description: 'The meeting id, from list_trash' } }, ['id']),
  tool('set_my_notes', "Writes the person's own notes for a meeting (Markdown). mode \"replace\" (default) replaces them, \"append\" adds after them.",
    { id, markdown: { type: 'string' }, mode: { type: 'string', enum: ['replace', 'append'] } }, ['id', 'markdown'], true),
  tool('set_summary', "Replaces Yogurt's written summary of a meeting with this Markdown. It counts as the person's edit, so Yogurt won't rewrite it by itself.",
    { id, markdown: { type: 'string' } }, ['id', 'markdown'], true),
  tool('rewrite_summary', "Has Yogurt write a meeting's summary again from its transcript and notes, like its Write again button, optionally with an instruction (\"shorter\", \"focus on decisions\"). It replaces the summary there is, and takes a while: get_meeting shows it once done.",
    { id, instruction: { type: 'string', description: `At most ${REWRITE_NOTE_MAX} characters` } }, ['id'], true),
  tool('start_recording', "Starts taking notes of a call now: Yogurt records the microphone and the call's sound on this computer and transcribes it. Optional title, or event_id (from upcoming_meetings) to take notes for that calendar event. Only one recording at a time. The person should have asked for it: everyone in the call should know they are recorded.",
    { title: { type: 'string', description: 'At most 200 characters' }, event_id: { type: 'string' } }),
  tool('pause_recording', 'Pauses the recording (id: the meeting recording now, the one recording when left out).', { id }),
  tool('resume_recording', 'Carries on a paused recording.', { id }),
  tool('stop_recording', 'Stops the recording. Yogurt then finishes the transcript and writes the summary.', { id }, [], true),
  tool('set_custom_words', `Sets the custom words Yogurt spells right in transcripts and notes (names, products, acronyms), replacing the list: at most ${MAX_TERMS}, each at most ${MAX_TERM} characters. Gives the list kept.`,
    { words: { type: 'array', items: { type: 'string' } } }, ['words'], true),
  tool('set_spoken_language', 'Sets the language spoken in meetings: "en" (English), "es" (Spanish), "pt" (Portuguese), or "multi" (any language, heard per meeting).',
    { language: { type: 'string', enum: SPOKEN } }, ['language']),
  tool('set_summary_language', `Sets the language Yogurt writes new summaries in: a language id (${LOCALES.map((l) => l.id).join(', ')}), or "" for each meeting's own language.`,
    { language: { type: 'string' } }, ['language']),
]

const saved = (what: string, r: SaveOutcome) => {
  if (r === 'saved') return
  throw new Refusal(r === 'busy' ? `Yogurt is writing this meeting's summary right now. Try again once it's done.`
    : r === 'too-long' ? `That ${what} is too long: at most ${NOTES_MAX} characters.` : `Yogurt couldn't save the ${what}. Try again.`)
}

export function changeHandlers({ d, meetingOf, folderOf, summary, log }: Ctx): Record<string, (a: Args) => Promise<string>> {
  const s = d.store
  const folderNamed = (a: Args) => { const f = folderOf(str(a, 'folder', { max: 200, required: true })); if (!f) throw new Refusal('folder is needed.'); return f }
  const name = (a: Args) => str(a, 'name', { max: 200, required: true })!.replace(/\s+/g, ' ')
  const folders = () => { d.app.changed('folders') }
  /** a meeting that may record now: the one asked for, or the one recording */
  const recordingOf = (a: Args) => {
    const want = str(a, 'id', { max: 64 })
    const cur = d.app.recording()
    if (!cur) throw new Refusal('Yogurt is not recording.')
    if (want && want !== cur.id) throw new Refusal(`That meeting is not the one recording. Yogurt is recording ${JSON.stringify(cur.title)} (${cur.id}).`)
    return cur
  }
  const ok = (v: object) => JSON.stringify(v, null, 2)
  return {
    async create_folder(a) {
      const n = name(a)
      const same = s.folders().find((f) => f.name.toLowerCase() === n.toLowerCase())
      if (same) throw new Refusal(`There is already a folder called ${JSON.stringify(same.name)} (id ${same.id}).`)
      const f = s.createFolder(n)
      folders()
      log(`create_folder made ${f.id}`)
      return ok({ id: f.id, name: f.name })
    },
    async rename_folder(a) {
      const f = folderNamed(a), n = name(a)
      s.renameFolder(f.id, n); folders()
      return ok({ id: f.id, name: s.folder(f.id)?.name ?? n })
    },
    async delete_folder(a) {
      const f = folderNamed(a)
      s.deleteFolder(f.id); folders()
      return `Deleted the folder ${JSON.stringify(f.name)}. Its ${f.count} meetings stay.`
    },
    async add_to_folder(a) {
      const f = folderNamed(a), m = meetingOf(a.id)
      s.addToFolder(f.id, m.id); folders()
      return ok(summary(s.meeting(m.id)!))
    },
    async remove_from_folder(a) {
      const f = folderNamed(a), m = meetingOf(a.id)
      s.removeFromFolder(f.id, m.id); folders()
      return ok(summary(s.meeting(m.id)!))
    },
    async accept_folder_suggestion(a) {
      const m = meetingOf(a.id)
      const sug = s.folderSuggestion(m.id)
      const f = !s.foldersOf(m.id).length && sug.state === 'pending' && sug.folderId ? s.folder(sug.folderId) : undefined
      if (!f) throw new Refusal('Yogurt has no folder suggestion for this meeting. add_to_folder files it anywhere.')
      s.addToFolder(f.id, m.id); folders()
      return ok(summary(s.meeting(m.id)!))
    },
    async dismiss_folder_suggestion(a) {
      const m = meetingOf(a.id)
      s.dismissFolderSuggestion(m.id); folders()
      return 'Yogurt no longer suggests a folder for this meeting.'
    },
    async rename_meeting(a) {
      const m = meetingOf(a.id)
      const title = str(a, 'title', { max: TITLE_MAX, required: true })!
      if (!d.app.rename(m.id, title)) throw new Refusal("Yogurt couldn't rename that meeting.")
      return ok(summary(s.meeting(m.id)!))
    },
    async set_attendees(a) {
      const m = meetingOf(a.id)
      const who = people(list(a, 'attendees', { max: PEOPLE_MAX, required: true })!, 'attendees')
      if (!d.app.setAttendees(m.id, who)) throw new Refusal("Yogurt couldn't change who was in that meeting.")
      return ok(summary(s.meeting(m.id)!))
    },
    async link_calendar_event(a) {
      const m = meetingOf(a.id)
      const eventId = str(a, 'event_id', { max: 1024, required: true })!
      if (!(await d.app.linkEvent(m.id, eventId, day(a, 'date')))) throw new Refusal('That event is not on the calendar that day. upcoming_meetings or calendar_day gives the event ids.')
      return ok(summary(s.meeting(m.id)!))
    },
    async unlink_calendar_event(a) {
      const m = meetingOf(a.id)
      if (!m.eventId) throw new Refusal('That meeting is not linked to a calendar event.')
      d.app.unlinkEvent(m.id)
      return ok(summary(s.meeting(m.id)!))
    },
    async trash_meeting(a) {
      const m = meetingOf(a.id)
      const r = d.app.trash(m.id)
      if (r === 'recording') throw new Refusal('That meeting is recording. Stop it first (stop_recording).')
      if (r !== 'trashed') throw new Refusal("Yogurt couldn't move that meeting to the Trash right now. Try again in a moment.")
      return `Moved ${JSON.stringify(m.title)} to the Trash. restore_meeting brings it back for 30 days.`
    },
    async restore_meeting(a) {
      const want = str(a, 'id', { max: 64, required: true })!
      const m = s.meeting(want)
      if (!m || m.trashedAt == null) throw new Refusal(`No meeting with id ${JSON.stringify(want)} in the Trash. list_trash gives the ids.`)
      d.app.restore(m.id)
      return ok(summary(s.meeting(m.id)!))
    },
    async set_my_notes(a) {
      const m = meetingOf(a.id)
      const md = str(a, 'markdown', { max: NOTES_MAX, required: true, keepSpace: true })!
      const mode = oneOf(a, 'mode', ['replace', 'append'] as const) ?? 'replace'
      const was = s.notes(m.id).mine
      saved('notes', d.app.setMyNotes(m.id, mode === 'append' && was.trim() ? `${was.replace(/\s+$/, '')}\n\n${md}` : md))
      return ok({ id: m.id, myNotes: s.notes(m.id).mine })
    },
    async set_summary(a) {
      const m = meetingOf(a.id)
      if (m.state === 'recording') throw new Refusal('That meeting is recording. Its summary is written once it stops.')
      saved('summary', d.app.setSummary(m.id, str(a, 'markdown', { max: NOTES_MAX, required: true, keepSpace: true })!))
      return ok({ id: m.id, summary: s.notes(m.id).enhanced })
    },
    async rewrite_summary(a) {
      const m = meetingOf(a.id)
      if (m.state === 'recording') throw new Refusal('That meeting is recording. Its summary is written once it stops.')
      const instruction = str(a, 'instruction', { max: REWRITE_NOTE_MAX }) ?? ''
      if (d.app.rewriteSummary(m.id, instruction) === 'busy') throw new Refusal('Yogurt is still working on this meeting (its transcript or summary). Try again once it is done.')
      return d.app.notesReady() ? 'Yogurt is writing the summary again. get_meeting shows it once done, usually within a minute or two.'
        : "Yogurt will write the summary once its notes model has downloaded."
    },
    async start_recording(a) {
      const title = str(a, 'title', { max: TITLE_MAX })
      const eventId = str(a, 'event_id', { max: 1024 })
      const cur = d.app.recording()
      if (cur) throw new Refusal(`Yogurt is already recording ${JSON.stringify(cur.title)} (${cur.id}). Stop it first (stop_recording).`)
      const r = await d.app.startRecording({ ...(title ? { title } : {}), ...(eventId ? { eventId } : {}) })
      if ('error' in r) throw new Refusal(r.error === 'gone' ? 'That event is not coming up on the calendar any more. upcoming_meetings gives the events.' : "Yogurt couldn't start recording. Try again.")
      log(`start_recording made ${r.id}`)
      return ok({ ...summary(s.meeting(r.id)!), recording: true })
    },
    async pause_recording(a) {
      const m = recordingOf(a)
      if (!d.app.pauseRecording(m.id, true)) throw new Refusal('The recording is already paused.')
      return `Paused recording ${JSON.stringify(m.title)}.`
    },
    async resume_recording(a) {
      const m = recordingOf(a)
      if (!d.app.pauseRecording(m.id, false)) throw new Refusal('The recording is not paused.')
      return `Recording ${JSON.stringify(m.title)} again.`
    },
    async stop_recording(a) {
      const m = recordingOf(a)
      if (!d.app.stopRecording(m.id)) throw new Refusal("Yogurt couldn't stop the recording. Try again.")
      return `Stopped recording ${JSON.stringify(m.title)} (${m.id}). Yogurt is finishing the transcript and writing the summary: get_meeting shows them once done.`
    },
    async set_custom_words(a) {
      const words = list(a, 'words', { max: MAX_TERMS, required: true })!
      if (words.some((w) => typeof w !== 'string')) throw new Refusal('words must be a list of text.')
      return ok({ custom_words: d.app.setJargon(words as string[]) })
    },
    async set_spoken_language(a) {
      const v = oneOf(a, 'language', SPOKEN)
      if (!v) throw new Refusal('language is needed: "en", "es", "pt", or "multi".')
      d.app.setSpoken(v)
      return `Meetings are now heard as ${v === 'multi' ? 'any language' : v === 'en' ? 'English only' : v}.`
    },
    async set_summary_language(a) {
      const v = str(a, 'language', { max: 16 })
      if (v === undefined || (v !== '' && !isLocale(v))) throw new Refusal(`language must be one of: ${LOCALES.map((l) => `${l.id} (${l.english})`).join(', ')}, or "" for each meeting's own language.`)
      d.app.setSummaryLanguage(v)
      return v ? `New summaries are written in ${LOCALES.find((l) => l.id === v)!.english}.` : "New summaries are written in each meeting's own language."
    },
  }
}
