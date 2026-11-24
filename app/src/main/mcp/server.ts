import { AUDIO_SPEAKER } from '../../shared/audioUpload'
import type { ContextChip } from '../../shared/askContext'
import { toMarkdownFile } from '../../shared/exportNotes'
import type { LibrarySource, StartResult } from '../../shared/types'
import type { CalEvent, CalendarStatus } from '../calendar'
import type { Meeting, Person, Store } from '../store'
import { Refusal, str, list, oneOf, day, type Args } from './args'
import { changeTools, changeHandlers } from './changes'
import { importTools, importHandlers } from './importMeeting'

/**
 * Yogurt as an MCP server, so an AI app on this Mac (Claude, Cursor, …) can use the person's meetings: JSON-RPC
 * messages in, answers out (socket.ts carries them; the yogurt-mcp helper connects the app to it).
 * Off until the person turns it on in Settings: until then every tool says where to turn it on and gives nothing.
 * Reading is all it does unless the person also lets AI apps make changes; then each change goes through the same
 * functions the app's own buttons use. Nothing is ever deleted for good: meetings go to the Trash.
 * Text here goes to the other app's model, never to Yogurt's interface, so it is not translated.
 */

type Track = 'me' | 'them'
export type SaveOutcome = 'saved' | 'busy' | 'too-long' | 'failed'
/** what the app does for AI apps: the functions behind its own buttons (index.ts), so nothing is done twice over */
export type McpApp = {
  ask(question: string, chips: ContextChip[]): Promise<{ unavailable: 'model' | 'recording' } | { answer: string; sources: LibrarySource[]; stopped?: true }>
  comingUp(): Promise<{ status: CalendarStatus; events: CalEvent[] }>
  calendarDay(at: number): Promise<{ status: CalendarStatus; events: CalEvent[] }>
  settings(): { myName: string; locale: string; spoken: 'en' | 'multi'; summaryLanguage: string; jargon: string[]; stopWhenCallEnds: boolean; keepRecordings: boolean }
  /** the windows hear that meetings or folders changed */
  changed(what: 'meetings' | 'folders'): void
  /** a meeting came in from another app: shown, searched and read for Ask like one recorded here */
  imported(id: string): void
  rename(id: string, title: string): boolean
  setAttendees(id: string, people: Person[]): boolean
  linkEvent(id: string, eventId: string, day?: number): Promise<boolean>
  unlinkEvent(id: string): boolean
  trash(id: string): 'trashed' | 'recording' | 'missing' | 'failed' | 'save-pending'
  restore(id: string): boolean
  setMyNotes(id: string, md: string): SaveOutcome
  setSummary(id: string, md: string): SaveOutcome
  /** "Write again", with the person's instruction if any */
  rewriteSummary(id: string, instruction: string): 'queued' | 'busy'
  notesReady(): boolean
  startRecording(o: { title?: string; eventId?: string }): Promise<StartResult>
  pauseRecording(id: string, paused: boolean): boolean
  stopRecording(id: string): boolean
  recording(): Meeting | null
  setJargon(terms: string[]): string[]
  setSpoken(v: 'en' | 'multi'): boolean
  setSummaryLanguage(v: string): boolean
}
export type McpDeps = {
  store: Store
  enabled: () => boolean
  /** Settings' "Let AI apps make changes": off unless the person turned it on */
  changesEnabled: () => boolean
  /** the person using Yogurt, by name: "You" means nothing to another app */
  me: () => string
  version: string
  /** a finished meeting's audio files (none while it records) */
  audio: (id: string) => Promise<Array<{ track: Track; path: string }>>
  app: McpApp
  /** the computer, for the words other apps' models read (a Mac when left out) */
  platform?: string
  /** main.log, which goes in public issues: ids and outcomes only, never names or words */
  log?: (line: string) => void
}
export type Mcp = { handle(msg: unknown): Promise<object | null> }
export type Tool = { name: string; description: string; inputSchema: object; annotations: object }

/** newest first: the app asked for one of these, it gets that one; otherwise the newest */
const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

