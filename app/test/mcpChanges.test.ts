import { describe, expect, it } from 'vitest'
import { MCP_TOOLS } from '../src/main/mcp/server'
import { setup, call, json, EVENT } from './mcpRig'

const reading = new Set(MCP_TOOLS.filter((t) => (t.annotations as { readOnlyHint: boolean }).readOnlyHint).map((t) => t.name))
const changing = MCP_TOOLS.map((t) => t.name).filter((n) => !reading.has(n))

describe('changes from AI apps, while the person has not allowed them', () => {
  it.each(changing)('%s changes nothing and says where to allow changes', async (name) => {
    const { mcp, store, older, calls, logs } = setup({ changes: false })
    const before = JSON.stringify([store.meetings({ limit: 10 }), store.folders(), store.notes(older.id)])
    const r = await call(mcp, name, { id: older.id, folder: 'x', name: 'x', title: 'x', markdown: 'x', started_at: '2026-11-01T00:00:00Z', summary: 'x', meetings: [] })
    expect(r).toEqual({ isError: true, text: expect.stringContaining('"Let AI apps make changes"') })
    expect(JSON.stringify([store.meetings({ limit: 10 }), store.folders(), store.notes(older.id)])).toBe(before)
    expect(calls).toEqual([])
    expect(logs).toEqual([`${name} refused: changes off ${older.id}`])
  })
  it('reading still works', async () => {
    const { mcp } = setup({ changes: false })
    expect((await json(mcp, 'list_meetings')).length).toBe(2)
  })
  it('with AI apps off altogether, the off message comes first', async () => {
    const { mcp } = setup({ enabled: false, changes: true })
    expect((await call(mcp, 'create_folder', { name: 'Sales' })).text).toContain('connecting AI apps turned off')
  })
})

describe('folders, with changes allowed', () => {
  it('makes, renames and deletes a folder (its meetings stay), and tells the windows', async () => {
    const { mcp, store, older, calls, logs } = setup({ changes: true })
    const f = await json(mcp, 'create_folder', { name: '  Sales  ' })
    expect(f).toEqual({ id: expect.any(String), name: 'Sales' })
    expect(await call(mcp, 'create_folder', { name: 'sales' })).toMatchObject({ isError: true, text: expect.stringContaining('already a folder') })
    expect(await json(mcp, 'rename_folder', { folder: 'Sales', name: 'Deals' })).toEqual({ id: f.id, name: 'Deals' })
    expect((await json(mcp, 'add_to_folder', { folder: f.id, id: older.id })).folders).toEqual([{ id: f.id, name: 'Deals' }])
    expect((await json(mcp, 'remove_from_folder', { folder: 'deals', id: older.id })).folders).toEqual([])
    expect((await call(mcp, 'delete_folder', { folder: 'Deals' })).text).toContain('stay')
    expect(store.folders()).toEqual([])
    expect(store.meeting(older.id)).toBeDefined()
    expect(calls.filter((c) => c[0] === 'changed')).toHaveLength(5)
    // ids only in the log, never the names
    expect(logs).toContain(`create_folder made ${f.id}`)
    expect(logs.join('\n')).not.toMatch(/Sales|Deals/)
  })
  it('refuses a bad folder or name in plain words, listing the folders there are', async () => {
    const { mcp, store, older } = setup({ changes: true })
    store.createFolder('Finance')
    expect(await call(mcp, 'add_to_folder', { folder: 'Sales', id: older.id })).toMatchObject({ isError: true, text: expect.stringContaining('Finance') })
    expect(await call(mcp, 'create_folder', { name: 'x'.repeat(201) })).toMatchObject({ isError: true, text: expect.stringContaining('at most 200') })
    expect(await call(mcp, 'create_folder', { name: 42 })).toMatchObject({ isError: true, text: 'name must be text.' })
    expect(await call(mcp, 'create_folder', { name: '   ' })).toMatchObject({ isError: true, text: "name can't be blank." })
  })
  it("accepts or dismisses Yogurt's folder suggestion", async () => {
    const { mcp, store, older, newer } = setup({ changes: true })
    const f = store.createFolder('Finance')
    expect(await call(mcp, 'accept_folder_suggestion', { id: older.id })).toMatchObject({ isError: true, text: expect.stringContaining('no folder suggestion') })
    store.saveFolderSuggestion(older.id, { folderId: f.id, confidence: 0.9 }, 'v')
    expect((await json(mcp, 'accept_folder_suggestion', { id: older.id })).folders).toEqual([{ id: f.id, name: 'Finance' }])
    expect(store.folderSuggestion(older.id).state).toBe('accepted')
    store.saveFolderSuggestion(newer.id, { folderId: f.id, confidence: 0.9 }, 'v')
    await call(mcp, 'dismiss_folder_suggestion', { id: newer.id })
    expect(store.folderSuggestion(newer.id).state).toBe('dismissed')
  })
})

