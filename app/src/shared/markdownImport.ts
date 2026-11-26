import { TITLE_MAX } from './noteLimits'

export type MarkdownNote = { filename: string; title: string; date: string; markdown: string }

/** An ISO day at local noon, consistent with calendar-day navigation. Reject rolled-over dates. */
export function localDay(value: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const [year, month, day] = value.split('-').map(Number)
  const at = new Date(year, month - 1, day, 12)
  if (at.getFullYear() === year && at.getMonth() === month - 1 && at.getDate() === day) return at.getTime()
}

export function markdownPreview(filename: string, head: string) {
  const stem = filename.replace(/\.md$/i, '')
  const candidate = stem.match(/(?:^|\D)(\d{4}-\d{2}-\d{2})(?!\d)/)?.[1]
  const title = head.match(/^#[ \t]+([^\r\n]+)/m)?.[1] ?? stem
  return { title: title.trim().slice(0, TITLE_MAX), date: candidate && localDay(candidate) !== undefined ? candidate : '' }
}
