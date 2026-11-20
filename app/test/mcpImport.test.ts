import { describe, expect, it } from 'vitest'
import { setup, call, json } from './mcpRig'

const granola = {
  title: 'Vendor call', started_at: '2026-10-20T14:00:00Z', attendees: [{ name: 'Ann Lee', email: 'ann@acme.com' }, { name: 'Raj Patel' }],
  transcript: '[00:05] Sam Rivera: Shall we start?\n[00:09] Raj Patel: The rollout slips to March.\n[00:20] Okay.',
  summary: '## Rollout\n- Moves to March.', my_notes: 'ask about March',
}

describe('bringing meetings in from other notes apps', () => {
  it('creates a finished meeting with its transcript, notes and summary, shown and searchable like one recorded here', async () => {
    const { mcp, store, calls } = setup({ changes: true })
    const got = await json(mcp, 'create_meeting', granola)
    expect(got).toMatchObject({ title: 'Vendor call', start: '2026-10-20T14:00:00.000Z', lines: 3, folder: null, summary: 'given' })
    const m = store.meeting(got.id)!
    expect(m).toMatchObject({ source: 'import', app: null, state: 'done', titleSource: 'user', startedAt: Date.parse('2026-10-20T14:00:00Z'), attendees: [{ name: 'Ann Lee', email: 'ann@acme.com' }, { name: 'Raj Patel', email: null }] })
    // ends where the transcript does
    expect(m.endedAt).toBe(m.startedAt + store.segments(m.id).at(-1)!.endMs)
    expect(store.segments(m.id).map((s) => [s.track, s.speaker, s.startMs, s.text])).toEqual([
      ['me', 'me', 5_000, 'Shall we start?'], ['them', 'Raj Patel', 9_000, 'The rollout slips to March.'], ['them', null, 20_000, 'Okay.']])
    expect(store.notes(m.id)).toEqual({ mine: 'ask about March', enhanced: '## Rollout\n- Moves to March.', edited: true })
    expect(store.search('rollout', 10).map((h) => h.meetingId)).toContain(m.id)
    expect(calls).toContainEqual(['imported', m.id])
    expect((await json(mcp, 'get_meeting', { id: m.id })).imported).toBe(true)
    expect((await call(mcp, 'get_transcript', { id: m.id })).text).toBe('[00:05] Sam Rivera: Shall we start?\n[00:09] Raj Patel: The rollout slips to March.\n[00:20] Them: Okay.')
  })
  it('reads the other text shapes, and lines given as JSON', async () => {
    const { mcp, store } = setup({ changes: true })
    const named = await json(mcp, 'create_meeting', { title: 'A', started_at: '2026-10-21T10:00:00Z', transcript: 'Ann Lee (00:00:04): Hi.\nBo Park (00:01:02): Hello.' })
    expect(store.segments(named.id).map((s) => [s.speaker, s.startMs])).toEqual([['Ann Lee', 4_000], ['Bo Park', 62_000]])
    const plain = await json(mcp, 'create_meeting', { title: 'B', started_at: '2026-10-21T11:00:00Z', transcript: 'Ann Lee: Hi.\nMe: Hello back.' })
    expect(store.segments(plain.id).map((s) => [s.track, s.speaker, s.startMs])).toEqual([['them', 'Ann Lee', 0], ['me', 'me', 1_000]])
    const lines = await json(mcp, 'create_meeting', { title: 'C', started_at: '2026-10-21T12:00:00Z', ended_at: '2026-10-21T12:30:00Z',
      transcript_lines: [{ start_ms: 1000, end_ms: 2500, speaker: 'Ann Lee', text: 'One.' }, { text: 'Two.' }] })
    expect(store.segments(lines.id).map((s) => [s.speaker, s.startMs, s.endMs])).toEqual([['Ann Lee', 1000, 2500], [null, 2500, 3500]])
    expect(store.meeting(lines.id)!.endedAt).toBe(Date.parse('2026-10-21T12:30:00Z'))
  })
  it('files it in a folder by name, making the folder when asked', async () => {
    const { mcp, store } = setup({ changes: true })
    expect(await call(mcp, 'create_meeting', { ...granola, folder: 'Vendors' })).toMatchObject({ isError: true, text: expect.stringContaining('No folder') })
    const got = await json(mcp, 'create_meeting', { ...granola, folder: 'Vendors', create_folder: true })
    expect(got.folder).toEqual({ id: expect.any(String), name: 'Vendors' })
    expect(store.foldersOf(got.id).map((f) => f.name)).toEqual(['Vendors'])
    const again = await json(mcp, 'create_meeting', { ...granola, folder: 'vendors', create_folder: true })
    expect(again.folder.id).toBe(got.folder.id)
    expect(store.folders()).toHaveLength(1)
  })
  it('has Yogurt write the summary instead, when asked', async () => {
    const { mcp, store, calls } = setup({ changes: true })
    const { summary: _, ...rest } = granola
    const got = await json(mcp, 'create_meeting', { ...rest, write_summary: true })
    expect(got.summary).toBe('Yogurt is writing it')
    expect(store.notes(got.id).enhanced).toBeNull()
    expect(calls).toContainEqual(['rewriteSummary', got.id, ''])
    expect(await call(mcp, 'create_meeting', { ...granola, write_summary: true })).toMatchObject({ isError: true, text: expect.stringContaining('not both') })
  })
  it('brings the same meeting in once, by its id in the other app', async () => {
    const { mcp, store } = setup({ changes: true })
    const first = await json(mcp, 'create_meeting', { ...granola, source_id: 'gr-1' })
    expect(await json(mcp, 'create_meeting', { ...granola, source_id: 'gr-1' })).toEqual({ id: first.id, title: 'Vendor call', already_imported: true })
    expect(store.meetings({ limit: 10 })).toHaveLength(3)
  })
  it('checks everything strictly before saving anything', async () => {
    const { mcp, store } = setup({ changes: true })
    const bad: Array<[Record<string, unknown>, string]> = [
      [{ ...granola, title: undefined }, 'title is needed.'],
      [{ ...granola, title: 'x'.repeat(201) }, 'at most 200'],
      [{ ...granola, started_at: 'yesterday' }, 'ISO time'],
      [{ ...granola, ended_at: '2026-10-19T00:00:00Z' }, 'before started_at'],
      [{ ...granola, transcript: undefined, summary: undefined, my_notes: undefined }, 'nothing in it'],
      [{ ...granola, transcript_lines: [{ text: 'x' }] }, 'not both'],
      [{ ...granola, transcript: undefined, transcript_lines: [{ start_ms: -1, text: 'x' }] }, 'start_ms'],
      [{ ...granola, transcript: undefined, transcript_lines: Array.from({ length: 20_001 }, () => ({ text: 'x' })) }, 'at most 20000'],
      [{ ...granola, attendees: 'Ann' }, 'must be a list'],
    ]
    for (const [args, says] of bad) expect(await call(mcp, 'create_meeting', args)).toMatchObject({ isError: true, text: expect.stringContaining(says) })
    expect(store.meetings({ limit: 10 })).toHaveLength(2)
  })
  it('brings in several at once, saying which could not come in and why', async () => {
    const { mcp, store } = setup({ changes: true })
    const got = await json(mcp, 'import_meetings', { meetings: [granola, { title: 'No start' }, { ...granola, title: 'Second' }] })
    expect(got).toEqual([expect.objectContaining({ index: 0, id: expect.any(String) }), { index: 1, error: 'started_at is needed.' }, expect.objectContaining({ index: 2, title: 'Second' })])
    expect(store.meetings({ limit: 10 })).toHaveLength(4)
    expect(await call(mcp, 'import_meetings', { meetings: Array.from({ length: 51 }, () => granola) })).toMatchObject({ isError: true, text: expect.stringContaining('at most 50') })
  })
  it('logs ids and counts, never titles, names or words', async () => {
    const { mcp, logs } = setup({ changes: true })
    const got = await json(mcp, 'create_meeting', { ...granola, folder: 'Vendors', create_folder: true })
    expect(logs.some((l) => l.startsWith(`create_meeting made ${got.id}: 3 lines, a summary, in `))).toBe(true)
    expect(logs.join('\n')).not.toMatch(/Vendor|Raj|Ann|March|rollout/i)
  })
})
