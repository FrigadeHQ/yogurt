import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type Store } from '../src/main/store'
import { createAutoExporter, Debounce, exportMarkdown, exportStem, idInFile, pickName } from '../src/main/autoExport'
import type { Meeting, Segment } from '../src/shared/types'

const at = new Date(2026, 2, 7, 9, 5).getTime()

describe('exportStem', () => {
  it('starts with the local date and time, then the title', () => {
    expect(exportStem('Weekly sync', at)).toBe('2026-03-07 0905 Weekly sync')
  })
  it('takes out what Windows, Mac or Linux cannot hold in a name', () => {
    expect(exportStem('a/b\\c:d*e?f"g<h>i|j\u0001k', at)).toBe('2026-03-07 0905 a b c d e f g h i j k')
  })
  it('never ends in a dot or space, which Windows drops', () => {
    expect(exportStem('Plans...  ', at)).toBe('2026-03-07 0905 Plans')
  })
  it('a reserved Windows name is safe after the date', () => {
    expect(exportStem('CON', at)).toBe('2026-03-07 0905 CON')
    expect(exportStem('nul.txt', at)).toBe('2026-03-07 0905 nul.txt')
  })
  it('a blank title is called Meeting', () => {
    expect(exportStem('  ', at)).toBe('2026-03-07 0905 Meeting')
    expect(exportStem('///', at)).toBe('2026-03-07 0905 Meeting')
  })
  it('caps long titles by whole characters, under every file system’s limit', () => {
    const stem = exportStem('😀'.repeat(200), at)
    expect(Buffer.byteLength(stem + ' (99).md')).toBeLessThanOrEqual(255)
    expect(stem).not.toMatch(/�/)
    expect(Array.from(stem.slice(16)).every((c) => c === '😀')).toBe(true)
  })
  it('composes accents the same way on every computer', () => {
    expect(exportStem('Café', at)).toBe('2026-03-07 0905 Café')
  })
})

describe('pickName', () => {
  const none = () => undefined
  it('uses the stem when free', () => {
    expect(pickName('2026 A', 'm1', new Set(), none)).toBe('2026 A.md')
  })
  it('counts up past names other meetings have, ignoring case', () => {
    expect(pickName('2026 A', 'm1', new Set(['2026 a.md']), none)).toBe('2026 A (2).md')
    expect(pickName('2026 A', 'm1', new Set(['2026 a.md', '2026 a (2).md']), none)).toBe('2026 A (3).md')
  })
  it('never takes over a file someone else put there', () => {
    expect(pickName('2026 A', 'm1', new Set(), (n) => (n === '2026 A.md' ? null : undefined))).toBe('2026 A (2).md')
  })
  it('takes back its own file when the index was lost', () => {
    expect(pickName('2026 A', 'm1', new Set(), (n) => (n === '2026 A.md' ? 'm1' : undefined))).toBe('2026 A.md')
    expect(pickName('2026 A', 'm1', new Set(), (n) => (n === '2026 A.md' ? 'm2' : undefined))).toBe('2026 A (2).md')
  })
})

describe('idInFile', () => {
  it('reads the meeting id from the front matter', () => {
    expect(idInFile('---\nyogurt-id: abc-123\n---\n\n# Hi')).toBe('abc-123')
    expect(idInFile('---\r\nyogurt-id: abc\r\n---')).toBe('abc')
  })
  it('is null for any other file', () => {
    expect(idInFile('# Notes\nyogurt-id: abc')).toBeNull()
    expect(idInFile('')).toBeNull()
  })
})

const meeting = (over: Partial<Meeting> = {}): Meeting => ({ id: 'm1', title: 'Roadmap', startedAt: at, endedAt: at + 60_000, eventId: null, app: 'Zoom',
  attendees: [{ name: 'Ada', email: null }, { name: 'Lin', email: null }], state: 'done', language: null, titleSource: 'manual', ...over } as Meeting)
const seg = (startMs: number, track: 'me' | 'them', text: string, speaker: string | null = null): Segment => ({ id: startMs, meetingId: 'm1', track, startMs, endMs: startMs + 1000, text, speaker })

