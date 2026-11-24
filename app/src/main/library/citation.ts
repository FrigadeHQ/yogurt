import { citationCardPassage } from '../../shared/citationCard'
import { citationExcerptText } from '../../shared/citations'
import type { LibrarySource } from '../../shared/types'
import type { Store } from '../store'

/** Check the whole original quote against the same timed rows. A partial match is insufficient. */
export function currentCitation(store: Store, source: LibrarySource, sentence: string): LibrarySource {
  const { meetingId, atMs } = source
  const meeting = store.meeting(meetingId)
  const base = { n: source.n, meetingId, title: meeting?.title ?? '', startedAt: source.startedAt, atMs }
  const unknown = { ...base, changed: 'unknown' as const }
  if (!meeting || meeting.trashedAt != null) return unknown
  const quote = citationCardPassage(source,sentence).match.text
  if (!quote) return unknown
  if (atMs === null) {
    const n = store.notes(meetingId)
    return [n.mine, n.needsReview ? '' : n.enhanced ?? ''].some(md => citationExcerptText(md).includes(quote))
      ? { ...base, excerpt: quote } : unknown
  }
  const saved = source.transcript?.lines
  if (!saved?.length) return unknown
  const text = saved.map(l => citationExcerptText(l.text))
  const joined = text.join(' '), from = joined.indexOf(quote)
  if (from < 0 || joined.indexOf(quote,from+1) >= 0) return unknown
  const visible = store.segments(meetingId), removed = store.removedSpans(meetingId)
  const resolve = (line: typeof saved[number]) => {
    const same = (r: {track:string; startMs:number}) => r.track === line.track && r.startMs === line.startMs
    const hidden = removed.filter(same), candidates = visible.filter(same)
    return { removed: !candidates.length && hidden.length === 1, row: candidates.length === 1 && !hidden.length ? candidates[0] : undefined }
  }
  let offset = 0, first = -1, last = -1
  const rows = []
  let wordingChanged = false
  for (const [i, line] of saved.entries()) {
    const start = offset
    offset += text[i].length + 1
    if (offset-1 <= from || start >= from+quote.length) continue
    const target = resolve(line)
    if (target.removed) return { ...base, changed:'removed' }
    if (!target.row) return unknown
    if (first < 0) first = i
    last = i
    const part = text[i].slice(Math.max(0,from-start),from+quote.length-start)
    if (!citationExcerptText(target.row.text).includes(part)) wordingChanged = true
    rows.push(target.row)
  }
  if (!rows.length) return unknown
  const target = { ...base, atMs: rows[0].startMs, verifiedRow: rows[0].id, revision: meeting.transcriptRevision ?? 0 }
  if (wordingChanged || !rows.map(l=>citationExcerptText(l.text)).join(' ').includes(quote)) {
    return rows.length === 1 ? { ...target, changed:'wording', currentText:rows[0].text } : { ...base, changed:'wording' }
  }
  const before = first > 0 ? resolve(saved[first-1]).row?.text : undefined
  const after = last+1 < saved.length ? resolve(saved[last+1]).row?.text : undefined
  return { ...target, excerpt:quote, context:{before,after}, transcript:{ speakers:store.speakerOrder(meetingId), lines:rows } }
}
