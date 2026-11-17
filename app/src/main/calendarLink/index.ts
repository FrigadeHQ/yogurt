import { randomUUID } from 'node:crypto'
import { loadSettings, updateSettings } from '../settings'
import { icsEvents, icsName, type RawEvent } from './ics'

/**
 * Calendar links: Windows and Linux have no system calendar Yogurt can read, so the person pastes their calendar's
 * private iCal address (Google's "Secret address in iCal format", Outlook's published calendar). It is kept only on
 * this computer, sealed with the system keychain where there is one, and read from here every few minutes. The events
 * come out in the Mac helper's shape, so the agenda, call detection and attendees work as on a Mac (calendar.ts).
 */

export type LinkError = 'bad-url' | 'unreachable' | 'not-calendar'
export type AddResult = { ok: true; id: string; name: string } | { ok: false; error: LinkError }
type Stored = { id: string; name: string; host: string; url: string }

/** how long a fetched feed is used before asking for it again */
export const REFRESH_MS = 5 * 60_000

/** https (webcal is the same address), or plain http only on this computer (tests) */
export function normalize(raw: string): URL | null {
  let url: URL
  try { url = new URL(raw.trim().replace(/^webcals?:\/\//i, 'https://')) } catch { return null }
  if (url.protocol === 'https:') return url
  if (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return url
  return null
}

export function createCalendarLinks(d: {
  file: string
  get: (url: string) => Promise<string>
  /** keep the address from being readable in settings.json: the system keychain (safeStorage), or as it is without one */
  seal: (plain: string) => string
  open: (sealed: string) => string
  now?: () => number
}) {
  const now = d.now ?? Date.now
  const cache = new Map<string, { text: string; at: number }>()
  const stored = (): Stored[] => loadSettings(d.file).calendarLinks ?? []
  const urlOf = (l: Stored) => { try { return d.open(l.url) } catch { return null } }

  /** the feed's text: the cached copy for five minutes, a fresh one after, the last good copy when that fails */
  async function text(l: Stored): Promise<string | null> {
    const hit = cache.get(l.id)
    if (hit && now() - hit.at < REFRESH_MS) return hit.text
    const url = urlOf(l)
    if (!url) return hit?.text ?? null
    try {
      const t = await d.get(url)
      icsName(t)
      cache.set(l.id, { text: t, at: now() })
      return t
    } catch (e) {
      console.warn('calendar link: could not read', l.host, e instanceof Error ? e.message : e)
      return hit?.text ?? null
    }
  }

  return {
    /** the connected calendars, never their addresses */
    list: () => stored().map(({ id, name, host }) => ({ id, name, host })),
    status: (): 'granted' | 'notDetermined' => (stored().length ? 'granted' : 'notDetermined'),
    async add(raw: string): Promise<AddResult> {
      const url = normalize(raw)
      if (!url) return { ok: false, error: 'bad-url' }
      let t: string
      try { t = await d.get(url.toString()) } catch { return { ok: false, error: 'unreachable' } }
      let name: string | null
      try { name = icsName(t).name } catch { return { ok: false, error: 'not-calendar' } }
      const id = randomUUID()
      const host = url.hostname
      const label = name ?? host
      updateSettings(d.file, { calendarLinks: [...stored(), { id, name: label, host, url: d.seal(url.toString()) }] })
      cache.set(id, { text: t, at: now() })
      return { ok: true, id, name: label }
    },
    remove(id: string) {
      cache.delete(id)
      updateSettings(d.file, { calendarLinks: stored().filter((l) => l.id !== id) })
    },
    /** one per link, as calendar.ts's calendars() gives the Mac's */
    async calendars() { return stored().map((l) => ({ id: l.id, name: l.name, source: l.host })) },
    /** every link's events between two times; a link that can't be read gives none, never an error */
    async events(fromMs: number, toMs: number): Promise<RawEvent[]> {
      const all = await Promise.all(stored().map(async (l) => {
        const t = await text(l)
        if (!t) return []
        try { return icsEvents(t, fromMs, toMs, { id: l.id, name: l.name }) } catch { return [] }
      }))
      return all.flat()
    },
  }
}
export type CalendarLinks = ReturnType<typeof createCalendarLinks>
