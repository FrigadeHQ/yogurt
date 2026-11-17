/**
 * The one request a calendar link makes: the person's own calendar address, straight from this computer to their
 * calendar provider (Google, Outlook, …). No Yogurt server sits in between. Small and slow-proof: at most 10 MB, 20 s.
 */
const MAX_BYTES = 10 * 2 ** 20
const TIMEOUT_MS = 20_000

export async function getCalendar(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow', headers: { accept: 'text/calendar, */*' } })
  if (!res.ok) throw new Error(`calendar address answered ${res.status}`)
  const size = Number(res.headers.get('content-length') ?? 0)
  if (size > MAX_BYTES) throw new Error('calendar too big')
  const text = await res.text()
  if (text.length > MAX_BYTES) throw new Error('calendar too big')
  return text
}
