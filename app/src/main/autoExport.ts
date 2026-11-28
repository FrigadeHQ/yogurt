import { createHash, randomUUID } from 'node:crypto'
import { closeSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from 'node:fs'
import { rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { toMarkdownFile } from '../shared/exportNotes'
import { t } from '../shared/i18n'
import type { Meeting, Notes, Segment, Store } from './store'

/**
 * A copy of each meeting in a folder the person picked (Obsidian, Dropbox, Google Drive): one Markdown file per meeting,
 * written again when it changes. One way only, so the database never sits in a synced folder. Changes are read from the
 * phone's change log (store.ts), so every write path counts. Files are never deleted: they are the person's copy.
 */

const pad = (n: number) => String(n).padStart(2, '0')
/** under ext4's 255 bytes with " (99).md" and a temp prefix to spare */
const STEM_BYTES = 200
const TITLE_CHARS = 100

/** "YYYY-MM-DD HHmm Title": the date first, so no title can make a reserved Windows name (CON, NUL…) */
export function exportStem(title: string, startedAt: number): string {
  const d = new Date(startedAt)
  const when = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`
  const clean = title.normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  let short = Array.from(clean).slice(0, TITLE_CHARS)
  while (short.length && Buffer.byteLength(`${when} ${short.join('')}`) > STEM_BYTES) short.pop()
  // Windows drops trailing dots and spaces, which would make two names one
  const name = short.join('').replace(/[. ]+$/, '').replace(/^\.+/, '').trim()
  return `${when} ${name || t('Meeting')}`
}

/**
 * The first free name for this meeting: past names other meetings have (any case, as Mac and Windows ignore it) and
 * files someone else put there. onDisk: undefined when no file, else the meeting id in its front matter (null: not ours).
 */
export function pickName(stem: string, id: string, taken: Set<string>, onDisk: (name: string) => string | null | undefined): string {
  for (let i = 1; ; i++) {
    const name = i === 1 ? `${stem}.md` : `${stem} (${i}).md`
    if (taken.has(name.toLowerCase())) continue
    const owner = onDisk(name)
    if (owner === undefined || owner === id) return name
  }
}

/** the meeting id a file of ours carries in its front matter */
export function idInFile(head: string): string | null {
  return /^---\r?\nyogurt-id: ([\w-]+)\r?\n/.exec(head)?.[1] ?? null
}

/** Export Markdown's file, with the meeting's id up front (Obsidian shows it as a property) and the person's own notes under the summary */
export function exportMarkdown(m: Meeting, notes: Notes, segments: Segment[], credit: boolean): string {
  const summary = notes.enhanced != null
  const body = toMarkdownFile(m, summary ? notes.enhanced! : notes.mine, segments, credit, summary ? notes.mine : '')
  return `---\nyogurt-id: ${m.id}\n---\n\n${body}`
}

/** Write once a meeting has been quiet for quietMs, but at least every maxMs while it keeps changing */
export class Debounce {
  private first = new Map<string, number>()
  private last = new Map<string, number>()
  constructor(private quietMs: number, private maxMs: number) {}
  touch(id: string, now: number) {
    if (!this.first.has(id)) this.first.set(id, now)
    this.last.set(id, now)
  }
  due(now: number): string[] {
    const out = [...this.last].filter(([id, last]) => now - last >= this.quietMs || now - this.first.get(id)! >= this.maxMs).map(([id]) => id)
    for (const id of out) { this.first.delete(id); this.last.delete(id) }
    return out
  }
}

type Entry = { name: string; stem: string; hash: string }
type Index = { folder?: string; cursor: number; files: Record<string, Entry> }
export type AutoExportStatus = { failed: boolean }

const ENTITIES = new Set(['meeting', 'notes', 'segments'])

export function createAutoExporter(d: {
  store: Pick<Store, 'meeting' | 'notes' | 'segments'> & { db: DatabaseSync }
  /** in app data, never in the folder */
  indexFile: string
  /** the chosen folder while turned on */
  folder: () => string | undefined
  credit: () => boolean
  /** its notes are being written: wait for them */
  busy: (id: string) => boolean
  now?: () => number
  quietMs?: number
  maxWaitMs?: number
  status?: (s: AutoExportStatus) => void
}) {
  const now = d.now ?? Date.now
  const debounce = new Debounce(d.quietMs ?? 4000, d.maxWaitMs ?? 60_000)
  /** recording, or notes being written: looked at again each tick */
  const waiting = new Set<string>()
  /** the folder failed: tried again on the next change */
  const retry = new Set<string>()
  let failed = false
  let running: Promise<unknown> = Promise.resolve()

  const load = (): Index => {
    try {
      const j = JSON.parse(readFileSync(d.indexFile, 'utf8'))
      return { folder: typeof j.folder === 'string' ? j.folder : undefined, cursor: Number(j.cursor) || 0, files: j.files && typeof j.files === 'object' ? j.files : {} }
    } catch { return { cursor: 0, files: {} } }
  }
  let index = load()
  const save = () => {
    const tmp = `${d.indexFile}.${randomUUID()}.tmp`
    writeFileSync(tmp, JSON.stringify(index))
    renameSync(tmp, d.indexFile)
  }
  const head = () => Number(d.store.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM companion_changes').get()?.seq ?? 0)
  const setFailed = (on: boolean, err?: unknown) => {
    if (on && !failed) console.error('auto export: could not save to the folder', err)
    if (on !== failed) { failed = on; d.status?.({ failed }) }
  }
  /** a new folder starts with no files of ours */
  const forFolder = (folder: string) => {
    if (index.folder !== folder) { index = { folder, cursor: index.cursor, files: {} }; save() }
  }

  /** whose file this is: undefined when there is none, null when it isn't one of ours (or can't be read) */
  const owner = (folder: string, name: string): string | null | undefined => {
    let fd: number
    try { fd = openSync(join(folder, name), 'r') } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : null }
    try {
      const buf = Buffer.alloc(200)
      return idInFile(buf.subarray(0, readSync(fd, buf, 0, 200, 0)).toString('utf8'))
    } catch { return null } finally { closeSync(fd) }
  }

  /** false: not ready yet (or gone); throws when the folder can't be written */
  async function write(folder: string, id: string): Promise<boolean> {
    const m = d.store.meeting(id)
    if (!m || m.trashedAt != null || m.state === 'prepared') return false
    if (m.state === 'recording' || d.busy(id)) { waiting.add(id); return false }
    waiting.delete(id)
    if (!(await stat(folder)).isDirectory()) throw new Error('not a folder')
    const text = exportMarkdown(m, d.store.notes(id), d.store.segments(id), d.credit())
    const hash = createHash('sha256').update(text).digest('hex')
    const stem = exportStem(m.title, m.startedAt)
    const was = index.files[id]
    // the same title keeps its name (and its " (2)"), unless someone else's file has taken that name since
    const held = was && owner(folder, was.name)
    let name = was?.stem === stem && (held === undefined || held === id) ? was.name : undefined
    if (!name) {
      const taken = new Set(Object.entries(index.files).filter(([k]) => k !== id).map(([, e]) => e.name.toLowerCase()))
      name = pickName(stem, id, taken, (n) => owner(folder, n))
    }
    if (basename(name) !== name) throw new Error('bad name')
    const file = join(folder, name)
    if (was?.name === name && was.hash === hash && owner(folder, name) === id) return true
    // a new title: move the old file, so links and sync history follow it
    if (was && was.name !== name && owner(folder, was.name) === id) await rename(join(folder, was.name), file).catch(() => {})
    // a whole file or none: a syncing app never sees half of one
    const tmp = join(folder, `.${randomUUID()}.yogurt-tmp`)
    try {
      await writeFile(tmp, text, 'utf8')
      await rename(tmp, file)
    } catch (e) { await rm(tmp, { force: true }).catch(() => {}); throw e }
    index.files[id] = { name, stem, hash }
    save()
    return true
  }

  async function run(folder: string, ids: string[], progress?: (done: number, total: number) => void) {
    let saved = 0
    for (const [i, id] of ids.entries()) {
      try {
        const wrote = await write(folder, id)
        retry.delete(id)
        if (wrote) { saved++; setFailed(false) }
      } catch (e) {
        for (const rest of ids.slice(i)) retry.add(rest)
        setFailed(true, e)
        return { saved, failed: true }
      }
      progress?.(i + 1, ids.length)
    }
    return { saved, failed: false }
  }

  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const p = running.then(f, f)
    running = p.catch(() => {})
    return p
  }

  return {
    /** turned on, or a new folder: only changes from now on (earlier meetings come with saveEarlier) */
    start() {
      const folder = d.folder()
      if (!folder) return
      forFolder(folder)
      index.cursor = head()
      waiting.clear(); retry.clear()
      save()
      setFailed(false)
    },
    /** read new changes and write what is due; called every couple of seconds */
    tick: () => serial(async () => {
      const folder = d.folder()
      if (!folder) return
      forFolder(folder)
      const top = head()
      // a log made again from scratch numbers from 1: take it from here
      if (top < index.cursor) { index.cursor = top; save() }
      let moved = false
      if (top > index.cursor) {
        const rows = d.store.db.prepare('SELECT entity, entity_id FROM companion_changes WHERE seq > ? AND seq <= ?').all(index.cursor, top)
        for (const r of rows) if (ENTITIES.has(String(r.entity))) { debounce.touch(String(r.entity_id), now()); moved = true }
        index.cursor = top
        save()
      }
      const due = new Set([...debounce.due(now()), ...waiting, ...(moved ? retry : [])])
      if (due.size) await run(folder, [...due])
    }),
    /** every meeting outside the Trash, oldest first */
    saveEarlier: (progress?: (done: number, total: number) => void) => serial(async () => {
      const folder = d.folder()
      if (!folder) return { saved: 0, failed: false }
      forFolder(folder)
      const ids = d.store.db.prepare("SELECT id FROM meetings WHERE trashed_at IS NULL AND state != 'prepared' ORDER BY started_at, rowid").all().map((r) => String(r.id))
      return run(folder, ids, progress)
    }),
    status: (): AutoExportStatus => ({ failed }),
  }
}
