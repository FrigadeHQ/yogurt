import { PERMISSION_KINDS } from '../main/permissions'
import type { PermissionKind } from './types'

/**
 * What Yogurt can do on each computer, in one place, so main and the windows hide the same things.
 * A Mac has everything, as it always had. Windows and Linux turn features on here as each one gets its own helper.
 */
export type Capabilities = {
  /** a calendar: the agenda, linking a note to an event. The Mac's own (EventKit, its permission) or a calendar link */
  calendar: boolean
  /** the calendar comes from a pasted private calendar address (Windows and Linux: no system calendar to read) */
  calendarLink: boolean
  /** names of the people in a call, read through Accessibility, and that permission */
  callNames: boolean
  /**
   * the Mac's own permission prompts and the drawn System Settings guide. Windows and Linux ask nothing up front
   * (the mic, call audio and notifications need no prompt); a mic Windows blocks is told when recording starts
   */
  permissionPrompts: boolean
  /**
   * Music and Spotify pause while a meeting records (AppleScript through yogurt-mac). Windows and Linux have no
   * helper for it yet (their media sessions, MPRIS): nothing is paused there
   */
  mediaPause: boolean
}

export function capabilities(platform: string): Capabilities {
  const mac = platform === 'darwin'
  // Linux reads call names through AT-SPI, Windows through UI Automation (yogurt-system call-watch), the same WatchLine JSON as the Mac
  return { calendar: true, calendarLink: !mac, callNames: mac || platform === 'linux' || platform === 'win32', permissionPrompts: mac, mediaPause: mac }
}

/** permission kinds Windows has a Settings page for (main/permissions.ts WINDOWS_SETTINGS has their links) */
const WINDOWS_PAGES: ReadonlySet<PermissionKind> = new Set(['mic', 'systemAudio', 'notifications'])
/** Whether a permission has a settings page to open here, so its row can offer Manage: every one on a Mac, the mic,
 * sound and notifications on Windows, none on Linux (#70: Manage on names from calls did nothing on Windows) */
export function settingsPage(platform: string, kind: PermissionKind): boolean {
  return platform === 'darwin' || (platform === 'win32' && WINDOWS_PAGES.has(kind))
}

/** The computer Yogurt runs on. Only fake mode may pretend to be another one (YOGURT_FAKE_PLATFORM), so Mac tests can try the others' screens. */
export function platformOf(real: string, env: Record<string, string | undefined>): string {
  const fake = env.YOGURT_FAKE === '1' ? env.YOGURT_FAKE_PLATFORM : undefined
  return fake === 'darwin' || fake === 'win32' || fake === 'linux' ? fake : real
}

export type HelperKind = 'system' | 'audio' | 'mcp' | 'whisper'
/** The helper programs in resources/bin. The Mac's system helper is yogurt-mac; on Windows and Linux it is yogurt-system. */
export function helperFile(kind: HelperKind, platform: string): string {
  const base = { system: platform === 'darwin' ? 'yogurt-mac' : 'yogurt-system', audio: 'yogurt-audio', mcp: 'yogurt-mcp', whisper: 'whisper-server' }[kind]
  return platform === 'win32' ? `${base}.exe` : base
}

/** Which helper lists the mics: yogurt-mac on a Mac; on Windows and Linux the recorder itself (yogurt-audio mic-devices, same JSON) */
export const micListHelper = (platform: string): HelperKind => (platform === 'darwin' ? 'system' : 'audio')

/** The permissions this computer has: no calendar or names from calls means those are never asked for */
export function supportedKinds(c: Capabilities): PermissionKind[] {
  // a calendar link is no permission: it lives in Settings' calendars and the first run's calendar screen
  return PERMISSION_KINDS.filter((k) => (k !== 'calendar' || (c.calendar && !c.calendarLink)) && (k !== 'accessibility' || c.callNames))
}

/** keys a Mac shortcut means something else on Windows and Linux (⌃⌘ is no pair there; full screen is F11) */
const PC_KEYS: Record<string, string> = { '⌃⌘S': 'Ctrl+Shift+S', '⌃⌘F': 'F11', '⌥⇧⌘V': 'Ctrl+Shift+V' }
/** A shortcut written the Mac's way (⌘K, ⇧⌘C) as this computer writes it: the same on a Mac, Ctrl+K and Ctrl+Shift+C elsewhere */
export function shortcutLabel(mac: string, platform: string): string {
  if (platform === 'darwin') return mac
  if (PC_KEYS[mac]) return PC_KEYS[mac]
  const key = mac.replace(/[⌃⇧⌥⌘]/g, '')
  if (key === mac) return mac
  const mods = [mac.includes('⌘') || mac.includes('⌃') ? 'Ctrl' : '', mac.includes('⇧') ? 'Shift' : '', mac.includes('⌥') ? 'Alt' : ''].filter(Boolean)
  return [...mods, key].join('+')
}

/** The key held for commands (⌘K): ⌘ on a Mac, Ctrl on Windows and Linux (without the Windows key, which the system keeps) */
export const commandKey = (e: { metaKey: boolean; ctrlKey: boolean }, platform: string): boolean =>
  platform === 'darwin' ? e.metaKey : e.ctrlKey && !e.metaKey

/** One sentence's words on each computer: a Mac's as they always were; Windows and Linux share one (other) or have their own */
export type OsWords = { mac: string } & ({ other: string } | { windows: string; linux: string })
export function forOs(w: OsWords, platform: string): string {
  if (platform === 'darwin') return w.mac
  if ('other' in w) return w.other
  return platform === 'win32' ? w.windows : w.linux
}
