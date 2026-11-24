/**
 * A made-up work calendar feed with years of history, in the shape Google's secret iCal address gives (#146): one-off
 * meetings, recurring ones (many long ended, some still on, a few daily since the start) with skipped weeks and moved
 * copies, and long invite text. Nothing in it is real; the same seed always gives the same feed.
 */
export function bigCalendar({ years = 7, oneOffs = 5400, series = 600, until = Date.parse('2026-12-31T00:00:00Z') } = {}): string {
  let seed = 146
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
  const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)]
  const from = until - years * 365 * 86_400_000
  const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')
  const local = (ms: number) => stamp(ms).replace('Z', '')
  const hour = (ms: number) => Math.floor(ms / 3_600_000) * 3_600_000
  const people = Array.from({ length: 80 }, (_, i) => `ATTENDEE;CN=Person ${i};PARTSTAT=${pick(['ACCEPTED', 'TENTATIVE', 'NEEDS-ACTION'])}:mailto:person${i}@example.com`)
  const words = 'plan review budget launch roadmap sync design hiring notes metrics customer draft agenda update retro'.split(' ')
  const invite = () => {
    const lines = ['DESCRIPTION:' + Array.from({ length: 30 + Math.floor(rand() * 60) }, () => pick(words)).join(' ') +
      '\\n\\nJoin with Google Meet: https://meet.google.com/abc-defg-hij\\nOr dial: +1 555-0100 PIN: 123456#\\n\\n' +
      'Learn more about Meet at: https://support.google.com/a/users/answer/9282720\\n\\nPlease do not edit this section.']
    // invites run long: agendas pasted in, the call's boilerplate in several languages
    for (let i = Math.floor(rand() * 25); i > 0; i--) lines[0] += '\\n' + Array.from({ length: 20 }, () => pick(words)).join(' ')
    // iCal folds lines at 75 characters
    return lines[0].match(/.{1,74}/g)!.join('\r\n ')
  }
  const event = (props: string[]) => ['BEGIN:VEVENT', ...props,
    ...Array.from({ length: 3 + Math.floor(rand() * 12) }, () => pick(people)),
    'ORGANIZER;CN=Person 1:mailto:person1@example.com', invite(), 'LOCATION:Room ' + Math.floor(rand() * 40),
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-P0DT0H10M0S', 'DESCRIPTION:This is an event reminder', 'END:VALARM', 'END:VEVENT']
  const out: string[] = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Google Inc//Google Calendar 70.9054//EN', 'X-WR-CALNAME:alex@example.com',
    'BEGIN:VTIMEZONE', 'TZID:Europe/Amsterdam',
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
    'END:VTIMEZONE']
  for (let i = 0; i < oneOffs; i++) {
    const s = hour(from + rand() * (until - from))
    out.push(...event([`UID:one-${i}@example.com`, `SUMMARY:${pick(words)} ${i}`, `DTSTART:${stamp(s)}`, `DTEND:${stamp(s + 3_600_000)}`]))
  }
  for (let i = 0; i < series; i++) {
    const s = hour(from + rand() * (until - from) * 0.9)
    const tz = 'TZID=Europe/Amsterdam'
    const daily = i % 20 === 0
    const ended = !daily && rand() < 0.7
    const rule = daily ? 'FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR' : pick(['FREQ=WEEKLY', 'FREQ=WEEKLY;INTERVAL=2', 'FREQ=MONTHLY', 'FREQ=WEEKLY;BYDAY=TU,TH'])
    const end = ended ? s + (30 + rand() * 600) * 86_400_000 : 0
    const props = [`UID:series-${i}@example.com`, `SUMMARY:${pick(words)} series ${i}`, `DTSTART;${tz}:${local(s)}`, `DTEND;${tz}:${local(s + 1_800_000)}`,
      `RRULE:${rule}${ended ? `;UNTIL=${stamp(end)}` : ''}`]
    // a skipped week or two
    if (rand() < 0.4 && !rule.includes('BYDAY')) props.push(`EXDATE;${tz}:${local(s + 7 * 86_400_000 * (rule === 'FREQ=WEEKLY' ? 2 : 4))}`)
    out.push(...event(props))
    // moved copies: an hour later, Google keeps one for every occurrence anyone ever changed
    if (rule === 'FREQ=WEEKLY') for (let k = 1; k <= 3; k++) {
      const was = s + k * 3 * 7 * 86_400_000
      out.push(...event([`UID:series-${i}@example.com`, `RECURRENCE-ID;${tz}:${local(was)}`, `SUMMARY:${pick(words)} series ${i} (moved)`,
        `DTSTART;${tz}:${local(was + 3_600_000)}`, `DTEND;${tz}:${local(was + 5_400_000)}`]))
    }
  }
  out.push('END:VCALENDAR', '')
  return out.join('\r\n')
}
