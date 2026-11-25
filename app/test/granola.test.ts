import { afterEach, describe, expect, it, vi } from 'vitest'
import { granolaApi, granolaCsv, granolaUsed } from '../src/main/granola'
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { meetingImporter } from '../src/main/mcp/importMeeting'
import { setup, json } from './mcpRig'

afterEach(() => vi.restoreAllMocks())

it('requires a recent matching data file and accepts the exact 90-day boundary', () => {
  const home = mkdtempSync(join(tmpdir(), 'yogurt-used-test-'))
  const dir = join(home, 'Library', 'Application Support', 'Granola')
  const now = Date.UTC(2026, 10, 10)
  const used = () => granolaUsed('darwin', home, {}, now)
  const touch = (name: string, age: number) => {
    const file = join(dir, name), at = new Date(now - age * 86_400_000)
    writeFileSync(file, ''); utimesSync(file, at, at)
  }
  try {
    expect(used()).toBe(false)
    mkdirSync(dir, { recursive: true })
    touch('other.json', 1); touch('granola.db', 91); touch('cache-v6.json.enc', -1)
    expect(used()).toBe(false)
    touch('cache-v6.json.enc', 90)
    expect(used()).toBe(true)
    touch('cache-v6.json.enc', 91); touch('granola.db', 0)
    expect(used()).toBe(true)
    expect(granolaUsed('win32', home, {}, now)).toBe(false)
    expect(granolaUsed('linux', home, {}, now)).toBe(false)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

describe('Granola CSV', () => {
  it('reads named columns, a BOM, multiline quoted cells, doubled quotes and optional fields', async () => {
    const items = granolaCsv('\uFEFFsummary,document_title,document_created,extra\r\n"One,\n""two""",Weekly,2026-10-01 10:30:00,unused\r\n')
    expect(items).toHaveLength(1)
    const args = await items[0].read()
    expect(args).toMatchObject({ summary: 'One,\n"two"', title: 'Weekly', started_at: '2026-10-01T10:30:00Z' })
    expect(args.source_id).toMatch(/^granola:csv-/)
    const missing = await granolaCsv('summary\nWords')[0].read()
    expect(missing.title).toBe('Untitled meeting')
    expect((await granolaCsv('summary\nWords', new Date(0))[0].read()).source_id).toBe(missing.source_id)
    expect(() => granolaCsv('unrelated\nA')).toThrow(/CSV/)
    expect(() => granolaCsv('summary\n"unterminated')).toThrow(/CSV/)
  })
})

const noWait = async () => {}
const note = { id: 'not_ABC', web_url: 'https://notes.granola.ai/d/fake-document', title: 'Planning', created_at: '2026-01-01T09:00:00Z',
  owner: { name: 'Mara' }, attendees: [{ email: 'lee@example.com' }], private_notes_markdown: 'My list', summary_markdown: 'A cobalt notebook' }
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

it('previews every page without reading a note, deduplicates overlapping pages and retries throttled requests', async () => {
  const request = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'Retry-After': '2' } }))
    .mockResolvedValueOnce(reply({ notes: [note], hasMore: true, cursor: 'a+b' }))
    .mockResolvedValueOnce(reply({ notes: [note, { ...note, id: 'not_deleted', deleted_at: 'today' }], hasMore: false, cursor: null }))
  const wait = vi.fn(noWait)
  expect(await granolaApi('fiction', request, wait).list()).toEqual([{ id: note.id, title: 'Planning' }])
  expect(request.mock.calls[2][0]).toBe('https://public-api.granola.ai/v1/notes?page_size=30&cursor=a%2Bb')
  expect(request.mock.calls[0][1]).toMatchObject({ redirect: 'error', headers: { Authorization: 'Bearer fiction' } })
  expect(wait.mock.calls[1]).toEqual([expect.any(Number)])
  const bad = vi.fn(async () => reply({ notes: [], hasMore: true, cursor: 'repeated' }))
  await expect(granolaApi('fiction', bad, noWait).list()).rejects.toThrow(/response/)
  expect(bad).toHaveBeenCalledTimes(2)
})

it('reads a large transcript in pages and skips the same document when it later comes from CSV', async () => {
  const line = { text: 'Launch day', speaker: { source: 'microphone', diarization_label: 'Speaker A' }, start_time: '2026-01-01T09:00:02Z', end_time: '2026-01-01T09:00:06Z' }
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(reply({}, 413)).mockResolvedValueOnce(reply(note))
    .mockResolvedValueOnce(reply({ transcript: [line], hasMore: true, cursor: 'next' }))
    .mockResolvedValueOnce(reply({ transcript: [{ ...line, speaker: { attribution: 'me' } }], hasMore: false, cursor: null }))
  const args = await granolaApi('fiction', request, noWait).read(note.id)
  const { mcp, store, calls } = setup({ changes: true })
  const saved = await json(mcp, 'create_meeting', args)
  expect(store.meeting(saved.id)).toMatchObject({ source: 'import', sourceId: 'granola:fake-document', state: 'done' })
  expect(store.notes(saved.id)).toMatchObject({ mine: 'My list', enhanced: 'A cobalt notebook' })
  expect(store.segments(saved.id).map(s => [s.speaker, s.startMs])).toEqual([['Speaker A', 2000], ['Mara', 2000]])
  expect(store.search('cobalt', 10).map(m => m.meetingId)).toContain(saved.id)
  expect(calls).toContainEqual(['imported', saved.id])
  const csv = granolaCsv('document_id,notes\nfake-document,My list')
  expect(await json(mcp, 'create_meeting', await csv[0].read())).toMatchObject({ id: saved.id, already_imported: true })
})

it('keeps credentials out of error messages and never mistakes a failed list for zero meetings', async () => {
  await expect(granolaApi('fake-secret', async () => reply({ error: 'fake-secret' }, 401), noWait).list()).rejects.toThrow('Check your Granola API key and its access.')
  await expect(granolaApi('fake-secret', async () => reply({}), noWait).list()).rejects.toThrow(/response/)
})

it('adds a missing transcript from CSV once, preserving the existing note and all edits', async () => {
  const { store } = setup()
  const app = { imported:vi.fn(), changed:vi.fn(), rewriteSummary:vi.fn(), notesReady:() => true }
  const importer = meetingImporter({ store, me:() => 'Lee', app }, () => undefined, () => {})
  const base = { source_id:'granola:sample', started_at:'2026-02-01T09:00Z', title:'Earlier note', summary:'My edited summary' }
  const first = importer.one(base)
  const csv = await granolaCsv('document_id,document_title,summary,transcript\nsample,Export,Other summary,Lee: My words')[0].read()
  expect(importer.one(csv,true)).toMatchObject({id:first.id,already_imported:true})
  importer.one(csv,true)
  expect(store.segments(first.id).map(s => s.text)).toEqual(['My words'])
  expect(store.notes(first.id).enhanced).toBe('My edited summary')
  expect(store.meeting(first.id)?.title).toBe('Earlier note')
})
