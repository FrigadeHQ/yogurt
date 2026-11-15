// Transcript lab. What each model heard, the combined transcript, the person's fixes.
import type { DatabaseSync } from 'node:sqlite'
import type { Segment, Store } from '../store'
import type { LabChoice as Choice, LabScores, LabStatus, LabWindow } from '../../shared/lab'
import { distance, words } from '../../shared/labCombine'
import { splitBack, type Window } from './windows'

type Row = Record<string, unknown>
const LIVE = 'live'

/** The lab's tables, in Yogurt's own database (a meeting's rows go with it) */
export function createLabStore(store: Pick<Store, 'db' | 'segments' | 'addSegments' | 'deleteSegments'>) {
  const db: DatabaseSync = store.db
  db.exec(`
    CREATE TABLE IF NOT EXISTS lab_windows (
      meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE, key TEXT NOT NULL, track TEXT NOT NULL, speaker TEXT,
      start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, segment_ids TEXT NOT NULL, texts TEXT NOT NULL, language TEXT,
      combined TEXT, choices TEXT NOT NULL DEFAULT '[]', fixed TEXT, PRIMARY KEY (meeting_id, key));
    CREATE TABLE IF NOT EXISTS lab_readings (
      meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE, key TEXT NOT NULL, model TEXT NOT NULL, text TEXT NOT NULL,
      language TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (meeting_id, key, model));
    CREATE TABLE IF NOT EXISTS lab_state (
      meeting_id TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE, state TEXT NOT NULL, step TEXT, error TEXT,
      shown TEXT NOT NULL DEFAULT 'live', updated_at INTEGER NOT NULL);
    -- the live lines as they were, for going back: one row per line the lab changed or removed
    CREATE TABLE IF NOT EXISTS lab_live (
      meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE, segment_id INTEGER NOT NULL, line TEXT NOT NULL,
      PRIMARY KEY (meeting_id, segment_id));`)

  const status = (id: string): LabStatus => {
    const r = db.prepare('SELECT * FROM lab_state WHERE meeting_id = ?').get(id) as Row | undefined
    return r ? { state: r.state as LabStatus['state'], ...(r.step ? { step: String(r.step) } : {}), ...(r.error ? { error: String(r.error) } : {}), updatedAt: Number(r.updated_at), using: String(r.shown) } : { state: 'none', using: LIVE }
  }
  const setStatus = (id: string, s: Partial<LabStatus>) => {
    const cur = status(id)
    const next = { ...cur, ...s }
    db.prepare(`INSERT INTO lab_state (meeting_id, state, step, error, shown, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(meeting_id) DO UPDATE SET state = excluded.state, step = excluded.step, error = excluded.error, shown = excluded.shown, updated_at = excluded.updated_at`)
      .run(id, next.state, s.step ?? null, s.error ?? null, next.using, Date.now())
  }

  /** a new run's stretches replace the old ones, in one go; the person's fixes stay with the stretches that are still there */
  const saveWindows = (id: string, ws: Array<Window & { language: string | null; combined?: string | null; choices?: Choice[] }>) => {
    const fixed = new Map((db.prepare('SELECT key, fixed FROM lab_windows WHERE meeting_id = ? AND fixed IS NOT NULL').all(id) as Row[]).map((r) => [String(r.key), String(r.fixed)]))
    db.exec('BEGIN')
    try {
      db.prepare('DELETE FROM lab_windows WHERE meeting_id = ?').run(id)
      const ins = db.prepare('INSERT INTO lab_windows (meeting_id, key, track, speaker, start_ms, end_ms, segment_ids, texts, language, combined, choices, fixed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      for (const w of ws) ins.run(id, w.key, w.track, w.speaker, w.startMs, w.endMs, JSON.stringify(w.segmentIds), JSON.stringify(w.texts), w.language, w.combined ?? null, JSON.stringify(w.choices ?? []), fixed.get(w.key) ?? null)
      db.exec('COMMIT')
    } catch (e) { db.exec('ROLLBACK'); throw e }
  }
  const saveReadings = (id: string, model: string, heard: Map<string, { text: string; language?: string }>) => {
    const up = db.prepare('INSERT OR REPLACE INTO lab_readings (meeting_id, key, model, text, language, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    db.exec('BEGIN')
    try { for (const [key, h] of heard) up.run(id, key, model, h.text, h.language ?? null, Date.now()); db.exec('COMMIT') } catch (e) { db.exec('ROLLBACK'); throw e }
  }
  const saveCombined = (id: string, key: string, text: string, choices: Choice[]) =>
    db.prepare('UPDATE lab_windows SET combined = ?, choices = ? WHERE meeting_id = ? AND key = ?').run(text, JSON.stringify(choices), id, key)
  const fix = (id: string, key: string, text: string | null) =>
    db.prepare('UPDATE lab_windows SET fixed = ? WHERE meeting_id = ? AND key = ?').run(text, id, key)

  const windows = (id: string): LabWindow[] => (db.prepare('SELECT * FROM lab_windows WHERE meeting_id = ? ORDER BY start_ms').all(id) as Row[]).map((r) => ({
    key: String(r.key), track: r.track as Segment['track'], speaker: r.speaker == null ? null : String(r.speaker), startMs: Number(r.start_ms), endMs: Number(r.end_ms),
    segmentIds: JSON.parse(String(r.segment_ids)), texts: JSON.parse(String(r.texts)), language: r.language == null ? null : String(r.language),
    combined: r.combined == null ? null : String(r.combined), choices: JSON.parse(String(r.choices)), fixed: r.fixed == null ? null : String(r.fixed),
  }))
  const readings = (id: string): Record<string, Record<string, string>> => {
    const out: Record<string, Record<string, string>> = {}
    for (const r of db.prepare('SELECT key, model, text FROM lab_readings WHERE meeting_id = ?').all(id) as Row[]) (out[String(r.model)] ??= {})[String(r.key)] = String(r.text)
    return out
  }

  /** the text of each stretch in a version: live, combined, or a model's (the person's fix wins over all of them) */
  const textOf = (w: LabWindow, version: string, rs: Record<string, Record<string, string>>): string =>
    w.fixed ?? (version === LIVE ? w.texts.join(' ') : version === 'combined' ? w.combined ?? w.texts.join(' ') : rs[version]?.[w.key] ?? w.texts.join(' '))

  /**
   * The transcript shows a version: each stretch's text shared out over its live lines (times, speakers, echoes stay).
   * The live lines are kept the first time, so going back to live puts them back as they were, removed ones too.
   */
  const use = (id: string, version: string) => {
    const ws = windows(id), rs = readings(id)
    const kept = new Map((db.prepare('SELECT segment_id, line FROM lab_live WHERE meeting_id = ?').all(id) as Row[]).map((r) => [Number(r.segment_id), { ...(JSON.parse(String(r.line)) as Segment), id: Number(r.segment_id) }]))
    const now = new Map(store.segments(id, { hidden: true }).map((s) => [s.id, s]))
    const keep = db.prepare('INSERT OR IGNORE INTO lab_live (meeting_id, segment_id, line) VALUES (?, ?, ?)')
    const setText = db.prepare('UPDATE segments SET text = ? WHERE id = ?')
    const gone: number[] = [], back: Segment[] = []
    db.exec('BEGIN')
    try {
      for (const w of ws) {
        const lines = w.segmentIds.map((sid) => now.get(sid) ?? kept.get(sid)).filter((s): s is Segment => !!s)
        if (lines.length !== w.segmentIds.length) continue
        const live = lines.map((s) => kept.get(s.id)?.text ?? s.text)
        const parts = version === LIVE && !w.fixed ? live : splitBack(textOf(w, version, rs), live)
        lines.forEach((s, i) => {
          if (!kept.has(s.id)) { keep.run(id, s.id, JSON.stringify(s)); kept.set(s.id, s) }
          const there = now.has(s.id)
          if (parts[i]) { if (there) setText.run(parts[i], s.id); else back.push({ ...s, text: parts[i] }) }
          else if (there) gone.push(s.id)
        })
      }
      db.exec('COMMIT')
    } catch (e) { db.exec('ROLLBACK'); throw e }
    if (gone.length) store.deleteSegments(gone)
    if (back.length) {
      // lines put back get new ids: the kept copies and the stretches follow them
      store.addSegments(back.map(({ id: _id, ...s }) => s as Omit<Segment, 'id'>))
      const fresh = store.segments(id, { hidden: true }).filter((s) => !now.has(s.id))
      const moved = new Map<number, number>()
      for (const b of back) {
        const n = fresh.find((s) => s.track === b.track && s.startMs === b.startMs && s.endMs === b.endMs && ![...moved.values()].includes(s.id))
        if (!n) continue
        moved.set(b.id, n.id)
        db.prepare('UPDATE lab_live SET segment_id = ? WHERE meeting_id = ? AND segment_id = ?').run(n.id, id, b.id)
      }
      // each stretch rewritten once, with every line of it that moved
      for (const w of ws.filter((x) => x.segmentIds.some((s) => moved.has(s))))
        db.prepare('UPDATE lab_windows SET segment_ids = ? WHERE meeting_id = ? AND key = ?').run(JSON.stringify(w.segmentIds.map((x) => moved.get(x) ?? x)), id, w.key)
    }
    setStatus(id, { using: version })
  }

  /** the stretches as they were live, for a new run: from the kept copies where the lab changed them */
  const liveSegments = (id: string): Segment[] => {
    const kept = new Map((db.prepare('SELECT segment_id, line FROM lab_live WHERE meeting_id = ?').all(id) as Row[]).map((r) => [Number(r.segment_id), { ...(JSON.parse(String(r.line)) as Segment), id: Number(r.segment_id) }]))
    const now = store.segments(id, { hidden: true })
    const have = new Set(now.map((s) => s.id))
    return [...now.map((s) => ({ ...s, text: kept.get(s.id)?.text ?? s.text })), ...[...kept.values()].filter((s) => !have.has(s.id))]
  }

  /** every version's word errors against the person's fixes, over all meetings */
  const scores = (): LabScores => {
    const out: LabScores = {}
    const add = (v: string, fixed: string, text: string) => {
      const ref = words(fixed), s = (out[v] ??= { errors: 0, words: 0 })
      s.errors += distance(ref, words(text)); s.words += ref.length
    }
    for (const r of db.prepare('SELECT meeting_id, key, texts, combined, fixed FROM lab_windows WHERE fixed IS NOT NULL').all() as Row[]) {
      const fixed = String(r.fixed)
      add('live', fixed, (JSON.parse(String(r.texts)) as string[]).join(' '))
      if (r.combined != null) add('combined', fixed, String(r.combined))
      for (const x of db.prepare('SELECT model, text FROM lab_readings WHERE meeting_id = ? AND key = ?').all(String(r.meeting_id), String(r.key)) as Row[]) add(String(x.model), fixed, String(x.text))
    }
    return out
  }

  return { status, setStatus, saveWindows, saveReadings, saveCombined, fix, windows, readings, use, liveSegments, textOf, scores }
}
export type LabStore = ReturnType<typeof createLabStore>
