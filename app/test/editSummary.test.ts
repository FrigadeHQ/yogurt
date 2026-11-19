import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { editNotes, editPrompt, enhancePrompt, transcriptHead, type Llm } from '../src/main/notes/enhance'
import { hookNotes } from '../src/main/notes'
import { createQueue } from '../src/main/notes/queue'
import { openStore, type Segment, type Store } from '../src/main/store'
import type { NoteView } from '../src/shared/types'

const seg = (startMs: number, text: string, speaker: string | null = 'Priya Nair'): Segment => ({ id: startMs, meetingId: 'm', track: 'them', startMs, endMs: startMs + 1000, text, speaker })
/** a word is a token: close enough for tests */
const words = (s: string) => s.split(/\s+/).filter(Boolean).length
const answer = (prompt: string) => /<notes>\n([\s\S]*?)\n<\/notes>/.exec(prompt)![1] + '\n- Budget: 40,000 EUR.'

describe('editPrompt', () => {
  it('applies the instruction to the notes as they are, adding nothing without the meeting', () => {
    const p = editPrompt({ notes: '## Plan\n- Ship Tuesday', note: 'add the budget' })
    expect(p).toContain('<notes>\n## Plan\n- Ship Tuesday\n</notes>')
    expect(p).toContain('changed only as it asks')
    expect(p).toContain('add no fact they do not already say')
    expect(p).not.toContain('<transcript>')
    // the instruction comes last, quoted: never read as meeting content
    expect(p.endsWith('\n"add the budget"')).toBe(true)
  })
  it('starts like the notes prompt when it reads the transcript, so what the model read for the notes is used again', () => {
    const transcript = 'Priya Nair: We ship Tuesday.'
    const p = editPrompt({ notes: '- a', note: 'b', transcript })
    const notes = enhancePrompt({ title: '', attendees: [], mine: '', transcript, language: 'English' })
    const head = transcriptHead + transcript + '\n</transcript>\n'
    expect(p.startsWith(head)).toBe(true)
    expect(notes.startsWith(head)).toBe(true)
    expect(p).toContain('comes from the meeting above')
  })
})

describe('editNotes', () => {
  it('sends the summary without its marks and puts them back on what came from their notes', async () => {
    const prompts: string[] = [], tokens: string[] = []
    const llm: Llm = { contextSize: 32_000, count: async (xs) => xs.map(words), chat: async (prompt, onToken) => { prompts.push(prompt); const r = `Here are the notes:\n${answer(prompt)}`; onToken(r); return r } }
    const md = await editNotes({ notes: '## Plan\n- <mine>Ship on Tuesday</mine>\n- Email Wednesday', note: 'add the budget', mine: '- ship on tuesday', language: 'en' }, llm, (t) => tokens.push(t))
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).not.toContain('<mine>')
    expect(prompts[0]).not.toContain('<transcript>')
    // the lead-in goes, the marks come back
    expect(md).toBe('## Plan\n- <mine>Ship on Tuesday</mine>\n- Email Wednesday\n- Budget: 40,000 EUR.')
    expect(tokens.join('')).toContain('Budget')
  })
  it('reads a transcript that fits whole, and a long one in parts first', async () => {
    const run = async (contextSize: number) => {
      const prompts: string[] = [], parts: number[] = []
      const llm: Llm = { contextSize, count: async (xs) => xs.map(words), chat: async (prompt, onToken, o) => { prompts.push(prompt); const r = o?.summary ? '### Budget\n- 40,000 EUR' : answer(prompt); onToken(r); return r } }
      const segments = Array.from({ length: 40 }, (_, i) => seg(i * 1000, `${'word '.repeat(150)}line ${i}.`, i % 2 ? 'Priya Nair' : 'Bo Park'))
      const md = await editNotes({ notes: '## Plan\n- Ship Tuesday', note: 'add the budget', mine: '', segments, language: 'en' }, llm, () => {}, (n) => parts.push(n))
      return { prompts, parts, md }
    }
    const whole = await run(100_000)
    expect(whole.prompts).toHaveLength(1)
    expect(whole.prompts[0].startsWith(transcriptHead)).toBe(true)
    expect(whole.parts).toEqual([])
    const long = await run(4096)
    expect(long.parts.length).toBeGreaterThan(1)
    expect(long.prompts.at(-1)).toContain('notes on each part of a long meeting')
    expect(long.prompts.at(-1)).toContain('Part 1:\n### Budget')
    expect(long.md).toContain('Budget: 40,000 EUR.')
  })
  it('fails rather than cut a summary the model has no room to give back, or answers with nothing', async () => {
    const tiny: Llm = { contextSize: 2048, count: async (xs) => xs.map(words), chat: async () => '## Plan\n- x' }
    await expect(editNotes({ notes: '- a', note: 'b', mine: '', language: 'en' }, tiny, () => {})).rejects.toThrow('too long')
    const empty: Llm = { contextSize: 32_000, count: async (xs) => xs.map(words), chat: async () => '```\n```' }
    await expect(editNotes({ notes: '- a', note: 'b', mine: '', language: 'en' }, empty, () => {})).rejects.toThrow('empty')
  })
})

