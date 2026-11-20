import ICAL from 'ical.js'

/**
 * A calendar link's iCal feed read as the Mac helper's `events` answer (calendar.ts parseEvents reads either), so
 * Windows and Linux get the agenda, call detection and attendees from a private calendar address. Pure: the feed's
 * text in, events between two times out. Recurring events are expanded in the feed's own time zones.
 */

export type LinkRef = { id: string; name: string }
export type RawEvent = {
  id: string; externalId: string; title: string; start: string; end: string
  attendees: Array<{ name: string | null; email: string | null }>
  url: string | null; location: string | null; notes: string | null
  calendarId: string; calendar: string; calendarSource: string; me: string | null; declined?: boolean
}

/** at most this many occurrences of one event are walked, so a feed with a years-long daily event stays quick */
const MAX_STEPS = 5000

const parse = (text: string): ICAL.Component => {
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('Not a calendar')
  const root = new ICAL.Component(ICAL.parse(text))
  for (const tz of root.getAllSubcomponents('vtimezone')) ICAL.TimezoneService.register(tz)
  return root
}

const prop = (c: ICAL.Component, name: string): string | null => {
  const v = c.getFirstPropertyValue(name)
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** the feed's name, and the address it belongs to when its name is one (Google names a person's calendar after them) */
export function icsName(text: string): { name: string | null; me: string | null } {
  const root = parse(text)
  const name = prop(root, 'x-wr-calname')
  return { name, me: name && /^[^\s@]+@[^\s@]+$/.test(name) ? name.toLowerCase() : null }
}

const email = (v: unknown) => (typeof v === 'string' ? v.replace(/^mailto:/i, '').trim().toLowerCase() || null : null)

function people(c: ICAL.Component, me: string | null): RawEvent['attendees'] {
  const seen = new Set<string>()
  const out: RawEvent['attendees'] = []
  for (const p of [...c.getAllProperties('organizer'), ...c.getAllProperties('attendee')]) {
    const address = email(p.getFirstValue())
    const cn = p.getParameter('cn')
    const name = typeof cn === 'string' && cn.trim() ? cn.trim() : null
    const key = address ?? name
    if (!key || seen.has(key) || (me && address === me)) continue
    seen.add(key)
    out.push({ name: name ?? address, email: address })
  }
  return out
}

/** how far either side of a read the occurrences are worked out at once, so the next reads (each minute) reuse them */
const SPAN_MS = 7 * 86_400_000

/**
 * A feed parsed once (#79: parsing it on every read froze the app with a years-long work calendar). Its events between
 * two times; occurrences are worked out for a week either side and kept, so call detection and the agenda read from
 * memory. Throws when the text isn't iCal.
 */
export function icsFeed(text: string, link: LinkRef) {
  const root = parse(text)
  const name = prop(root, 'x-wr-calname')
  const me = name && /^[^\s@]+@[^\s@]+$/.test(name) ? name.toLowerCase() : null
  const masters = new Map<string, ICAL.Event>()
  const exceptions: ICAL.Component[] = []
  for (const v of root.getAllSubcomponents('vevent')) {
    const uid = prop(v, 'uid')
    if (!uid) continue
    // exceptions: [] stops ical.js looking through the whole feed for each event's moved copies (quadratic: thousands of
    // events took seconds); they're tied to their event just below
    if (v.hasProperty('recurrence-id')) exceptions.push(v)
    else masters.set(uid, new ICAL.Event(v, { exceptions: [] }))
  }
  // a moved or changed occurrence belongs to its recurring event; one whose event isn't in the feed stands alone
  const lone: ICAL.Event[] = []
  for (const x of exceptions) {
    const master = masters.get(prop(x, 'uid')!)
    if (master) master.relateException(x)
    else lone.push(new ICAL.Event(x, { exceptions: [] }))
  }
  const items = [...masters.values(), ...lone]

  function expand(fromMs: number, toMs: number): RawEvent[] {
    const out: RawEvent[] = []
    const add = (item: ICAL.Event, start: ICAL.Time, end: ICAL.Time) => {
      if (start.isDate) return
      if ((prop(item.component, 'status') ?? '').toUpperCase() === 'CANCELLED') return
      const s = start.toJSDate().getTime(), e = end.toJSDate().getTime()
      if (!(s < toMs && e > fromMs)) return
      const uid = item.uid
      const declined = me && item.component.getAllProperties('attendee').some(p =>
        email(p.getFirstValue()) === me && String(p.getParameter('partstat')).toUpperCase() === 'DECLINED')
      out.push({
        id: `${uid}|${new Date(s).toISOString()}`, externalId: uid, title: item.summary ?? '',
        start: new Date(s).toISOString(), end: new Date(e).toISOString(), attendees: people(item.component, me),
        url: prop(item.component, 'url') ?? prop(item.component, 'x-google-conference'), location: item.location || null, notes: item.description || null,
        calendarId: link.id, calendar: link.name, calendarSource: 'Calendar link', me, ...(declined ? { declined: true } : {}),
      })
    }
    for (const ev of items) {
      if (!ev.isRecurring()) { add(ev, ev.startDate, ev.endDate); continue }
      // working out an occurrence (its moved copy, its end) is the slow part: only for ones that can reach the window
      const lasts = ev.duration.toSeconds() * 1000
      const moved = new Set(Object.keys(ev.exceptions))
      const it = ev.iterator()
      for (let i = 0, next = it.next(); next && i < MAX_STEPS; i++, next = it.next()) {
        const at = next.toJSDate().getTime()
        if (at >= toMs && !moved.has(next.toString())) break
        if (at + lasts <= fromMs && !moved.has(next.toString())) continue
        const d = ev.getOccurrenceDetails(next)
        add(d.item, d.startDate, d.endDate)
      }
    }
    return out
  }

  let kept: { fromMs: number; toMs: number; events: RawEvent[] } | null = null
  return {
    /** Events that overlap [fromMs, toMs), all-day and cancelled ones left out */
    events(fromMs: number, toMs: number): RawEvent[] {
      if (!kept || fromMs < kept.fromMs || toMs > kept.toMs) {
        const from = fromMs - SPAN_MS, to = toMs + SPAN_MS
        kept = { fromMs: from, toMs: to, events: expand(from, to) }
      }
      return kept.events.filter((e) => Date.parse(e.start) < toMs && Date.parse(e.end) > fromMs).sort((a, b) => a.start.localeCompare(b.start))
    },
  }
}
export type IcsFeed = ReturnType<typeof icsFeed>

/** Events that overlap [fromMs, toMs), all-day and cancelled ones left out. A feed that isn't iCal throws. */
export function icsEvents(text: string, fromMs: number, toMs: number, link: LinkRef): RawEvent[] {
  return icsFeed(text, link).events(fromMs, toMs)
}
