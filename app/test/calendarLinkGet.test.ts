import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { CalendarTooBig, getCalendar, MAX_BYTES, TIMEOUT_MS } from '../src/main/calendarLink/get'

// #146: a work calendar with years of history is tens of megabytes; one that is still too big or too slow says so
const servers: Server[] = []
afterEach(() => servers.splice(0).forEach((s) => s.close()))
async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const s = createServer(handler); servers.push(s)
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}/cal.ics`
}
const chunk = 'X'.repeat(2 ** 20)

describe('fetching a calendar link', () => {
  it('room for years of history: 64 MB and a minute', () => {
    expect(MAX_BYTES).toBe(64 * 2 ** 20)
    expect(TIMEOUT_MS).toBe(60_000)
  })
  it('reads a feed of tens of megabytes', async () => {
    const url = await serve((_q, res) => { res.write('BEGIN:VCALENDAR\r\n'); for (let i = 0; i < 30; i++) res.write(chunk); res.end('END:VCALENDAR\r\n') })
    expect((await getCalendar(url)).length).toBe(30 * 2 ** 20 + 32)
  })
  it('a feed over the limit is too big, whether or not it says its size up front, and stops downloading', async () => {
    let sent = 0
    const streamed = await serve(async (_q, res) => {
      res.on('error', () => {})
      for (; sent < 80 && !res.destroyed; sent++) if (!res.write(chunk)) await new Promise((r) => res.once('drain', r).once('close', r))
      res.end()
    })
    await expect(getCalendar(streamed, { maxBytes: 8 * 2 ** 20 })).rejects.toBeInstanceOf(CalendarTooBig)
    expect(sent).toBeLessThan(80)
    const said = await serve((_q, res) => { res.writeHead(200, { 'content-length': String(100 * 2 ** 20) }); res.write(chunk); res.on('error', () => {}) })
    await expect(getCalendar(said, { maxBytes: 8 * 2 ** 20 })).rejects.toBeInstanceOf(CalendarTooBig)
  })
  it('a feed that takes too long to download is too big to read', async () => {
    const url = await serve((_q, res) => { res.write('BEGIN:VCALENDAR\r\n'); const t = setInterval(() => res.write('X'), 20); res.on('close', () => clearInterval(t)) })
    await expect(getCalendar(url, { timeoutMs: 300 })).rejects.toBeInstanceOf(CalendarTooBig)
  })
  it('an address that answers with an error, or a server that is not there, is not called too big', async () => {
    const url = await serve((_q, res) => { res.writeHead(404); res.end() })
    const got = await getCalendar(url).catch((e) => e)
    expect(got).toBeInstanceOf(Error); expect(got).not.toBeInstanceOf(CalendarTooBig)
    const closed = await serve(() => {}); servers.pop()!.close()
    const gone = await getCalendar(closed).catch((e) => e)
    expect(gone).toBeInstanceOf(Error); expect(gone).not.toBeInstanceOf(CalendarTooBig)
  })
})