describe('meetings, with changes allowed', () => {
  it("renames, sets who was there and links a calendar event through the app's own functions", async () => {
    const { mcp, older, calls } = setup({ changes: true })
    expect((await json(mcp, 'rename_meeting', { id: older.id, title: 'Q4 budget' })).title).toBe('Q4 budget')
    expect(await call(mcp, 'rename_meeting', { id: older.id, title: 'x'.repeat(201) })).toMatchObject({ isError: true })
    expect((await json(mcp, 'set_attendees', { id: older.id, attendees: [{ name: 'Bo Park' }, { name: 'Ann Lee', email: 'ann@acme.com' }] })).attendees)
      .toEqual([{ name: 'Bo Park', email: null }, { name: 'Ann Lee', email: 'ann@acme.com' }])
    expect(await call(mcp, 'set_attendees', { id: older.id, attendees: [{ email: 'x@y.z' }] })).toMatchObject({ isError: true, text: 'name is needed.' })
    expect(await call(mcp, 'set_attendees', { id: older.id, attendees: Array.from({ length: 101 }, () => ({ name: 'A' })) })).toMatchObject({ isError: true, text: expect.stringContaining('at most 100') })
    await json(mcp, 'link_calendar_event', { id: older.id, event_id: EVENT.id, date: '2026-11-21' })
    expect(calls).toContainEqual(['linkEvent', older.id, EVENT.id, expect.any(Number)])
    expect(await call(mcp, 'link_calendar_event', { id: older.id, event_id: 'gone' })).toMatchObject({ isError: true, text: expect.stringContaining('not on the calendar') })
    await json(mcp, 'unlink_calendar_event', { id: older.id })
    expect(calls).toContainEqual(['unlinkEvent', older.id])
  })
  it('moves a meeting to the Trash and back, never while it records', async () => {
    const { mcp, store, older } = setup({ changes: true })
    expect((await call(mcp, 'trash_meeting', { id: older.id })).text).toContain('restore_meeting')
    expect(store.meeting(older.id)?.trashedAt).toBeDefined()
    expect(await call(mcp, 'get_meeting', { id: older.id })).toMatchObject({ isError: true })
    expect(await call(mcp, 'restore_meeting', { id: 'nope' })).toMatchObject({ isError: true, text: expect.stringContaining('list_trash') })
    expect((await json(mcp, 'restore_meeting', { id: older.id })).id).toBe(older.id)
    expect(store.meeting(older.id)?.trashedAt).toBeUndefined()
    const busy = setup({ changes: true, app: { trash: () => 'recording' } })
    expect(await call(busy.mcp, 'trash_meeting', { id: busy.older.id })).toMatchObject({ isError: true, text: expect.stringContaining('stop_recording') })
  })
})

