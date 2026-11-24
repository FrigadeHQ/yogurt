export const transcriptKey = (line: { id?: number; track: string; startMs: number }) => line.id === undefined ? `${line.track}:${line.startMs}` : String(line.id)
export type TranscriptMatch = { key: string; start: number; end: number }

/** Literal, case-insensitive occurrences. RegExp offsets refer to the original UTF-16 text, even when case folding changes length. */
export function transcriptMatches(lines: ReadonlyArray<{ track: string; startMs: number; text: string }>, query: string): TranscriptMatch[] {
  const text = query.trim()
  if (!text) return []
  const pattern = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
  const matches: TranscriptMatch[] = []
  for (const line of lines) {
    for (const match of line.text.matchAll(pattern)) matches.push({ key: transcriptKey(line), start: match.index, end: match.index + match[0].length })
  }
  return matches
}

/** Keep the same occurrence when another track finishes an earlier line or new lines arrive. */
export function transcriptMatchIndex(matches: TranscriptMatch[], selected: TranscriptMatch | null): number {
  return selected ? Math.max(0, matches.findIndex(hit => hit.key === selected.key && hit.start === selected.start)) : 0
}

export function stepTranscriptMatch(current: number, step: number, count: number): number {
  return count ? ((current + step) % count + count) % count : 0
}

/** Keep fully visible matches still; centre an obscured match inside the usable reading area. */
export function transcriptFindScrollTop(hit: { top: number; bottom: number }, view: { top: number; bottom: number; scrollTop: number }): number | null {
  if (hit.top >= view.top && hit.bottom <= view.bottom) return null
  return view.scrollTop + (hit.top + hit.bottom - view.top - view.bottom) / 2
}
