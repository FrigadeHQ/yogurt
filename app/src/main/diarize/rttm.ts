/**
 * One voice's turn in the recording, on meeting time. `key` is the diarizer's own label for the voice
 * (remapped to this meeting's stable keys later).
 */
export type Turn = { key: string; startMs: number; endMs: number }
export const MIN_TURN_MS = 200
export const MERGE_GAP_MS = 300

/**
 * RTTM (`SPEAKER <file> 1 <start>s <dur>s <NA> <NA> <speaker> <NA> <NA>`, seconds), one voice per line.
 * Malformed lines are skipped; zero valid turns means the meeting is left as it is.
 */
export function parseRttm(text: string): Turn[] {
  const turns: Turn[] = []
  for (const line of text.split('\n')) {
    const p = line.trim().split(/\s+/)
    if (p[0] !== 'SPEAKER' || p.length < 8) continue
    const start = Number(p[3]), dur = Number(p[4]), key = p[7]
    if (!Number.isFinite(start) || !Number.isFinite(dur) || dur <= 0 || !key) continue
    turns.push({ key, startMs: Math.round(start * 1000), endMs: Math.round((start + dur) * 1000) })
  }
  return turns.sort((a, b) => a.startMs - b.startMs)
}

/** drop sub-200 ms turns, close same-voice gaps under 300 ms; overlaps stay (alignment picks the dominant turn per word) */
export function cleanTurns(turns: Turn[]): Turn[] {
  const out: Turn[] = []
  for (const t of turns.filter(t => t.endMs - t.startMs >= MIN_TURN_MS)) {
    const last = out[out.length - 1]
    if (last && last.key === t.key && t.startMs - last.endMs < MERGE_GAP_MS) last.endMs = Math.max(last.endMs, t.endMs)
    else out.push({ ...t })
  }
  return out.sort((a, b) => a.startMs - b.startMs)
}