describe('notes, with changes allowed', () => {
  it("replaces or adds to the person's notes, and replaces the summary", async () => {
    const { mcp, older } = setup({ changes: true })
    expect((await json(mcp, 'set_my_notes', { id: older.id, markdown: '- call Ann back', mode: 'append' })).myNotes).toBe('travel flat\n\n- call Ann back')
    expect((await json(mcp, 'set_my_notes', { id: older.id, markdown: 'fresh' })).myNotes).toBe('fresh')
    expect((await json(mcp, 'set_summary', { id: older.id, markdown: '## New\n- Done.' })).summary).toBe('## New\n- Done.')
    expect(await call(mcp, 'set_my_notes', { id: older.id, markdown: 'x', mode: 'merge' })).toMatchObject({ isError: true, text: expect.stringContaining('"replace", "append"') })
  })
  it('says so while the summary is being written', async () => {
    const { mcp, older } = setup({ changes: true, app: { setSummary: () => 'busy' } })
    expect(await call(mcp, 'set_summary', { id: older.id, markdown: 'x' })).toMatchObject({ isError: true, text: expect.stringContaining('writing') })
  })
  it('has the summary written again, with an instruction', async () => {
    const { mcp, older, calls } = setup({ changes: true })
    expect((await call(mcp, 'rewrite_summary', { id: older.id, instruction: 'shorter' })).text).toContain('writing the summary again')
    expect(calls).toContainEqual(['rewriteSummary', older.id, 'shorter'])
    expect(await call(mcp, 'rewrite_summary', { id: older.id, instruction: 'x'.repeat(241) })).toMatchObject({ isError: true })
  })
})

describe('recording, with changes allowed', () => {
  it('starts, pauses, resumes and stops a recording through the same functions as the app', async () => {
    const { mcp, calls } = setup({ changes: true })
    for (const t of ['pause_recording', 'resume_recording', 'stop_recording']) expect(await call(mcp, t)).toMatchObject({ isError: true, text: 'Yogurt is not recording.' })
    const m = await json(mcp, 'start_recording', { title: 'Standup' })
    expect(m).toMatchObject({ title: 'Standup', recording: true })
    expect(await call(mcp, 'start_recording')).toMatchObject({ isError: true, text: expect.stringContaining('already recording') })
    await call(mcp, 'pause_recording')
    await call(mcp, 'resume_recording', { id: m.id })
    expect(await call(mcp, 'stop_recording', { id: 'other' })).toMatchObject({ isError: true, text: expect.stringContaining('not the one recording') })
    expect((await call(mcp, 'stop_recording')).text).toContain('Stopped recording')
    expect(calls.filter((c) => /Recording$/.test(c[0]))).toEqual([['startRecording', { title: 'Standup' }], ['pauseRecording', m.id, true], ['pauseRecording', m.id, false], ['stopRecording', m.id]])
  })
  it('takes notes for a calendar event, and says when the event is gone', async () => {
    const { mcp, calls } = setup({ changes: true })
    await json(mcp, 'start_recording', { event_id: EVENT.id })
    expect(calls).toContainEqual(['startRecording', { eventId: EVENT.id }])
    const gone = setup({ changes: true, app: { startRecording: async () => ({ error: 'gone' }) } })
    expect(await call(gone.mcp, 'start_recording', { event_id: 'x' })).toMatchObject({ isError: true, text: expect.stringContaining('not coming up') })
  })
})

describe('settings, with changes allowed', () => {
  it('sets custom words, the spoken language and the summary language, and nothing else', async () => {
    const { mcp, calls } = setup({ changes: true })
    expect(await json(mcp, 'set_custom_words', { words: ['Acme', 'Kubernetes'] })).toEqual({ custom_words: ['Acme', 'Kubernetes'] })
    expect(await call(mcp, 'set_custom_words', { words: [1] })).toMatchObject({ isError: true })
    await call(mcp, 'set_spoken_language', { language: 'multi' })
    expect(await call(mcp, 'set_spoken_language', { language: 'fr' })).toMatchObject({ isError: true })
    await call(mcp, 'set_summary_language', { language: 'de' })
    await call(mcp, 'set_summary_language', { language: '' })
    expect(await call(mcp, 'set_summary_language', { language: 'klingon' })).toMatchObject({ isError: true, text: expect.stringContaining('de (German)') })
    expect(calls).toEqual([['setJargon', ['Acme', 'Kubernetes']], ['setSpoken', 'multi'], ['setSummaryLanguage', 'de'], ['setSummaryLanguage', '']])
    expect(MCP_TOOLS.map((t) => t.name).filter((n) => /privacy|permission|ai_apps|mcp|keep_recordings|delete_audio/.test(n))).toEqual([])
  })
})
