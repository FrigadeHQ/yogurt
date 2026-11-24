import { transcriptKey, transcriptMatches, type TranscriptMatch } from '../../shared/transcriptFind'

type TextSpan = { node: Text; start: number; end: number }

/** Search and range offsets share the same rendered text, including nested word spans. */
export function transcriptFindRanges(list: HTMLElement, lines: ReadonlyArray<{ track: string; startMs: number; text: string }>, query: string) {
  const rows = new Map<string, { root: Element; text: string; spans: TextSpan[] }>()
  for (const row of list.querySelectorAll<HTMLElement>('[data-key]')) {
    const root = row.querySelector('[data-testid="transcript-text"]')
    if (!root) continue
    const spans: TextSpan[] = [], chunks: string[] = []
    const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let node: Node | null, offset = 0
    while ((node = walker.nextNode())) {
      const text = node as Text
      if (!text.length) continue
      spans.push({ node: text, start: offset, end: offset + text.length })
      chunks.push(text.data); offset += text.length
    }
    rows.set(row.dataset.key!, { root, text: chunks.join(''), spans })
  }
  const rendered = lines.map(line => ({ ...line, text: rows.get(transcriptKey(line))?.text ?? '' }))
  const matches: TranscriptMatch[] = [], ranges: Range[] = []
  for (const hit of transcriptMatches(rendered, query)) {
    const row = rows.get(hit.key)!
    // DOM can change between indexing and placement; discard an unplaceable occurrence.
    try {
      const start = boundary(row.spans, hit.start), end = boundary(row.spans, hit.end)
      if (!row.root.isConnected || !start || !end || !row.root.contains(start.node) || !row.root.contains(end.node)) continue
      const range = row.root.ownerDocument.createRange()
      range.setStart(start.node, hit.start - start.start)
      range.setEnd(end.node, hit.end - end.start)
      if (range.toString() !== row.text.slice(hit.start, hit.end)) continue
      matches.push(hit); ranges.push(range)
    } catch { /* A stale row must never take down the transcript. */ }
  }
  return { query, matches, ranges }
}

function boundary(spans: TextSpan[], offset: number) {
  let lo = 0, hi = spans.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (spans[mid].end < offset) lo = mid + 1
    else hi = mid
  }
  return spans[lo]
}
