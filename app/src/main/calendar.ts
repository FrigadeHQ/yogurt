import { execFile, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { helperFile } from '../shared/platform'
import type { Person } from './store'
import type { Settings } from './settings'
import { noteOwnEmail } from './vocab'
import { ownAddress } from '../shared/people'

/** One meeting on the calendar, times in ms */
export type CalEvent = { id: string; title: string; start: number; end: number; attendees: Person[]; url: string | null; calendar?: CalendarSource; aliases?: string[]; ownEmail?: string | null; declined?: boolean }
export type CalendarSource = { id: string; name: string; source: string; color?: string }
export const eventIds = (event: CalEvent): string[] => [event.id, ...(event.aliases ?? [])]
export const matchesEvent = (event: CalEvent, id: string | null): boolean => !!id && eventIds(event).includes(id)
/** error: the Mac helper failed, so Yogurt can't tell (not the same as access turned off). unsupported: no calendar on this computer (Windows, Linux) */
export type CalendarStatus = 'granted' | 'denied' | 'notDetermined' | 'error' | 'unsupported'

/** yogurt-mac: JSON out, or a readable error */
export type Helper = (args: string[]) => Promise<unknown>

export function helperPath(): string {
  const file = helperFile('system', process.platform)
  const candidates = [
    process.resourcesPath && join(process.resourcesPath, 'bin', file),
    join(__dirname, '../../resources/bin', file),
    join(__dirname, '../../../resources/bin', file),
  ].filter((x): x is string => !!x)
  return candidates.find((c) => existsSync(c)) ?? candidates.at(-1)!
}

/** Runs yogurt-mac and keeps track of the ones still going, so quitting can end them (a question nobody answered waits) */
export function createHelperRunner(path: () => string) {
  const running = new Set<ChildProcess>()
  const run: Helper = (args) => new Promise((resolve, reject) => {
    const child = execFile(path(), args, { timeout: 150_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      running.delete(child)
      if (err) return reject(new Error(stderr.trim() || err.message))
      try { resolve(JSON.parse(stdout)) } catch { reject(new Error('The Mac helper gave an answer Yogurt could not read.')) }
    })
    running.add(child)
  })
  return {
    run,
    running: () => [...running].flatMap((c) => (c.pid ? [c.pid] : [])),
    killAll: () => { for (const c of running) c.kill('SIGKILL'); running.clear() },
  }
}
const real = createHelperRunner(helperPath)
const realHelper: Helper = real.run
/** quitting: no yogurt-mac outlives Yogurt */
export const killAllHelpers = () => real.killAll()

let helper: Helper = realHelper
/** tests and fake mode: talk to a stand-in instead of the Mac helper */
export const setHelper = (h: Helper) => { helper = h }
export const runHelper: Helper = (args) => helper(args)

let status: CalendarStatus = 'notDetermined'
/** what the helper last said; refreshed by upcoming() and refreshCalendarStatus() */
export const calendarStatus = (): CalendarStatus => status

const asStatus = (v: unknown): CalendarStatus => {
  const s = (v as { status?: string } | null)?.status
  return s === 'granted' ? 'granted' : s === 'notDetermined' ? 'notDetermined' : 'denied'
}
let supported = true
/** Windows and Linux have no calendar (capabilities().calendar): the helper is never asked, and nothing shows it */
export const setCalendarSupported = (on: boolean) => { supported = on; if (!on) status = 'unsupported' }

/**
 * Windows and Linux: the calendar comes from calendar links (calendarLink/), which answer what the Mac helper answers
 * here (status, calendars, events in its shape), so the rest of Yogurt never knows the difference. null: the helper.
 */
export type CalendarLinkSource = { status(): 'granted' | 'notDetermined'; calendars(): Promise<CalendarSource[]>; events(fromMs: number, toMs: number): Promise<unknown[]> }
let links: CalendarLinkSource | null = null
/** a Mac: links are added next to the Mac's own calendars (Settings), never instead of them */
let alongside = false
/** a Mac's own calendar access, apart from the links */
let macStatus: CalendarStatus = 'notDetermined'
export const setCalendarLinkSource = (s: CalendarLinkSource | null, o: { alongside?: boolean } = {}) => {
  links = s; alongside = !!s && !!o.alongside
  if (s && !alongside) status = s.status()
}
/** the Mac's own calendar access, apart from any links (Settings shows both) */
export const systemCalendarStatus = (): CalendarStatus => (links && !alongside ? 'unsupported' : macStatus)
/** with links alongside, a connected link is a calendar even while the Mac's own one isn't allowed */
const overall = (mac: CalendarStatus): CalendarStatus => (links && mac !== 'granted' && links.status() === 'granted' ? 'granted' : mac)

export async function refreshCalendarStatus(): Promise<CalendarStatus> {
  if (links && !alongside) return status = links.status()
  if (!supported) macStatus = 'unsupported'
  else try { macStatus = asStatus(await helper(['calendar-status'])) } catch { macStatus = 'error' }
  return status = overall(macStatus)
}
/** Asks once with the system's own prompt */
export async function requestCalendarAccess(): Promise<CalendarStatus> {
  // a link has no prompt: it is connected when one is pasted (Settings or the first run)
  if (links && !alongside) return status = links.status()
  if (!supported) macStatus = 'unsupported'
  else try { macStatus = asStatus(await helper(['calendar-auth'])) } catch { macStatus = 'error' }
  return status = overall(macStatus)
}

// Links that start a call; anything else in an invite (docs, agendas) is not one
const LINK = /https?:\/\/(?:[\w-]+\.)?(?:zoom\.us|zoomgov\.com|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|webex\.com|whereby\.com|facetime\.apple\.com|discord\.gg|around\.co|gotomeeting\.com)\/[^\s<>"')]*/i
export const meetingLink = (text: string | undefined | null): string | null => text?.match(LINK)?.[0] ?? null

const str = (v: unknown) => (typeof v === 'string' && v ? v : null)
let calendarSelection = (): Pick<Settings, 'hiddenCalendarIds' | 'hideEventsWithoutCallLink'> => ({})
let rememberOwnEmail = (_email: string) => {}
export const setCalendarOwnEmail = (remember: typeof rememberOwnEmail) => { rememberOwnEmail = remember }
export const setCalendarSelection = (read: typeof calendarSelection) => { calendarSelection = read }

export async function calendars(): Promise<CalendarSource[]> {
  if (await refreshCalendarStatus() !== 'granted') return []
  const linked = links ? await links.calendars() : []
  if ((links && !alongside) || macStatus !== 'granted') return linked
  try {
    const raw = await helper(['calendars'])
    if (!Array.isArray(raw)) throw new Error('Invalid calendars')
    return [...raw.flatMap((r) => r && typeof r === 'object' && str(r.id) && str(r.name)
      ? [{ id: r.id as string, name: r.name as string, source: str(r.source) ?? '', ...(typeof r.color === 'string' && /^#[0-9a-f]{6}$/i.test(r.color) ? { color: r.color } : {}) }] : []), ...linked]
  } catch { status = 'error'; return linked }
}

export function parseEvents(raw: unknown, hidden: string[] = []): CalEvent[] {
  if (!Array.isArray(raw)) return []
  const groups = new Map<string, CalEvent[]>()
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r !== 'object') continue
    const id = str(r.id), start = Date.parse(String(r.start)), end = Date.parse(String(r.end))
    // the helper leaves the person using this Mac out of the attendees, and gives their address on its own
    const ownEmail = ownAddress(r.me)
    // a meeting shared onto a second calendar comes twice with the same id; once is enough, and the list needs ids to be unique
    if (!id || Number.isNaN(start) || Number.isNaN(end)) continue
    if (ownEmail) { noteOwnEmail(ownEmail); rememberOwnEmail(ownEmail) }
    const attendees = (Array.isArray(r.attendees) ? r.attendees : []).flatMap((a: Record<string, unknown>) => {
      const name = str(a?.name), email = str(a?.email)
      return name || email ? [{ name: name ?? email!, email }] : []
    }).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) || (a.email ?? '').localeCompare(b.email ?? ''))
    // Server IDs identify copies across calendars; recurring occurrences must keep their own times.
    const identity = str(r.externalId), calendarId = str(r.calendarId)
    const key = identity ? JSON.stringify([identity, start, end]) : id
    const copies = groups.get(key) ?? []
    copies.push({
      id, ...(ownEmail ? { ownEmail } : {}), ...(r.declined === true ? { declined: true } : {}), title: str(r.title) ?? '', start, end, attendees,
      url: meetingLink(str(r.url)) ?? meetingLink(str(r.location)) ?? meetingLink(str(r.notes)),
      ...(calendarId ? { calendar: { id: calendarId, name: str(r.calendar) ?? '', source: str(r.calendarSource) ?? '' } } : {}),
    })
    groups.set(key, copies)
  }
  return [...groups.values()].flatMap((copies) => {
    const visible = copies.filter((e) => !e.calendar || !hidden.includes(e.calendar.id))
    const [event] = visible
    if (!event) return []
    const aliases = [...new Set(copies.map((e) => e.id))].filter((id) => id !== event.id)
    return [{ ...event, ...(aliases.length ? { aliases } : {}), ...(visible.some(copy => copy.declined) ? { declined: true } : {}) }]
  })
}

/** Events between two times. No Calendar access, or a helper that fails: none, never a crash. */
export async function upcoming(fromMs: number, toMs: number, keep?: 'link-event' | ((event: CalEvent) => boolean), { fullRange = false } = {}): Promise<CalEvent[]> {
  if (await refreshCalendarStatus() !== 'granted') return []
  try {
    const fromMac = !links || (alongside && macStatus === 'granted')
    const mac = fromMac ? await helper(['events', new Date(fromMs).toISOString(), new Date(toMs).toISOString(), ...(fullRange ? ['--full-range'] : [])]) : []
    const raw = [...(links ? await links.events(fromMs, toMs) : []), ...(Array.isArray(mac) ? mac : [])]
    const selection = calendarSelection()
    const events = parseEvents(raw, selection.hiddenCalendarIds)
    if (keep === 'link-event' || selection.hideEventsWithoutCallLink !== true) return events
    return events.filter(event => event.url !== null || keep?.(event))
  } catch { status = 'error'; return [] }
}
