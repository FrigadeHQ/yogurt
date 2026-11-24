/** m:ss, or h:mm:ss past an hour */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const sec = String(s % 60).padStart(2, '0')
  const m = Math.floor(s / 60)
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}
