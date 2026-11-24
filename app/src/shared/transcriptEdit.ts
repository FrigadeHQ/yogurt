export type TranscriptChange =
  | { kind: 'wording'; id: number; expected: string; text: string }
  | { kind: 'original'; id: number; expected: string }
  | { kind: 'remove'; ids: number[] }
  | { kind: 'restore'; batch: string | null }
  | { kind: 'undo' }

export type EditResult =
  | { status: 'saved'; revision: number; count: number }
  | { status: 'conflict'; text: string; revision: number }
  | { status: 'stale' | 'unchanged' | 'unavailable' }

export type RemovedSpan = { id: number; startMs: number; endMs: number }
export function validChange(x: unknown): x is TranscriptChange {
  if (!x || typeof x !== 'object' || !('kind' in x)) return false
  const row = (id: unknown) => typeof id === 'number' && Number.isSafeInteger(id) && id > 0
  switch (x.kind) {
    case 'undo': return true
    case 'restore': return 'batch' in x && (x.batch === null || (typeof x.batch === 'string' && x.batch.length === 36))
    case 'remove': return 'ids' in x && Array.isArray(x.ids) && x.ids.length > 0 && x.ids.every(row)
    case 'original':
    case 'wording': return 'id' in x && row(x.id) && 'expected' in x && typeof x.expected === 'string' &&
      (x.kind === 'original' || ('text' in x && typeof x.text === 'string' && !!x.text.trim() && x.text.length <= 2_000_000 && !/[\r\n]/.test(x.text)))
    default: return false
  }
}
