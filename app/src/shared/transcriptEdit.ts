export type TranscriptRowChange = { id: number; expected: string; text: string | null }
export type TranscriptDifference = { id:number; startMs:number; original:string; current:string | null }
export type TranscriptHistory = { canUndo:boolean; canRedo:boolean }
export type CommitTranscript = (revision: number, change: TranscriptChange) => Promise<EditResult>
export type TranscriptChange =
  | { kind: 'selection'; rows: TranscriptRowChange[] }
  | { kind: 'wording'; id: number; expected: string; text: string }
  | { kind: 'original'; id: number; expected: string }
  | { kind: 'remove'; ids: number[] }
  | { kind: 'restore'; batch: string | null }
  | { kind: 'undo' | 'redo' }
  | { kind:'restoreLine'; id:number }
  | { kind:'revert'; id:number | null }

export type EditResult =
  | { status: 'saved'; revision: number; count: number }
  | { status: 'conflict'; text: string; revision: number }
  | { status: 'stale' | 'unchanged' | 'unavailable' }

export type RemovedSpan = { id: number; track: 'me' | 'them'; startMs: number; endMs: number }
export function validChange(x: unknown): x is TranscriptChange {
  if (!x || typeof x !== 'object' || !('kind' in x)) return false
  const row = (id: unknown) => typeof id === 'number' && Number.isSafeInteger(id) && id > 0
  switch (x.kind) {
    case 'selection': return 'rows' in x && Array.isArray(x.rows) && x.rows.length > 0 &&
      x.rows.every(r => r && row(r.id) && typeof r.expected === 'string' && (r.text === null ||
        (typeof r.text === 'string' && !!r.text.trim() && r.text.length <= 2_000_000 && !/[\r\n]/.test(r.text)))) &&
      new Set(x.rows.map(r => r.id)).size === x.rows.length
    case 'restoreLine': return 'id' in x && row(x.id)
    case 'revert': return 'id' in x && (x.id===null || row(x.id))
    case 'redo':
    case 'undo': return true
    case 'restore': return 'batch' in x && (x.batch === null || (typeof x.batch === 'string' && x.batch.length === 36))
    case 'remove': return 'ids' in x && Array.isArray(x.ids) && x.ids.length > 0 && x.ids.every(row)
    case 'original':
    case 'wording': return 'id' in x && row(x.id) && 'expected' in x && typeof x.expected === 'string' &&
      (x.kind === 'original' || ('text' in x && typeof x.text === 'string' && !!x.text.trim() && x.text.length <= 2_000_000 && !/[\r\n]/.test(x.text)))
    default: return false
  }
}