describe('exportMarkdown', () => {
  const segments = [seg(0, 'me', 'Hello there.'), seg(65_000, 'them', 'Hi!', 'Ada')]
  it('has the id up front, then title, date, people, summary, own notes and the transcript with names and times', () => {
    const out = exportMarkdown(meeting(), { mine: 'call the bank', enhanced: '## Summary\n- ship it', edited: false }, segments, false)
    expect(out.startsWith('---\nyogurt-id: m1\n---\n\n# Roadmap\n')).toBe(true)
    expect(out).toContain('With: Ada, Lin')
    expect(out.indexOf('## Summary')).toBeLessThan(out.indexOf('## My notes'))
    expect(out.indexOf('call the bank')).toBeGreaterThan(out.indexOf('## My notes'))
    expect(out.indexOf('## Transcript')).toBeGreaterThan(out.indexOf('call the bank'))
    expect(out).toContain('**You** (0:00)')
    expect(out).toContain('**Ada** (1:05)')
    expect(out).not.toContain('Recorded with')
  })
  it('the person’s notes are the notes when there is no summary', () => {
    const out = exportMarkdown(meeting(), { mine: 'just mine', enhanced: null, edited: false }, [], false)
    expect(out).toContain('just mine')
    expect(out).not.toContain('## My notes')
    expect(out).not.toContain('## Transcript')
  })
  it('adds the credit when the setting is on, like Export Markdown', () => {
    expect(exportMarkdown(meeting(), { mine: '', enhanced: null, edited: false }, [], true)).toContain('Recorded with')
  })
})

describe('Debounce', () => {
  it('waits until changes stop for a while', () => {
    const d = new Debounce(1000, 10_000)
    d.touch('a', 0); d.touch('a', 800)
    expect(d.due(1500)).toEqual([])
    expect(d.due(1800)).toEqual(['a'])
    expect(d.due(5000)).toEqual([])
  })
  it('still writes during a long run of changes', () => {
    const d = new Debounce(1000, 3000)
    for (let t = 0; t <= 3000; t += 500) d.touch('a', t)
    expect(d.due(3000)).toEqual(['a'])
  })
  it('keeps each meeting apart', () => {
    const d = new Debounce(1000, 10_000)
    d.touch('a', 0); d.touch('b', 900)
    expect(d.due(1000)).toEqual(['a'])
    expect(d.due(1900)).toEqual(['b'])
  })
})