export const idArg = { type: 'string', description: 'The meeting id, from list_meetings or search' }
export const folderArg = { type: 'string', description: 'A folder: its id or name, from list_folders' }
const inFolder = { type: 'string', description: 'Only meetings in this folder: its id or name, from list_folders' }
const person = { type: 'string', description: 'Only meetings with this person: their name or email, from list_people' }
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
/** The reading tools, in this computer's words: a Mac records AAC in .m4a, Windows and Linux Ogg Opus (a backup can bring either) */
const readTools = (platform: string): Tool[] => [
  { name: 'list_folders', description: 'The folders the person files meetings in: id, name and how many meetings each holds. Pass a folder to list_meetings or search to read only its meetings.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'list_meetings', description: 'Meetings recorded in Yogurt, newest first: id, title, start and end (ISO times), people invited (attendees: name and email from the calendar), call app, and the folders it is in. Optional query finds meetings by words in their title, transcript or notes; optional folder keeps only that folder\'s meetings; optional person keeps only meetings with them.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, folder: inFolder, person, limit: { type: 'number', description: 'Most to return (default 20, at most 100)' }, before: { type: 'string', description: 'Only meetings that started before this ISO time, to page back' } } } },
  { name: 'get_meeting', description: "One meeting: its details, its attendees with their emails, the calendar event it is linked to (calendar_event: title, start, end, calendar; null when none), the folder Yogurt suggests for it (suggested_folder, null when none), the notes the person typed (myNotes) and Yogurt's written summary (Markdown).",
    inputSchema: { type: 'object', properties: { id: idArg }, required: ['id'] } },
  { name: 'get_transcript', description: 'What was said in a meeting, line by line with who said it. format "text" (default): "[mm:ss] Name: words" lines. format "lines": JSON with start_ms, end_ms, speaker, is_me and text. "Them" is the other side of the call when the call app gave no name.',
    inputSchema: { type: 'object', properties: { id: idArg, format: { type: 'string', enum: ['text', 'lines'] } }, required: ['id'] } },
  { name: 'search', description: 'Finds words across every meeting (titles, transcripts, notes): meeting id, title, start and a snippet with the matched words in **bold**. Optional person keeps only meetings with them.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, folder: inFolder, person, limit: { type: 'number', description: 'Most meetings to return (default 20, at most 100)' } }, required: ['query'] } },
  { name: 'ask', description: "Yogurt answers a question from the person's meetings itself, on this computer, with numbered sources ([1], [2]) naming the meeting and the moment. Optional folder or meeting_ids limit what it reads. Slower than search (it writes an answer); use it for questions that need meetings read and put together.",
    inputSchema: { type: 'object', properties: { question: { type: 'string' }, folder: { type: 'string', description: 'Only meetings in this folder' }, meeting_ids: { type: 'array', items: { type: 'string' }, description: 'Only these meetings (at most 40)' } }, required: ['question'] } },
  { name: 'list_people', description: "The people in the person's meetings: name and email (null when the calendar gave none). Pass one as person to list_meetings or search.",
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'Most to return (default 200, at most 1000)' } } } },
  { name: 'upcoming_meetings', description: "What is on the person's calendar for the rest of today and tomorrow, soonest first: event_id, title, start, end, calendar, meeting_link (the call's address, null when none), attendees, and meeting_id when Yogurt already has notes for it.",
    inputSchema: { type: 'object', properties: {} } },
  { name: 'calendar_day', description: "The events on one day of the person's calendar, earliest first, the same way upcoming_meetings gives them.",
    inputSchema: { type: 'object', properties: { date: { type: 'string', description: 'The day, like 2026-11-03' } }, required: ['date'] } },
  { name: 'list_trash', description: 'Meetings in the Trash: id, title, start and when they were moved there. They are deleted for good 30 days after. restore_meeting brings one back.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'get_settings', description: "Yogurt's settings that shape notes: the person's name, the interface language, the language spoken in meetings, the language summaries are written in, custom words spelled right in transcripts, whether recording stops when a call ends, and whether audio is kept.",
    inputSchema: { type: 'object', properties: {} } },
  { name: 'export_meeting', description: "A meeting as one Markdown document, exactly as Yogurt's Export Markdown saves it: title, date, people, the notes, and the transcript. side \"summary\" (default) uses Yogurt's summary, \"my_notes\" the person's own notes.",
    inputSchema: { type: 'object', properties: { id: idArg, side: { type: 'string', enum: ['summary', 'my_notes'] } }, required: ['id'] } },
  { name: 'get_audio', description: platform === 'darwin'
    ? "A meeting's recording as files on this Mac: one per side (track me: the person's microphone; them: the other side of the call), AAC in .m4a. Gives paths, which apps on this Mac can open."
    : "A meeting's recording as files on this computer: one per side (track me: the person's microphone; them: the other side of the call), Ogg Opus in .ogg (AAC in .m4a for a meeting recorded on a Mac). Gives paths, which apps on this computer can open.",
    inputSchema: { type: 'object', properties: { id: idArg }, required: ['id'] } },
].map((t) => ({ ...t, annotations: readOnly }))
export const mcpTools = (platform: string): Tool[] => [...readTools(platform), ...changeTools, ...importTools]
export const MCP_TOOLS = mcpTools('darwin')
/** the tools that change something: only with "Let AI apps make changes" on */
const CHANGES = new Set([...changeTools, ...importTools].map((t) => t.name))

