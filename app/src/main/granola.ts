import { createHash } from 'node:crypto'
import { lstatSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { t } from '../shared/i18n'
import { Refusal, type Args } from './mcp/args'
import { IMPORT_LINES_MAX } from './mcp/importMeeting'

export function granolaUsed(os = process.platform, home = homedir(), env = process.env, now = Date.now()) {
  const path = os === 'win32' ? win32 : posix
  const dir = os === 'darwin' ? path.join(home, 'Library/Application Support/Granola')
    : os === 'win32' && env.APPDATA ? path.join(env.APPDATA, 'Granola') : undefined
  if (!dir) return false
  // Only enumerate names and inspect timestamps. Never follow a link or open a data file.
  try {
    if (!lstatSync(dir).isDirectory()) return false
    return readdirSync(dir).some(name => {
      if (name !== 'granola.db' && !/^cache-v.*\.json.*$/.test(name)) return false
      try {
        const stat = lstatSync(path.join(dir, name))
        return stat.isFile() && stat.mtimeMs <= now && stat.mtimeMs >= now - 90 * 86_400_000
      } catch { return false }
    })
  } catch { return false }
}

// Each match consumes one complete field and its delimiter, including newlines inside quoted fields.
function csvRows(text: string) {
  text = text.replace(/^\uFEFF/, '')
  const field = /(?:"([^"]*(?:""[^"]*)*)"|([^",\r\n]*))(,|\r\n|\n|\r|$)/gy
  const rows: string[][] = []
  let row: string[] = []
  while (field.lastIndex < text.length) {
    const m = field.exec(text)
    if (!m) throw new Refusal(t("Check the CSV file and try again."))
    row.push(m[1] === undefined ? m[2] : m[1].replace(/""/g, '"'))
    if (m[3] !== ',' || field.lastIndex === text.length) {
      if (m[3] === ',') row.push('')
      if (row.some(value => value.trim())) rows.push(row)
      row = []
    }
  }
  return rows
}

export function granolaDocumentId(id: string) {
  if (/^[a-f0-9]{32}$/i.test(id)) return id.toLowerCase().replace(/^(........)(....)(....)(....)(............)$/, '$1-$2-$3-$4-$5')
  return /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id) ? id.toLowerCase() : id
}

export type GranolaItem = { title: string; duplicate?: boolean; read(): Args | Promise<Args> }

export function granolaCsv(text: string, today = new Date()): GranolaItem[] {
  const [header = [], ...rows] = csvRows(text)
  const names = header.map(h => h.trim().toLowerCase())
  if (!['summary', 'notes', 'transcript'].some(name => names.includes(name))) throw new Refusal(t("Check the CSV file and try again."))
  return rows.map((row, i) => {
    const get = (name: string) => row[names.indexOf(name)] ?? ''
    const title = get('document_title').trim()
    const date = get('document_created').trim()
    const summary = get('summary'), mine = get('notes'), transcript = get('transcript')
    const id = get('document_id').trim() || 'csv-' + createHash('sha256').update(JSON.stringify([title, date, summary, mine, transcript])).digest('hex')
    return { title: title || '#' + (i + 2), read: () => {
      if (row.length > header.length) throw new Refusal(t("Check the CSV file and try again."))
      // Granola writes UTC even when the export omits the offset.
      const started = /^\d{4}-\d\d-\d\d[T ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?$/.test(date) ? date.replace(' ', 'T') + 'Z' : date
      return { source_id: 'granola:' + granolaDocumentId(id), title: title || t('Untitled meeting'), started_at: started || today.toISOString(), summary, my_notes: mine, transcript }
    } }
  })
}

type Speaker = { name?: string; diarization_label?: string; attribution?: string }
type Line = { text: string; speaker?: Speaker; start_time?: string; end_time?: string }
type Note = {
  id: string; title: string | null; created_at: string; web_url?: string; owner?: { name?: string; email?: string }
  summary_text?: string; summary_markdown?: string; private_notes_text?: string; private_notes_markdown?: string
  calendar_event?: { scheduled_start_time?: string }; attendees?: { name?: string; email?: string }[]
  transcript?: Line[] | null
}
type Page = { hasMore: boolean; cursor: string | null }
const invalid = () => new Refusal(t("Couldn't read Granola's response."))

function fromNote(note: Note): Args {
  const start = note.calendar_event?.scheduled_start_time || note.created_at
  const elapsed = (time?: string) => time ? Math.max(0, Date.parse(time) - Date.parse(start)) : undefined
  // The public API id differs from the document id in the CSV and note link.
  const docId = note.web_url?.match(/^https:\/\/(?:notes\.granola\.ai|granola\.ai|www\.granola\.ai|granola\.so)\/d\/([\w-]+)(?:[/?#]|$)/i)?.[1]
  return {
    source_id: 'granola:' + granolaDocumentId(docId ?? note.id), title: note.title || t('Untitled meeting'), started_at: start,
    attendees: note.attendees?.map(a => ({ name: a.name || a.email, email: a.email })),
    summary: note.summary_markdown || note.summary_text, my_notes: note.private_notes_markdown || note.private_notes_text,
    transcript_lines: note.transcript?.map(l => ({
      text: l.text, speaker: l.speaker?.name || l.speaker?.diarization_label ||
        (l.speaker?.attribution === 'me' ? note.owner?.name || note.owner?.email : undefined),
      start_ms: elapsed(l.start_time), end_ms: elapsed(l.end_time),
    })),
  }
}

class ApiError extends Refusal {
  constructor(readonly status: number) {
    super(status === 401 || status === 403 ? t('Check your Granola API key and its access.') : 'Granola (HTTP ' + status + ')')
  }
}

export function granolaApi(key: string, request = fetch, wait: (ms: number) => Promise<unknown> = delay) {
  let nextRequest = 0
  async function get<T>(path: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await wait(Math.max(0, nextRequest - Date.now()))
      nextRequest = Date.now() + 210
      let response: Response
      try {
        response = await request('https://public-api.granola.ai/v1/' + path, { headers: { Authorization: 'Bearer ' + key }, redirect: 'error', signal: AbortSignal.timeout(30_000) })
      } catch { throw new Refusal(t("Yogurt couldn't reach that address. Check your connection and the address.")) }
      if (response.status === 429 && attempt < 2) {
        const seconds = Number(response.headers.get('Retry-After')) || 1
        if (seconds > 60) throw new ApiError(429)
        nextRequest = Date.now() + Math.max(1, seconds) * 1000
        continue
      }
      if (!response.ok) throw new ApiError(response.status)
      try { return await response.json() } catch { throw invalid() }
    }
  }
  async function* pages<T extends Page>(path: string) {
    const seen = new Set<string>()
    let url = path
    for (;;) {
      const page = await get<T>(url)
      if (!page || typeof page.hasMore !== 'boolean') throw invalid()
      yield page
      if (!page.hasMore) break
      if (typeof page.cursor !== 'string' || !page.cursor || seen.has(page.cursor)) throw invalid()
      seen.add(page.cursor)
      url = path + '&cursor=' + encodeURIComponent(page.cursor)
    }
  }
  async function read(id: string) {
    const path = 'notes/' + encodeURIComponent(id)
    let note: Note
    try { note = await get<Note>(path + '?include=transcript') }
    catch (e) {
      if (!(e instanceof ApiError) || e.status !== 413) throw e
      note = await get<Note>(path)
      note.transcript = []
      for await (const page of pages<Page & { transcript: Line[] }>(path + '/transcript?page_size=100')) {
        if (!Array.isArray(page.transcript)) throw invalid()
        if (page.transcript.length + note.transcript.length > IMPORT_LINES_MAX) throw new Refusal('Transcript exceeds ' + IMPORT_LINES_MAX + ' lines.')
        note.transcript.push(...page.transcript)
      }
    }
    if (!note || note.id !== id || !note.created_at || (note.transcript != null && !Array.isArray(note.transcript))) throw invalid()
    return fromNote(note)
  }
  return { read, async list() {
    const items = new Map<string, string>()
    for await (const page of pages<Page & { notes: (Pick<Note, 'id' | 'title'> & { deleted_at?: string })[] }>('notes?page_size=30')) {
      if (!Array.isArray(page.notes)) throw invalid()
      for (const note of page.notes) {
        if (!note || typeof note.id !== 'string' || !/^not_[a-zA-Z0-9]+$/.test(note.id)) throw invalid()
        if (!note.deleted_at) items.set(note.id, note.title || t('Untitled meeting'))
      }
    }
    return [...items].map(([id, title]) => ({ id, title }))
  } }
}