describe('createAutoExporter', () => {
  let store: Store, root: string, folder: string, on: boolean, busy: Set<string>, now: number
  const statuses: boolean[] = []
  const make = () => createAutoExporter({ store, indexFile: join(root, 'auto-export.json'), folder: () => (on ? folder : undefined), credit: () => false,
    busy: (id) => busy.has(id), now: () => now, quietMs: 1000, maxWaitMs: 5000, status: (s) => statuses.push(s.failed) })
  const files = () => readdirSync(folder).sort()
  const add = (title: string, over: Partial<Meeting> = {}) => store.createMeeting({ title, startedAt: at, endedAt: at + 1000, eventId: null, app: null, attendees: [], state: 'done', ...over })
  const settle = async (x: ReturnType<typeof make>) => { await x.tick(); now += 2000; await x.tick() }

  beforeEach(() => {
    store = openStore(':memory:')
    root = mkdtempSync(join(tmpdir(), 'yogurt-auto-export-'))
    folder = join(root, 'Notes'); mkdirSync(folder)
    on = true; busy = new Set(); now = 0; statuses.length = 0
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => { vi.restoreAllMocks(); try { chmodSync(folder, 0o755) } catch { /* gone */ } rmSync(root, { recursive: true, force: true }) })

  it('writes a meeting once its changes settle, and nothing from before it was turned on', async () => {
    add('Before')
    const x = make(); x.start()
    const m = add('Standup')
    store.setNotes(m.id, { mine: 'one' })
    await x.tick()
    expect(files()).toEqual([])
    now += 2000; await x.tick()
    expect(files()).toEqual(['2026-03-07 0905 Standup.md'])
    expect(readFileSync(join(folder, files()[0]), 'utf8')).toContain('one')
  })

  it('updates the same file when the notes change, and renames it when the title does', async () => {
    const x = make(); x.start()
    const m = add('Standup')
    await settle(x)
    store.setNotes(m.id, { mine: 'later' }); await settle(x)
    expect(files()).toEqual(['2026-03-07 0905 Standup.md'])
    expect(readFileSync(join(folder, files()[0]), 'utf8')).toContain('later')
    store.updateMeeting(m.id, { title: 'Daily' }); await settle(x)
    expect(files()).toEqual(['2026-03-07 0905 Daily.md'])
  })

  it('keeps the file name across restarts, and two meetings with one name get two files', async () => {
    let x = make(); x.start()
    add('Sync'); await settle(x)
    const b = add('Sync'); await settle(x)
    expect(files()).toEqual(['2026-03-07 0905 Sync (2).md', '2026-03-07 0905 Sync.md'])
    x = make()
    store.setNotes(b.id, { mine: 'b notes' }); await settle(x)
    expect(files()).toEqual(['2026-03-07 0905 Sync (2).md', '2026-03-07 0905 Sync.md'])
    expect(readFileSync(join(folder, '2026-03-07 0905 Sync (2).md'), 'utf8')).toContain('b notes')
  })

  it('waits for a recording to end and for notes being written', async () => {
    const x = make(); x.start()
    const m = add('Call', { state: 'recording', endedAt: null })
    await settle(x)
    expect(files()).toEqual([])
    busy.add(m.id)
    store.updateMeeting(m.id, { state: 'done', endedAt: at + 5000 }); await settle(x)
    expect(files()).toEqual([])
    busy.delete(m.id)
    now += 2000; await x.tick()
    expect(files()).toEqual(['2026-03-07 0905 Call.md'])
  })

  it('keeps the file when a meeting is trashed or deleted', async () => {
    const x = make(); x.start()
    const m = add('Old'); await settle(x)
    store.trashMeeting(m.id); await settle(x)
    store.deleteMeeting(m.id); await settle(x)
    expect(files()).toEqual(['2026-03-07 0905 Old.md'])
  })

  it('leaves no half-written or temporary files behind', async () => {
    const x = make(); x.start()
    add('A'); await settle(x)
    expect(files().filter((f) => !f.endsWith('.md') || f.startsWith('.'))).toEqual([])
  })

  it('a missing folder is reported once, never created, and the meeting is written on the next change after it is back', async () => {
    const x = make(); x.start()
    rmSync(folder, { recursive: true })
    const m = add('Trip'); await settle(x)
    expect(existsSync(folder)).toBe(false)
    expect(x.status().failed).toBe(true)
    expect(console.error).toHaveBeenCalledTimes(1)
    mkdirSync(folder)
    add('Other'); await settle(x)
    expect(files()).toEqual(['2026-03-07 0905 Other.md', '2026-03-07 0905 Trip.md'])
    expect(x.status().failed).toBe(false)
    expect(statuses).toEqual([true, false])
    expect(m.id).toBeTruthy()
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a folder it cannot write to is reported, not thrown', async () => {
    const x = make(); x.start()
    chmodSync(folder, 0o555)
    add('Locked'); await settle(x)
    expect(x.status().failed).toBe(true)
  })

  it('does nothing while turned off', async () => {
    on = false
    const x = make(); x.start()
    add('Quiet'); await settle(x)
    expect(files()).toEqual([])
  })

  it('saves earlier meetings on request, skipping the Trash, and says how far along it is', async () => {
    add('One'); add('Two', { startedAt: at + 60_000 }); const t = add('Gone'); store.trashMeeting(t.id)
    const x = make(); x.start()
    const seen: Array<[number, number]> = []
    const r = await x.saveEarlier((done, total) => seen.push([done, total]))
    expect(r).toEqual({ saved: 2, failed: false })
    expect(files()).toEqual(['2026-03-07 0905 One.md', '2026-03-07 0906 Two.md'])
    expect(seen.at(-1)).toEqual([2, 2])
  })

  it('a file someone put in place of ours is left alone', async () => {
    const x = make(); x.start()
    const m = add('Plan'); await settle(x)
    writeFileSync(join(folder, '2026-03-07 0905 Plan.md'), 'replaced by hand')
    store.setNotes(m.id, { mine: 'new' }); await settle(x)
    expect(readFileSync(join(folder, '2026-03-07 0905 Plan.md'), 'utf8')).toBe('replaced by hand')
    expect(readFileSync(join(folder, '2026-03-07 0905 Plan (2).md'), 'utf8')).toContain('new')
  })

  it('never overwrites a file it did not write, and starts fresh in a new folder', async () => {
    writeFileSync(join(folder, '2026-03-07 0905 Mine.md'), 'my own file')
    const x = make(); x.start()
    add('Mine'); await settle(x)
    expect(readFileSync(join(folder, '2026-03-07 0905 Mine.md'), 'utf8')).toBe('my own file')
    expect(files()).toContain('2026-03-07 0905 Mine (2).md')
    const other = join(root, 'Elsewhere'); mkdirSync(other); folder = other
    x.start()
    await x.saveEarlier()
    expect(files()).toEqual(['2026-03-07 0905 Mine.md'])
  })
})
