import { describe, expect, it } from 'vitest'
import { icsEvents, icsName } from '../src/main/calendarLink/ics'

// A made-up feed in the shape Google's "Secret address in iCal format" gives: its own time zone, attendees, a Meet link
const feed = (events: string) => `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Google Inc//Google Calendar 70.9054//EN
X-WR-CALNAME:alex@example.com
BEGIN:VTIMEZONE
TZID:America/Los_Angeles
BEGIN:STANDARD
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
TZOFFSETFROM:-0700
TZOFFSETTO:-0800
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
TZOFFSETFROM:-0800
TZOFFSETTO:-0700
END:DAYLIGHT
END:VTIMEZONE
${events}
END:VCALENDAR
`
const sync = `BEGIN:VEVENT
UID:sync-1@example.com
SUMMARY:Weekly sync
DTSTART;TZID=America/Los_Angeles:20261102T100000
DTEND;TZID=America/Los_Angeles:20261102T103000
RRULE:FREQ=WEEKLY;BYDAY=MO
EXDATE;TZID=America/Los_Angeles:20261109T100000
ORGANIZER;CN=Dana Smith:mailto:dana@example.com
ATTENDEE;CN=Dana Smith;PARTSTAT=ACCEPTED:mailto:dana@example.com
ATTENDEE;CN=Alex Morgan;PARTSTAT=ACCEPTED:mailto:alex@example.com
ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:bo@example.com
DESCRIPTION:Join: https://meet.google.com/abc-defg-hij
END:VEVENT
BEGIN:VEVENT
UID:sync-1@example.com
RECURRENCE-ID;TZID=America/Los_Angeles:20261116T100000
SUMMARY:Weekly sync (moved)
DTSTART;TZID=America/Los_Angeles:20261116T140000
DTEND;TZID=America/Los_Angeles:20261116T143000
ATTENDEE;CN=Dana Smith:mailto:dana@example.com
END:VEVENT
BEGIN:VEVENT
UID:lunch@example.com
SUMMARY:Lunch
DTSTART:20261117T200000Z
DTEND:20261117T210000Z
LOCATION:Cafe
END:VEVENT
BEGIN:VEVENT
UID:off@example.com
SUMMARY:Day off
DTSTART;VALUE=DATE:20261118
DTEND;VALUE=DATE:20261119
END:VEVENT
BEGIN:VEVENT
UID:gone@example.com
SUMMARY:Cancelled review
STATUS:CANCELLED
DTSTART:20261117T180000Z
DTEND:20261117T183000Z
END:VEVENT`

const at = (iso: string) => Date.parse(iso)
const link = { id: 'link-1', name: 'Work' }

describe('a calendar link: events from an iCal feed, in the shape the Mac helper gives', () => {
  it('names the calendar after the feed, and knows the address it belongs to', () => {
    expect(icsName(feed(sync))).toEqual({ name: 'alex@example.com', me: 'alex@example.com' })
  })

  it('expands a weekly meeting in its own time zone, skips an excluded week, and uses a moved one', () => {
    const got = icsEvents(feed(sync), at('2026-11-02T00:00:00Z'), at('2026-11-24T00:00:00Z'), link)
    const syncs = got.filter((e) => e.externalId === 'sync-1@example.com')
    // Nov 2 and 23 at 10:00 PST (18:00Z); Nov 9 excluded; Nov 16 moved to 14:00 PST (22:00Z) with its own title
    expect(syncs.map((e) => [e.title, e.start])).toEqual([
      ['Weekly sync', '2026-11-02T18:00:00.000Z'],
      ['Weekly sync (moved)', '2026-11-16T22:00:00.000Z'],
      ['Weekly sync', '2026-11-23T18:00:00.000Z'],
    ])
    // every occurrence has its own id, so the agenda and meeting links can tell them apart
    expect(new Set(syncs.map((e) => e.id)).size).toBe(3)
  })

  it('gives attendees by name and email (an address alone stands for the name), the call link, and the calendar', () => {
    const [first] = icsEvents(feed(sync), at('2026-11-02T00:00:00Z'), at('2026-11-03T00:00:00Z'), link)
    expect(first).toMatchObject({
      title: 'Weekly sync', end: '2026-11-02T18:30:00.000Z', calendarId: 'link-1', calendar: 'Work', calendarSource: 'Calendar link',
      notes: 'Join: https://meet.google.com/abc-defg-hij', me: 'alex@example.com',
    })
    // the person the feed belongs to is left out, as the Mac helper does
    expect(first.attendees).toEqual([{ name: 'Dana Smith', email: 'dana@example.com' }, { name: 'bo@example.com', email: 'bo@example.com' }])
  })

  it('leaves out all-day events and cancelled ones, and keeps one-off events in range', () => {
    const got = icsEvents(feed(sync), at('2026-11-17T00:00:00Z'), at('2026-11-19T00:00:00Z'), link)
    expect(got.map((e) => e.title)).toEqual(['Lunch'])
    expect(got[0]).toMatchObject({ start: '2026-11-17T20:00:00.000Z', location: 'Cafe' })
  })

  it('a feed that is not a calendar is an error, not an empty week', () => {
    expect(() => icsEvents('<html>Sign in</html>', 0, 1, link)).toThrow()
  })
})
