import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ICAL from 'ical.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCalendarLinks } from '../src/main/calendarLink'

const ics = (name: string) => `BEGIN:VCALENDAR\nVERSION:2.0\nX-WR-CALNAME:${name}\nBEGIN:VEVENT\nUID:a@example.com\nSUMMARY:Standup\nDTSTART:20261117T170000Z\nDTEND:20261117T171500Z\nEND:VEVENT\nEND:VCALENDAR\n`
const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

function rig(answer: (url: string) => Promise<string> | string) {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-callinks-')); dirs.push(dir)
  const file = join(dir, 'settings.json')
  const fetched: string[] = []
  let clock = 1_000_000
  const links = createCalendarLinks({
    file, now: () => clock,
    get: async (url) => { fetched.push(url); return answer(url) },
    // a stand-in for the keychain: Yogurt never writes the address as it is
    seal: (s) => `sealed:${Buffer.from(s).toString('base64')}`, open: (s) => Buffer.from(s.slice(7), 'base64').toString(),
  })
  return { links, file, fetched, tick: (ms: number) => { clock += ms } }
}
const day = [Date.parse('2026-11-17T00:00:00Z'), Date.parse('2026-11-18T00:00:00Z')] as const

describe('calendar links (Windows and Linux): a private calendar address, kept on this computer', () => {
  it('connects a Google address: checks it is a calendar, names it, and stores the address sealed', async () => {
    const r = rig(() => ics('alex@example.com'))
    const got = await r.links.add('  https://calendar.google.com/calendar/ical/alex%40example.com/private-abc123/basic.ics ')
    expect(got).toMatchObject({ name: 'alex@example.com' })
    expect(r.links.list()).toEqual([{ id: expect.any(String), name: 'alex@example.com', host: 'calendar.google.com' }])
    expect(readFileSync(r.file, 'utf8')).not.toContain('private-abc123')
    expect(r.links.status()).toBe('granted')
    expect(await r.links.calendars()).toEqual([{ id: got.ok ? got.id : '', name: 'alex@example.com', source: 'calendar.google.com' }])
  })
  it('a webcal:// address is the same as https://', async () => {
    const r = rig(() => ics('Team'))
    await r.links.add('webcal://outlook.office365.com/owa/calendar/abc/reachcalendar.ics')
    expect(r.fetched[0]).toBe('https://outlook.office365.com/owa/calendar/abc/reachcalendar.ics')
  })
  it('says why an address does not work: not a web address, cannot be reached, or not a calendar', async () => {
    expect(await rig(() => '').links.add('not a link')).toEqual({ ok: false, error: 'bad-url' })
    expect(await rig(() => '').links.add('ftp://example.com/cal.ics')).toEqual({ ok: false, error: 'bad-url' })
    expect(await rig(() => { throw new Error('offline') }).links.add('https://example.com/cal.ics')).toEqual({ ok: false, error: 'unreachable' })
    expect(await rig(() => '<html>Sign in</html>').links.add('https://example.com/cal.ics')).toEqual({ ok: false, error: 'not-calendar' })
  })
  it("Google's public address says so when it fails (it works only for a public calendar), and works when the calendar is public", async () => {
    const pub = 'https://calendar.google.com/calendar/ical/alex%40example.com/public/basic.ics'
    expect(await rig(() => { throw new Error('404') }).links.add(pub)).toEqual({ ok: false, error: 'public-address' })
    expect(await rig(() => '<html>Not found</html>').links.add(pub)).toEqual({ ok: false, error: 'public-address' })
    expect(await rig(() => ics('Team')).links.add(pub)).toMatchObject({ ok: true, name: 'Team' })
  })
  it('reads events, fetching again only after five minutes, and keeps the last good copy when the network fails', async () => {
    let fail = false
    const r = rig(() => { if (fail) throw new Error('offline'); return ics('Work') })
    await r.links.add('https://example.com/cal.ics')
    expect((await r.links.events(...day)).map((e) => e.title)).toEqual(['Standup'])
    await r.links.events(...day)
    expect(r.fetched).toHaveLength(1)
    r.tick(5 * 60_000 + 1); fail = true
    expect((await r.links.events(...day)).map((e) => e.title)).toEqual(['Standup'])
    expect(r.fetched).toHaveLength(2)
  })
  it('distinguishes an unavailable cold feed from a successfully read empty day', async () => {
    const r = rig(() => ics('Work'))
    const added = await r.links.add('https://example.com/work.ics')
    if (!added.ok) throw new Error('fixture did not connect')
    const cold = createCalendarLinks({ file: r.file, get: async () => { throw new Error('offline') }, open: () => 'https://example.com/work.ics', seal: s => s })
    const unavailable: string[] = []
    const events = await cold.events(...day, unavailable)
    expect(events).toEqual([])
    expect(unavailable).toEqual(['Work'])
  })
  it('keeps cached and healthy meetings, skips hidden feeds, and clears the warning on recovery', async () => {
    let offline = false
    const r = rig(url => {
      const name = url.endsWith('work.ics') ? 'Work' : 'Team'
      if (offline && name === 'Work') throw new Error('offline')
      return ics(name).replace('SUMMARY:Standup', 'SUMMARY:' + name)
    })
    const work = await r.links.add('https://example.com/work.ics')
    await r.links.add('https://example.com/team.ics')
    if (!work.ok) throw new Error('fixture did not connect')
    r.tick(5 * 60_000 + 1)
    offline = true
    const unavailable: string[] = []
    expect((await r.links.events(...day, unavailable)).map(e => e.title).sort()).toEqual(['Team', 'Work'])
    expect(unavailable).toEqual(['Work'])
    const hidden: string[] = []
    expect((await r.links.events(...day, hidden, [work.id])).map(e => e.title)).toEqual(['Team'])
    expect(hidden).toEqual([])
    offline = false
    const recovered: string[] = []
    expect(await r.links.events(...day, recovered)).toHaveLength(2)
    expect(recovered).toEqual([])
  })
  it('reading the calendar again and again (call detection, the agenda) reuses the parsed feed until it is fetched again', async () => {
    const r = rig(() => ics('Team'))
    await r.links.add('https://calendar.google.com/calendar/ical/team/private-x/basic.ics')
    const parse = vi.spyOn(ICAL, 'parse')
    for (let i = 0; i < 5; i++) await r.links.events(...day)
    expect(parse.mock.calls.length).toBeLessThanOrEqual(1)
    parse.mockRestore()
  })
  it('removing the last address leaves no calendar', async () => {
    const r = rig(() => ics('Work'))
    const got = await r.links.add('https://example.com/cal.ics')
    r.links.remove(got.ok ? got.id : '')
    expect(r.links.list()).toEqual([])
    expect(r.links.status()).toBe('notDetermined')
    expect(await r.links.events(...day)).toEqual([])
  })
})