const dirs: string[] = [], stores: Store[] = []
afterEach(() => { stores.splice(0).forEach((s) => s.close()); dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })) })

function setup(o: { fail?: boolean } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'yogurt-edit-'))
  dirs.push(d)
  const store = openStore(join(d, 'yogurt.db'))
  stores.push(store)
  const m = store.createMeeting({ title: 'Sync', startedAt: 1, endedAt: 2, eventId: null, app: null, attendees: [], state: 'done' })
  store.addSegments([{ meetingId: m.id, track: 'them', startMs: 0, endMs: 1000, text: 'The budget is 40,000 EUR.', speaker: 'Priya Nair' }])
  store.setNotes(m.id, { mine: '', enhanced: '## Plan\n- Ship Tuesday', edited: false })
  const sent: NoteView[] = [], prompts: string[] = []
  const llm: Llm = { contextSize: 32_000, count: async (xs) => xs.map(words), chat: async (prompt, onToken) => { prompts.push(prompt); if (o.fail) throw new Error('model gave up'); const r = answer(prompt); onToken(r); return r } }
  const notes = hookNotes({
    store, queue: createQueue({ recording: () => false, smallMac: false }), model: { llm: async () => llm },
    transcribed: async () => {}, language: () => 'en', onStop: () => {}, send: (v) => sent.push(v), changed: () => {},
  })
  return { store, m, notes, sent, prompts }
}

describe('Edit summary', () => {
  it('keeps their edits, marks the summary edited, and Undo puts back what was there', async () => {
    const s = setup()
    // their own change to the summary, still in the editor's save path
    s.notes.setEnhanced(s.m.id, '## Plan\n- Ship Tuesday\n- Ann owns QA', 1)
    expect(await s.notes.edit(s.m.id, 'add the budget', false)).toBe(true)
    expect(s.prompts[0]).toContain('- Ann owns QA')
    expect(s.prompts[0]).not.toContain('<transcript>')
    expect(s.store.notes(s.m.id)).toMatchObject({ enhanced: '## Plan\n- Ship Tuesday\n- Ann owns QA\n- Budget: 40,000 EUR.', edited: true })
    expect(s.sent.map((v) => v.status)).toContain('writing')
    expect(s.notes.view(s.m.id).status).toBe('done')
    expect(s.notes.undoEdit(s.m.id)).toBe(true)
    expect(s.store.notes(s.m.id)).toMatchObject({ enhanced: '## Plan\n- Ship Tuesday\n- Ann owns QA', edited: true })
    // the open note swaps to it unless it has edits of its own
    expect(s.sent.at(-1)).toMatchObject({ enhanced: '## Plan\n- Ship Tuesday\n- Ann owns QA', rewrittenFrom: '## Plan\n- Ship Tuesday\n- Ann owns QA\n- Budget: 40,000 EUR.' })
    // once only
    expect(s.notes.undoEdit(s.m.id)).toBe(false)
  })
  it('reads the transcript only when asked, and Undo of an unedited summary leaves it unedited', async () => {
    const s = setup()
    expect(await s.notes.edit(s.m.id, 'add the budget', true)).toBe(true)
    expect(s.prompts[0]).toContain('Priya Nair: The budget is 40,000 EUR.')
    expect(s.notes.undoEdit(s.m.id)).toBe(true)
    expect(s.store.notes(s.m.id)).toMatchObject({ enhanced: '## Plan\n- Ship Tuesday', edited: false })
  })
  it('never undoes over a change made after the edit', async () => {
    const s = setup()
    await s.notes.edit(s.m.id, 'add the budget', false)
    s.notes.setEnhanced(s.m.id, '## Plan\n- Rewritten by hand', 5)
    expect(s.notes.undoEdit(s.m.id)).toBe(false)
    expect(s.store.notes(s.m.id).enhanced).toBe('## Plan\n- Rewritten by hand')
  })
  it('keeps the summary as it was when the model fails, and edits nothing without a note or a summary', async () => {
    const s = setup({ fail: true })
    expect(await s.notes.edit(s.m.id, 'add the budget', false)).toBe(false)
    expect(s.notes.view(s.m.id)).toMatchObject({ status: 'failed', enhanced: '## Plan\n- Ship Tuesday' })
    expect(s.notes.undoEdit(s.m.id)).toBe(false)
    const none = setup()
    expect(await none.notes.edit(none.m.id, '  ', false)).toBe(false)
    none.store.setNotes(none.m.id, { enhanced: '' })
    expect(await none.notes.edit(none.m.id, 'add the budget', false)).toBe(false)
    expect(none.prompts).toEqual([])
  })
})