export const iso = (ms: number | null | undefined) => (ms == null ? null : new Date(ms).toISOString())
const clock = (ms: number) => { const s = Math.floor(ms / 1000); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60; const p = (n: number) => String(n).padStart(2, '0'); return h ? `${h}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}` }
const limitOf = (v: unknown, def = 20, max = 100) => (typeof v === 'number' && v >= 1 ? Math.min(max, Math.floor(v)) : def)
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
/** only ids go in the log: a meeting's or folder's id is a UUID, a name is not */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** what the change and import tools share with the reading ones */
export type Ctx = {
  d: McpDeps
  meetingOf: (v: unknown) => Meeting
  folderOf: (v: unknown) => ReturnType<Store['folders']>[number] | undefined
  summary: (m: Meeting) => object
  log: (line: string) => void
}

export function createMcp(d: McpDeps): Mcp {
  const mac = (d.platform ?? 'darwin') === 'darwin'
  const listed = mcpTools(d.platform ?? 'darwin')
  const log = d.log ?? ((line: string) => console.info('MCP', line))
  // the calendar's people with their emails (null when the calendar gave none): another app can write to them or match them
  const summary = (m: Meeting) => ({ id: m.id, title: m.title, start: iso(m.startedAt), end: iso(m.endedAt), people: m.attendees.map((a) => a.name),
    attendees: m.attendees.map((a) => ({ name: a.name, email: a.email ?? null })), app: m.app, recording: m.state === 'recording',
    ...(m.source === 'import' ? { imported: true } : {}),
    folders: d.store.foldersOf(m.id).map((f) => ({ id: f.id, name: f.name })) })
  /** a folder by id or name (any case); an unknown one names the folders there are */
  const folderOf = (v: unknown) => {
    const want = text(v)
    if (!want) return undefined
    const all = d.store.folders()
    const f = all.find((x) => x.id === want) ?? all.find((x) => x.name.toLowerCase() === want.toLowerCase())
    if (!f) throw new Refusal(`No folder ${JSON.stringify(want)}. The folders are: ${all.map((x) => x.name).join(', ') || 'none yet'}.`)
    return f
  }
  /** a person by email or full name (any case); an unknown one names a few people there are */
  const personOf = (v: unknown): Person | undefined => {
    const want = text(v)?.toLowerCase()
    if (!want) return undefined
    const all = d.store.searchPeople()
    const p = all.find((x) => x.email?.toLowerCase() === want) ?? all.find((x) => x.name.trim().toLowerCase() === want)
    if (p) return p
    const close = all.filter((x) => want.split(/\s+/).some((w) => x.name.toLowerCase().includes(w) || x.email?.toLowerCase().includes(w))).slice(0, 10)
    throw new Refusal(`No one called ${JSON.stringify(text(v))} is in the meetings. ${close.length ? `Close: ${close.map((x) => x.email ? `${x.name} <${x.email}>` : x.name).join(', ')}.` : 'list_people gives everyone.'}`)
  }
  /** the calendar event the meeting is linked to, as last read (it stays without calendar access); null for none */
  const calendarEvent = (m: Meeting) => (m.eventId
    ? { title: m.eventTitle ?? null, start: iso(m.eventStartedAt ?? null), end: iso(m.eventEndedAt ?? null), calendar: m.eventCalendarName ?? null }
    : null)
  const meetingOf = (v: unknown) => {
    const m = typeof v === 'string' ? d.store.meeting(v) : undefined
    // a meeting in the Trash is gone as far as AI apps can tell
    if (!m || m.trashedAt != null) throw new Refusal(`No meeting with id ${JSON.stringify(v ?? null)}. list_meetings or search gives the ids.`)
    return m
  }
  /** the folder Yogurt suggests for a meeting not filed yet, as the note's header offers it */
  const suggestedFolder = (m: Meeting) => {
    if (d.store.foldersOf(m.id).length) return null
    const s = d.store.folderSuggestion(m.id)
    const f = s.state === 'pending' && s.folderId ? d.store.folder(s.folderId) : undefined
    return f ? { id: f.id, name: f.name } : null
  }
  const who = (speaker: string | null, track: Track) => (speaker === AUDIO_SPEAKER ? 'Audio' : track === 'me' || speaker === 'me' ? d.me() || 'You' : speaker || 'Them')
  const events = (r: { status: CalendarStatus; events: CalEvent[] }) => {
    if (!r.events.length && r.status !== 'granted') {
      return r.status === 'unsupported' ? 'Yogurt has no calendar on this computer. The person can add a calendar link in Yogurt: Settings, Calendars.'
        : `Yogurt can't read the calendar (${r.status === 'error' ? 'reading it failed' : 'it has no access'}). The person can connect it in Yogurt: Settings, Calendars.`
    }
    return JSON.stringify(r.events.map((e) => {
      const note = [e.id, ...(e.aliases ?? [])].map((id) => d.store.meetingForEvent(id)).find((m) => m && m.trashedAt == null)
      return { event_id: e.id, title: e.title, start: iso(e.start), end: iso(e.end), calendar: e.calendar?.name ?? null, meeting_link: e.url?.trim() || null,
        attendees: e.attendees.map((a) => ({ name: a.name, email: a.email ?? null })), meeting_id: note?.id ?? null }
    }), null, 2)
  }
  /** a person narrows search the way search's people chips do (all their meetings, newest first, before the limit) */
  const searchIn = (q: string, limit: number, folder?: string, p?: Person) => (p ? d.store.search(q, Infinity, folder, { people: [p] }) : d.store.search(q, limit, folder))

  const tools: Record<string, (a: Args) => Promise<string>> = {
    async list_folders() {
      return JSON.stringify(d.store.folders().map((f) => ({ id: f.id, name: f.name, meetings: f.count })), null, 2)
    },
    async list_meetings(a) {
      const limit = limitOf(a.limit)
      const q = text(a.query)
      const f = folderOf(a.folder)
      const p = personOf(a.person)
      const before = text(a.before) ? Date.parse(String(a.before)) : undefined
      const earlier = (m: Meeting | undefined): m is Meeting => !!m && (before == null || Number.isNaN(before) || m.startedAt < before)
      const found = q || p
        ? searchIn(q ?? '', limit, f?.id, p).map((h) => d.store.meeting(h.meetingId)).filter(earlier).slice(0, limit)
        : f
          ? d.store.folderMeetingIds(f.id).map((mid) => d.store.meeting(mid)).filter(earlier).slice(0, limit)
          : d.store.meetings({ before: Number.isNaN(before) ? undefined : before, limit })
      return JSON.stringify(found.map(summary), null, 2)
    },
    async get_meeting(a) {
      const m = meetingOf(a.id)
      const n = d.store.notes(m.id)
      return JSON.stringify({ ...summary(m), calendar_event: calendarEvent(m), suggested_folder: suggestedFolder(m), myNotes: n.mine, summary: n.enhanced }, null, 2)
    },
    async get_transcript(a) {
      const m = meetingOf(a.id)
      const lines = d.store.segments(m.id)
      if (a.format === 'lines') return JSON.stringify(lines.map((s) => ({ start_ms: s.startMs, end_ms: s.endMs, speaker: who(s.speaker, s.track), is_me: s.track === 'me', text: s.text })), null, 2)
      return lines.map((s) => `[${clock(s.startMs)}] ${who(s.speaker, s.track)}: ${s.text}`).join('\n') || 'Nothing was transcribed in this meeting.'
    },
    async search(a) {
      const q = text(a.query)
      if (!q) throw new Refusal('search needs a query.')
      const limit = limitOf(a.limit)
      return JSON.stringify(searchIn(q, limit, folderOf(a.folder)?.id, personOf(a.person)).slice(0, limit).flatMap((h) => {
        const m = d.store.meeting(h.meetingId)
        return m ? [{ meeting_id: m.id, title: m.title, start: iso(m.startedAt), snippet: h.parts.map((p) => (p.hit ? `**${p.text}**` : p.text)).join('') || h.snippet }] : []
      }), null, 2)
    },
    async ask(a) {
      const question = str(a, 'question', { max: 4000, required: true })!
      const f = folderOf(a.folder)
      const ids = (list(a, 'meeting_ids', { max: 40 }) ?? []).map((id) => meetingOf(id).id)
      const chips: ContextChip[] = [...(f ? [{ kind: 'folder' as const, id: f.id }] : []), ...[...new Set(ids)].map((id) => ({ kind: 'meeting' as const, id }))]
      const got = await d.app.ask(question, chips)
      if ('unavailable' in got) {
        throw new Refusal(got.unavailable === 'model'
          ? "Yogurt's notes model is still downloading, so it can't answer questions yet. Use search and get_transcript instead, or ask again later."
          : `Yogurt is recording a meeting, and on this ${mac ? 'Mac' : 'computer'} it answers questions once the recording ends. Use search and get_transcript meanwhile.`)
      }
      return JSON.stringify({
        answer: got.answer, ...(got.stopped ? { note: 'The answer took too long and was stopped; this is what was written.' } : {}),
        sources: got.sources.map((s) => ({ n: s.n, meeting_id: s.meetingId, title: s.title, start: iso(s.startedAt), at: s.atMs == null ? null : clock(s.atMs), excerpt: s.excerpt?.slice(0, 600) ?? null })),
      }, null, 2)
    },
    async list_people(a) {
      return JSON.stringify(d.store.searchPeople().slice(0, limitOf(a.limit, 200, 1000)).map((p) => ({ name: p.name, email: p.email ?? null })), null, 2)
    },
    async upcoming_meetings() { return events(await d.app.comingUp()) },
    async calendar_day(a) { return events(await d.app.calendarDay(day(a, 'date', { required: true })!)) },
    async list_trash() {
      return JSON.stringify(d.store.trashed().map((m) => ({ id: m.id, title: m.title, start: iso(m.startedAt), trashed_at: iso(m.trashedAt) })), null, 2)
    },
    async get_settings() {
      const s = d.app.settings()
      return JSON.stringify({ my_name: s.myName, interface_language: s.locale,
        spoken_language: s.spoken === 'multi' ? 'multi (any language, heard per meeting)' : 'en (English only)',
        summary_language: s.summaryLanguage || "each meeting's own language", custom_words: s.jargon,
        stop_recording_when_call_ends: s.stopWhenCallEnds, keep_audio_recordings: s.keepRecordings }, null, 2)
    },
    async export_meeting(a) {
      const m = meetingOf(a.id)
      const n = d.store.notes(m.id)
      const side = oneOf(a, 'side', ['summary', 'my_notes'] as const) ?? 'summary'
      return toMarkdownFile(m, side === 'summary' && n.enhanced != null ? n.enhanced : n.mine, d.store.segments(m.id))
    },
    async get_audio(a) {
      const m = meetingOf(a.id)
      if (m.state === 'recording') throw new Refusal('This meeting is still being recorded. Its audio is ready once it stops.')
      const files = (await d.audio(m.id)).map((f) => ({ track: f.track, who: f.track === 'me' ? `${d.me() || 'The person'} (the microphone)` : 'the other side of the call', path: f.path }))
      return JSON.stringify({ files }, null, 2)
    },
  }
  const ctx: Ctx = { d, meetingOf, folderOf, summary, log }
  Object.assign(tools, changeHandlers(ctx), importHandlers(ctx))

  const ok = (msgId: unknown, result: object) => ({ jsonrpc: '2.0', id: msgId, result })
  const fail = (msgId: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: msgId ?? null, error: { code, message } })
  const said = (msgId: unknown, body: string, isError = false) => ok(msgId, { content: [{ type: 'text', text: body }], ...(isError ? { isError: true } : {}) })
  /** a change, by tool and the ids it named: what happened, for main.log */
  const logged = (name: string, a: Args, outcome: string) => {
    const ids = Object.values(a).filter((v): v is string => typeof v === 'string' && UUID.test(v))
    log(`${name} ${outcome}${ids.length ? ` ${ids.join(' ')}` : ''}`)
  }

  return {
    async handle(msg) {
      if (!msg || typeof msg !== 'object' || (msg as { jsonrpc?: unknown }).jsonrpc !== '2.0' || typeof (msg as { method?: unknown }).method !== 'string') return fail(null, -32600, 'Not a JSON-RPC request')
      const { id: msgId, method, params } = msg as { id?: unknown; method: string; params?: Record<string, unknown> }
      // a notification: nothing comes back
      if (msgId === undefined) return null
      if (method === 'initialize') {
        const asked = params?.protocolVersion
        return ok(msgId, {
          protocolVersion: VERSIONS.includes(String(asked)) ? asked : VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'yogurt', title: 'Yogurt', version: d.version },
          instructions: `Yogurt holds the person's meeting notes, transcripts and recordings on this ${mac ? 'Mac' : 'computer'}. Use list_meetings or search to find a meeting, then get_meeting, get_transcript or get_audio.`
            + " With changes allowed in Yogurt's Settings, it can also file and edit meetings, take notes of a call, and bring in meetings from other notes apps (create_meeting).",
        })
      }
      if (method === 'ping') return ok(msgId, {})
      if (method === 'tools/list') return ok(msgId, { tools: listed })
      if (method === 'tools/call') {
        const name = String(params?.name ?? '')
        const tool = tools[name]
        const a = params?.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments as Args : {}
        if (!tool) return said(msgId, `Yogurt has no tool called ${name}.`, true)
        if (!d.enabled()) return said(msgId, 'Yogurt has connecting AI apps turned off. The person can turn it on in Yogurt: Settings, AI apps.', true)
        const change = CHANGES.has(name)
        if (change && !d.changesEnabled()) {
          logged(name, a, 'refused: changes off')
          return said(msgId, 'Yogurt lets AI apps read meetings but not change them. The person can allow changes in Yogurt: Settings, AI apps, "Let AI apps make changes".', true)
        }
        try {
          const body = await tool(a)
          if (change) logged(name, a, 'ok')
          return said(msgId, body)
        } catch (e) {
          if (e instanceof Refusal) { if (change) logged(name, a, 'refused'); return said(msgId, e.message, true) }
          console.error(`mcp: ${name} failed`, e)
          if (change) logged(name, a, 'failed')
          return said(msgId, `Yogurt couldn't do that (${name}). Try again.`, true)
        }
      }
      return fail(msgId, -32601, `Yogurt doesn't do ${method}`)
    },
  }
}
