import { language, t } from '../shared/i18n'
import { dayLabel, daysAgo } from '../shared/dates'
import { formatElapsed } from '../shared/wave'
import type { CalEvent } from './calendar'

export type TrayItem = { id: 'status' | 'open' | 'new' | 'stop' | 'pause' | 'ask' | 'next' | 'join' | 'recent' | 'settings' | 'quit' | 'sep' | `note:${string}`; label: string; enabled: boolean; accelerator?: string; submenu?: TrayItem[] }
type Recent = { id: string; title: string; startedAt: number }

/** Include the full seventh local date so next week's meeting can be seen all day. */
export function trayWindowEnd(now: number): number {
  const end = new Date(now)
  end.setDate(end.getDate() + 8)
  end.setHours(0, 0, 0, 0)
  return end.getTime()
}

export function nextTrayEvent(events: CalEvent[], now = Date.now()): CalEvent | undefined {
  const end = trayWindowEnd(now)
  return events.filter(e => !e.declined && e.end > now && e.start < end && (e.attendees.length > 0 || !!e.url?.trim()))
    .sort((a, b) => a.start - b.start)[0]
}

const MINUTE = 60_000
const TITLE_LIMIT = 22
const graphemes = new Intl.Segmenter()

function shortMeetingTitle(raw: string): string {
  const title = raw.replace(/[\s\p{Cc}]+/gu, ' ').trim() || t('Meeting')
  let length = 0
  for (const { index, segment } of graphemes.segment(title)) {
    if (++length === TITLE_LIMIT && index + segment.length < title.length) return title.slice(0, index).trimEnd() + '…'
  }
  return title
}

export function formatTrayTime(start: number, dated: boolean, locale: string = language(), hour12?: boolean): string {
  const date = new Date(start)
  const time = date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', hour12 })
  return dated ? `${date.toLocaleDateString(locale, { month: 'short', day: 'numeric' })} ${time}` : time
}

export function trayTitle(active: { elapsedMs: number; paused: boolean } | null, next?: CalEvent, now = Date.now(), clock = formatTrayTime): string {
  if (active) return active.paused ? t('Paused') : formatElapsed(active.elapsedMs)
  if (!next || next.end <= now) return ''
  const title = shortMeetingTitle(next.title)
  if (next.start <= now) return t('Now · {title}', { title })
  const dated = daysAgo(next.start, now) !== 0
  const minutes = Math.ceil((next.start - now) / MINUTE)
  if (dated || minutes > 60) return `${title} · ${clock(next.start, dated)}`
  const time = new Intl.NumberFormat(language(), { style: 'unit', unit: minutes === 60 ? 'hour' : 'minute', unitDisplay: 'narrow' }).format(minutes === 60 ? 1 : minutes)
  return t('{title} · in {time}', { title, time })
}

/** Keep native and hidden-test menus identical; only the native icon is optional. */
export function trayItems(active: { id?: string; title: string; paused?: boolean } | null, next?: CalEvent, recent: Recent[] = [], now = Date.now(), os = 'darwin', clock = formatTrayTime): TrayItem[] {
  const sep: TrayItem = { id: 'sep', label: '', enabled: true }
  const open: TrayItem = { id: 'open', label: t('Open Yogurt'), enabled: true }
  const ask: TrayItem = { id: 'ask', label: t('Ask Yogurt'), enabled: true }
  const settings: TrayItem = { id: 'settings', label: t('Settings…'), accelerator: os === 'darwin' ? 'Command+,' : 'Ctrl+,', enabled: true }
  const quit: TrayItem = { id: 'quit', label: t('Quit Yogurt'), enabled: true }
  const history: TrayItem = { id: 'recent', label: t('Recent'), enabled: recent.length > 0, submenu: [...recent].sort((a, b) => b.startedAt - a.startedAt).slice(0, 5)
    .map(m => ({ id: `note:${m.id}`, label: `${m.title || t('Untitled meeting')} · ${dayLabel(m.startedAt)}`, enabled: true })) }
  const laterDay = !!next && next.start > now && daysAgo(next.start, now) !== 0
  if (!active) return [
    ...(next ? [{ id: 'next' as const, label: next.start <= now ? t('Now · {title}', { title: next.title || t('Meeting') }) : `${next.title || t('Meeting')} · ${clock(next.start, laterDay)}`, enabled: !laterDay },
      ...(!laterDay && next.url?.trim() ? [{ id: 'join' as const, label: t('Join and record'), enabled: true }] : [])] : []),
    { id: 'new', label: t('Start recording'), enabled: true }, ask, history, sep, open, settings, sep, quit,
  ]
  return [
    { id: 'status', label: active.paused ? t('Paused · {title}', { title: active.title }) : t('Recording · {title}', { title: active.title }), enabled: false },
    { id: 'pause', label: active.paused ? t('Resume recording') : t('Pause recording'), enabled: true },
    { id: 'stop', label: t('Stop recording'), enabled: true }, sep,
    ask, open, history, settings, sep, quit,
  ]
}

/** macOS shows the timer beside its template icon. Other platforms mark the running timer in the tooltip. */
export function trayLook(os: string, active: { paused: boolean } | null, elapsedMs: number, next?: CalEvent, now = Date.now(), clock = formatTrayTime): { icon: 'tray' | 'tray-titled' | 'tray-color' | 'tray-recording'; template: boolean; title: string | null; tooltip: string } {
  const tooltip = active?.paused ? t('Recording paused') : active ? t('Yogurt is recording') : 'Yogurt'
  const title = trayTitle(active ? { elapsedMs, paused: active.paused } : null, next, now, clock)
  // The titled template adds 1 pt between the mark and the native title.
  if (os === 'darwin') return { icon: title ? 'tray-titled' : 'tray', template: true, title, tooltip }
  const recording = active && !active.paused
  return { icon: recording ? 'tray-recording' : 'tray-color', template: false, title: null, tooltip: recording ? `● ${title}` : title || tooltip }
}

/** dbus-send's answer to NameHasOwner org.kde.StatusNotifierWatcher: is there a tray to show an icon in? */
export const hasTrayHost = (stdout: string): boolean => /\bboolean true\b/.test(stdout)
