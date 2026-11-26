import { createHash } from 'node:crypto'
import { localDay, type MarkdownNote } from '../shared/markdownImport'
import { TITLE_MAX, NOTES_MAX } from '../shared/noteLimits'
import type { Store } from './store'

export function importMarkdown(store: Store, note: MarkdownNote) {
  const { filename, title, date, markdown } = note
  if (typeof filename !== 'string' || !/\.md$/i.test(filename) ||
      typeof title !== 'string' || !title.trim() || title.length > TITLE_MAX ||
      typeof markdown !== 'string' || !markdown.trim() || markdown.length > NOTES_MAX) throw new Error('Invalid Markdown note')
  const startedAt = localDay(date)
  if (startedAt === undefined) throw new Error('Invalid meeting date')
  // Re-importing the original file preserves any changes the user made inside Yogurt.
  const sourceId = 'markdown:' + createHash('sha256').update(filename).update('\0').update(markdown).digest('hex')
  return store.importMeeting({ title: title.trim(), startedAt, endedAt: startedAt, attendees: [],
    mine: '', summary: markdown, sourceId })
}
