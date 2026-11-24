/**
 * The one request a calendar link makes: the person's own calendar address, straight from this computer to their
 * calendar provider (Google, Outlook, …). No Yogurt server sits in between. A work calendar with years of history is
 * tens of megabytes (#146), so there's room for that, but not for a download that never ends: 64 MB, one minute.
 */
export const MAX_BYTES = 64 * 2 ** 20
export const TIMEOUT_MS = 60_000

/** the feed is over the limit, or took too long to arrive: it was reached, so this isn't a connection problem */
export class CalendarTooBig extends Error {
  constructor() { super('calendar too big') }
}

export async function getCalendar(url: string, { maxBytes = MAX_BYTES, timeoutMs = TIMEOUT_MS } = {}): Promise<string> {
  const signal = AbortSignal.timeout(timeoutMs)
  let res: Response
  // a server that never answers in time is as likely a bad connection as a big calendar
  try { res = await fetch(url, { signal, redirect: 'follow', headers: { accept: 'text/calendar, */*' } }) } catch (e) {
    if (signal.aborted) throw new Error('calendar address did not answer', { cause: e })
    throw e
  }
  if (!res.ok) throw new Error(`calendar address answered ${res.status}`)
  if (Number(res.headers.get('content-length') ?? 0) > maxBytes) { void res.body?.cancel().catch(() => {}); throw new CalendarTooBig() }
  if (!res.body) return ''
  // counted as it arrives, so a huge feed stops downloading at the limit instead of filling memory first
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) { void reader.cancel().catch(() => {}); throw new CalendarTooBig() }
      chunks.push(value)
    }
  } catch (e) {
    if (e instanceof CalendarTooBig || signal.aborted) throw new CalendarTooBig()
    throw e
  }
  return Buffer.concat(chunks, size).toString('utf8')
}
