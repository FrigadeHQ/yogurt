import type { CalEvent, Helper } from './calendar'
import { callAppId, tabTitleApp, type MicApp } from './detect'

const MIN = 60_000
/**
 * A helper whose own bundle ID matches no call app counts as the app it sits inside (`app`, from its path): Dia's and
 * Arc's mic helper share one ID, company.thebrowser.browser.helper (#131).
 */
const ownerOf = (bundleId: string, app: unknown): string =>
  !callAppId(bundleId) && typeof app === 'string' && callAppId(app) ? app : bundleId
const TITLE_TTL = 10_000

/** What the Mac says right now: which apps use the mic, and the calendar around now. */
export type Reading = { micApps: MicApp[]; events: CalEvent[]; runningApps?: string[] }

/**
 * Gathers the signals. The mic comes from micApps (the Mac's long-lived mic watch, #143), else a helper each time;
 * the calendar at most once a minute,
 * since it only matters near a start time. Failed owner checks skip the observation.
 */
export function createSignals(d: { helper: Helper; micApps?: () => Promise<unknown>; events: (from: number, to: number) => Promise<CalEvent[]>; eventsTtlMs?: number }) {
  let cache: { at: number; events: CalEvent[] } | undefined
  let override: Reading | undefined
  let revision = 0
  const titles = new Map<string, { at: number; title: string | undefined }>()
  return {
    invalidateCalendar() { revision++; cache = undefined },
    /** tests and fake mode: pretend the Mac said this (undefined: ask the Mac again) */
    override(r: Reading | undefined) { override = r },
    async read(now: number): Promise<Reading> {
      if (override) return override
      let micApps: MicApp[] = []
      try {
        const raw = d.micApps ? await d.micApps() : await d.helper(['mic-apps'])
        if (Array.isArray(raw)) micApps = raw.flatMap((r: Record<string, unknown>) => typeof r?.bundleId === 'string' ? [{
          bundleId: ownerOf(r.bundleId, r.app), name: typeof r.name === 'string' ? r.name : r.bundleId,
          // which process: two Zoom meetings are two processes, and names come only from the one on the mic (#98)
          ...(typeof r.pid === 'number' ? { pid: r.pid } : {}),
        }] : [])
      } catch { /* no helper: no signal */ }
      const owners = [...new Set(micApps.flatMap(m => {
        const id = callAppId(m.bundleId)
        return id && id !== m.bundleId ? [id] : []
      }))]
      let runningApps: string[] = []
      if (owners.length) {
        const result = await d.helper(['running-apps', ...owners])
        // Skip this observation on failure rather than treating an unknown owner as a call ending.
        if (!Array.isArray(result)) throw new Error('Could not read running call apps')
        runningApps = result.filter((id): id is string => typeof id === 'string' && owners.includes(id))
      }
      // the front tab's name, only for a browser that is on the mic, and not more than every 10 s
      for (const m of micApps) {
        const app = tabTitleApp(m.bundleId)
        if (!app) continue
        let hit = titles.get(app)
        if (!hit || now - hit.at >= TITLE_TTL) {
          let title: string | undefined
          try { const r = await d.helper(['browser-title', app]) as { title?: unknown }; if (typeof r?.title === 'string') title = r.title } catch { /* no permission: no title */ }
          hit = { at: now, title }; titles.set(app, hit)
        }
        if (hit.title) m.title = hit.title
      }
      if (!cache || now - cache.at > (d.eventsTtlMs ?? MIN)) {
        // a meeting that started an hour ago may still be on; one starting soon needs to be known
        const started = revision
        const events = await d.events(now - 60 * MIN, now + 30 * MIN).catch(() => [])
        if (started === revision) cache = { at: now, events }
      }
      return { micApps, events: cache?.events ?? [], runningApps }
    },
  }
}
