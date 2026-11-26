import { describe, expect, it } from 'vitest'
import { localDay, markdownPreview } from '../src/shared/markdownImport'
import { importMarkdown } from '../src/main/markdownImport'
import { openStore } from '../src/main/store'

const note = { filename: '2026-02-17 planning.md', date: '2026-02-17', title: 'Planning', markdown: '# Planning\r\n\r\n- **Evidence** stays here.\r\n' }

describe('Markdown meeting import', () => {
  it('previews a heading and a real date, leaving missing or invalid dates to the user', () => {
    expect(markdownPreview(note.filename, note.markdown)).toEqual({ title: 'Planning', date: note.date })
    expect(markdownPreview('No date.md', 'Notes')).toEqual({ title: 'No date', date: '' })
    expect(markdownPreview('2026-02-30.md', '# Report')).toEqual({ title: 'Report', date: '' })
    expect(localDay('2024-02-29')).toBe(new Date(2024, 1, 29, 12).getTime())
  })
  it('can retry an import after a related write fails', () => {
    const store = openStore(':memory:')
    const draft = { title: 'Planning', startedAt: 1, endedAt: 2, attendees: [], mine: '', summary: 'Given', sourceId: 'test-id' }
    try {
      expect(() => store.importMeeting(draft, m => store.addToFolder('missing-folder', m.id))).toThrow()
      expect(store.meetingFromSource('import', draft.sourceId)).toBeUndefined()
      expect(store.importMeeting(draft).added).toBe(true)
    } finally { store.close() }
  })
  it('preserves source Markdown, exposes it in search, and skips a repeat after the user edits the note', () => {
    const store = openStore(':memory:')
    try {
      const first = importMarkdown(store, note)
      expect(first.added).toBe(true)
      expect(store.notes(first.meeting.id)).toMatchObject({ enhanced: note.markdown, edited: true })
      expect(store.segments(first.meeting.id)).toEqual([])
      expect(store.search('Evidence', 10).map(m => m.meetingId)).toContain(first.meeting.id)
      store.setNotes(first.meeting.id, { enhanced: 'Edited here.' })
      expect(importMarkdown(store, note)).toMatchObject({ added: false, meeting: { id: first.meeting.id } })
      expect(store.notes(first.meeting.id).enhanced).toBe('Edited here.')
      expect(() => importMarkdown(store, { ...note, date: '' })).toThrow()
      expect(() => importMarkdown(store, { ...note, markdown: '  ' })).toThrow()
      expect(store.meetings({ limit: 10 })).toHaveLength(1)
    } finally { store.close() }
  })
})
