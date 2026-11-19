import { calendarAddress as normalize } from '../../shared/calendarLink'
export { normalize }
import { randomUUID } from 'node:crypto'
import { loadSettings, updateSettings } from '../settings'
import { icsFeed, icsName, type IcsFeed, type RawEvent } from './ics'

/**
 * Calendar links: Windows and Linux have no system calendar Yogurt can read, so the person pastes their calendar's
 * private iCal address (Google's "Secret address in iCal format", Outlook's published calendar). It is kept only on
 * this computer, sealed with the system keychain where there is one, and read from here every few minutes. The events
 * come out in the Mac helper's shape, so the agenda, call detection and attendees work as on a Mac (calendar.ts).
 */

export type LinkError = 'bad-url' | 'unreachable' | 'not-calendar' | 'public-address'
export type AddResult = { ok: true; id: string; name: string } | { ok: false; error: LinkError }
type Stored = { id: string; name: string; host: string; url: string }

/** how long a fetched feed is used before asking for it again */
export const REFRESH_MS = 5 * 60_000


export function createCalendarLinks(d: {
  file: string
  get: (url: string) => Promise<string>
  /** keep the address from being readable in settings.json: the system keychain (safeStorage), or as it is without one */
  seal: (plain: string) => string
  open: (sealed: string) => string
  now?: () => number
}) {
  const now = d.now ?? Date.now
  // the feed is kept parsed with its text (#79: parsing it on every read, each minute, froze the app)
  const cache = new Map<string, { text: string; at: number; feed?: IcsFeed }>()
  const stored = (): Stored[] => loadSettings(d.file).calendarLinks ?? []
  const urlOf = (l: Stored) => { try { return d.open(l.url) } catch { return null } }

  /** the feed's text: the cached copy for five minutes, a fresh one after, the last good copy when that fails */
  async function feed(l: Stored): Promise<IcsFeed | null> {
    const hit = cache.get(l.id)
    const parsed = (c: { text: string; feed?: IcsFeed }) => (c.feed ??= icsFeed(c.text, { id: l.id, name: l.name }))
    if (hit && now() - hit.at < REFRESH_MS) return parsed(hit)
    const url = urlOf(l)
    const last = () => (hit ? parsed(hit) : null)
    if (!url) return last()
    try {
      const t = await d.get(url)
      const entry = { text: t, at: now(), feed: icsFeed(t, { id: l.id, name: l.name }) }
      cache.set(l.id, entry)
      return entry.feed
    } catch (e) {
      console.warn('calendar link: could not read', l.host, e instanceof Error ? e.message : e)
      return last()
    }
  }

  return {
    /** the connected calendars, never their addresses */
    list: () => stored().map(({ id, name, host }) => ({ id, name, host })),
    status: (): 'granted' | 'notDetermined' => (stored().length ? 'granted' : 'notDetermined'),
    async add(raw: string): Promise<AddResult> {
      const url = normalize(raw)
      if (!url) return { ok: false, error: 'bad-url' }
      // Google's public address only answers for a public calendar; work accounts often have no secret one to use instead
      const publicGoogle = url.hostname === 'calendar.google.com' && /\/public\/[^/]*\.ics$/i.test(url.pathname)
      let t: string
      try { t = await d.get(url.toString()) } catch { return { ok: false, error: publicGoogle ? 'public-address' : 'unreachable' } }
      let name: string | null
      try { name = icsName(t).name } catch { return { ok: false, error: publicGoogle ? 'public-address' : 'not-calendar' } }
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
        try {
          const f = await feed(l)
          return f ? f.events(fromMs, toMs) : []
        } catch { return [] }
      }))
      return all.flat()
    },
  }
}
export type CalendarLinks = ReturnType<typeof createCalendarLinks>
