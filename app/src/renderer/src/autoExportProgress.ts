/** "Also save your earlier meetings?": how far along, or 'done' (null: nothing to show) */
export type Earlier = { done: number; total: number } | 'done' | null

/**
 * Main's progress events and the save's reply come on different channels, which Electron doesn't keep in order:
 * a last "2 of 2" can land after the reply. Progress only moves a save that is still going, so it never undoes the end.
 */
export function earlierStep(s: Earlier, e: { start: true } | { progress: { done: number; total: number } } | { finished: boolean }): Earlier {
  if ('start' in e) return { done: 0, total: 0 }
  if ('progress' in e) return s && s !== 'done' ? e.progress : s
  return e.finished ? 'done' : null
}
