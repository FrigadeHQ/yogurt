import type { NoteView } from '../../shared/types'
import { FROM_IPHONE } from '../../shared/companion'

/**
 * A new view of a note that is open. What the person typed here is newer than any copy from the app, and so are
 * their edits to finished notes. Notes written again for new people (rewrittenFrom) replace what is on screen, all at
 * once, unless they edited it since: their autosave then keeps their version, and the app hears so (keptEdits) to keep
 * the people-changed hint.
 */
export function mergeNoteView(cur: NoteView | undefined, v: NoteView): { view: NoteView; /** a rewrite was turned down for edits on screen */ keptEdits?: true; /** My notes on screen took the phone's text under theirs: save them */ resaveMine?: true } {
  if (!cur) return { view: v }
  // My notes from the iPhone: shown if nothing was typed here since; otherwise what was typed stays and the phone's
  // text goes under it (the same rule as edits made while apart), saved again so neither is lost
  if (v.mineFrom !== undefined) {
    const { view } = mergeNoteView(cur, { ...v, mineFrom: undefined })
    if (cur.mine === v.mineFrom || cur.mine === v.mine) return { view: { ...view, mine: v.mine } }
    return { view: { ...view, mine: cur.mine.trimEnd() + FROM_IPHONE + v.mine }, resaveMine: true }
  }
  // A failed or stopped rewrite's previous result is still editable, including when the person clears its text.
  const finished = cur.status === v.status && (cur.status === 'done' || ((cur.status === 'failed' || cur.status === 'stopped') && cur.enhanced != null))
  if (!finished) return { view: { ...v, mine: cur.mine } }
  if (v.rewrittenFrom !== undefined && (cur.enhanced ?? '') === v.rewrittenFrom) return { view: { ...v, mine: cur.mine } }
  return { view: { ...v, mine: cur.mine, enhanced: cur.enhanced }, ...(v.rewrittenFrom !== undefined ? { keptEdits: true as const } : {}) }
}
