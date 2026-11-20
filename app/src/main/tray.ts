import { app, Menu, nativeImage, powerMonitor, systemPreferences, Tray, type MenuItemConstructorOptions } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { activeMeeting, onMeetingChange } from './meeting'
import { execFile } from 'node:child_process'
import { formatTrayTime, hasTrayHost, nextTrayEvent, trayItems, trayLook, type TrayItem } from './trayMenu'
import { daysAgo } from '../shared/dates'
import { onLanguage } from '../shared/i18n'
import { onRecordingEvent, recordingPaused } from './capture'
import type { CalEvent } from './calendar'

function systemTrayTime(start: number, dated: boolean): string {
  let hour12: boolean | undefined
  if (process.platform === 'darwin') {
    if (systemPreferences.getUserDefault('AppleICUForce24HourTime', 'boolean')) hour12 = false
    else if (systemPreferences.getUserDefault('AppleICUForce12HourTime', 'boolean')) hour12 = true
  }
  return formatTrayTime(start, dated, app.getSystemLocale() || undefined, hour12)
}

function iconPath(name = 'tray'): string {
  const candidates = [
    process.resourcesPath && join(process.resourcesPath, `${name}.png`),
    join(__dirname, `../../resources/${name}.png`),
  ].filter((x): x is string => !!x)
  return candidates.find((c) => existsSync(c)) ?? candidates.at(-1)!
}

/** Linux: is there a tray (a StatusNotifier host) to show the icon in? GNOME has one only with its AppIndicator extension. */
export const linuxTrayHost = (): Promise<boolean> => new Promise((done) => {
  execFile('dbus-send', ['--session', '--print-reply', '--dest=org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus.NameHasOwner', 'string:org.kde.StatusNotifierWatcher'],
    { timeout: 3000 }, (error, stdout) => done(!error && hasTrayHost(stdout)))
})

/**
 * Yogurt in the menu bar (the notification area on Windows, the tray on Linux): it keeps running there with its window closed, so it still notices calls.
 * The menu says what is recording. Tests run without it on screen (show: false) and read the menu through items().
 */
export function createTray(d: { show: boolean; visible?: boolean; showNextMeeting?: boolean; open(): void; newNote(): void; stop(id: string): void
  pause(id: string, paused: boolean): void; ask(): void; settings(): void; openNote(id: string): void
  events(): Promise<CalEvent[]>; event(event: CalEvent, join: boolean): Promise<void>
  recent(): { id: string; title: string; startedAt: number }[]; elapsed(): number; now?: () => number
  /** the computer: a Mac's template icon and timer title, a colour icon elsewhere */
  os?: string
  /** Linux: whether a tray host is there to show the icon */
  host?: () => Promise<boolean>
}) {
  const os = d.os ?? 'darwin'
  let visible = d.visible !== false, hosted = true, iconName = ''
  let showNextMeeting = d.showNextMeeting !== false
  let lastTitle: string | undefined, lastTooltip: string | undefined
  let clock: NodeJS.Timeout | undefined
  let boundary: NodeJS.Timeout | undefined
  let tray: Tray | undefined
  let items: TrayItem[] = []
  let events: CalEvent[] = []
  const now = d.now ?? Date.now
  const act = (id: TrayItem['id']) => {
    const m = activeMeeting()
    if (id === 'open') d.open()
    else if (id === 'new' && !m) d.newNote()
    else if (id === 'ask') d.ask()
    else if (id === 'settings') d.settings()
    else if (id.startsWith('note:')) d.openNote(id.slice(5))
    else if ((id === 'next' || id === 'join') && !m && showNextMeeting) {
      const at = now(), event = nextTrayEvent(events, at)
      if (event && (event.start <= at || daysAgo(event.start, at) === 0)) void d.event(event, id === 'join').catch(error => console.error('Menu bar event action failed', error))
    }
    else if (id === 'pause' && m) d.pause(m.id, !recordingPaused(m.id))
    else if (id === 'stop' && m) d.stop(m.id)
    else if (id === 'quit') app.quit()
  }
  const look = (m: ReturnType<typeof activeMeeting>, next?: CalEvent, at = now()) =>
    trayLook(os, m ? { paused: recordingPaused(m.id) } : null, m ? d.elapsed() : 0, next, at, systemTrayTime)
  const image = (name: string) => {
    const icon = nativeImage.createFromPath(iconPath(name))
    if (os === 'darwin') icon.setTemplateImage(true)
    return icon
  }
  const updateLook = () => {
    clearTimeout(boundary)
    if (!tray) return
    const m = activeMeeting(), at = now()
    const next = !m && showNextMeeting ? nextTrayEvent(events, at) : undefined
    if (next) {
      // Count down on the meeting's minute boundary, even for off-minute starts.
      const untilStart = next.start - at
      let untilChange = next.end - at
      if (untilStart > 3_600_000) untilChange = untilStart - 3_600_000
      else if (untilStart > 0) untilChange = untilStart % 60_000 || 60_000
      if (untilChange < 60_000 - at % 60_000) boundary = setTimeout(updateLook, untilChange).unref()
    }
    const l = look(m, next, at)
    if (l.icon !== iconName) { tray.setImage(image(l.icon)); iconName = l.icon }
    if (l.title !== null && l.title !== lastTitle) { tray.setTitle(l.title, { fontType: 'monospacedDigit' }); lastTitle = l.title }
    if (l.tooltip !== lastTooltip) { tray.setToolTip(l.tooltip); lastTooltip = l.tooltip }
  }
  const template = (list: TrayItem[]): MenuItemConstructorOptions[] => list.map(i => i.id === 'sep' ? { type: 'separator' }
    : { label: i.label, enabled: i.enabled, accelerator: i.accelerator, ...(i.submenu ? { submenu: template(i.submenu) } : { click: () => act(i.id) }) })
  const refresh = () => {
    const m = activeMeeting()
    const paused = !!m && recordingPaused(m.id)
    if (tray && m && !paused) clock ??= setInterval(updateLook, 1000).unref()
    else { clearInterval(clock); clock = undefined }
    const at = now()
    items = trayItems(m ? { id: m.id, title: m.title, paused } : null, showNextMeeting ? nextTrayEvent(events, at) : undefined, d.recent(), at, os, systemTrayTime)
    if (!tray) return
    tray.setContextMenu(Menu.buildFromTemplate(template(items)))
    updateLook()
  }
  const setVisible = (on: boolean) => {
    visible = on
    if (!on || !d.show) {
      clearTimeout(boundary)
      tray?.destroy()
      tray = undefined
      lastTitle = lastTooltip = undefined
    } else if (!tray) {
      iconName = look(activeMeeting()).icon
      tray = new Tray(image(iconName))
      tray.on('mouse-down', refresh)
      // Windows: a left click opens Yogurt and a right click shows the menu (Linux trays mostly show the menu)
      if (os !== 'darwin') tray.on('click', () => d.open())
    }
    refresh()
  }
  let calendarRevision = 0
  const refreshCalendar = async () => {
    const revision = ++calendarRevision
    try {
      const result = await d.events()
      if (revision === calendarRevision) { events = result; refresh() }
    } catch (error) {
      if (revision === calendarRevision) { events = []; refresh() }
      console.warn('Menu bar calendar unavailable', error)
    }
  }
  setVisible(visible)
  void d.host?.().then((yes) => {
    hosted = yes
    if (!yes) console.warn('TRAY no tray host here (GNOME needs the AppIndicator extension): closing the window minimises it')
  })
  let calendar: NodeJS.Timeout
  const tick = () => {
    clearTimeout(calendar)
    calendar = setTimeout(tick, 60_000 - now() % 60_000).unref()
    updateLook()
    void refreshCalendar()
  }
  tick()
  powerMonitor.on('resume', tick)
  app.on('will-quit', () => { clearInterval(clock); clearTimeout(calendar); clearTimeout(boundary); powerMonitor.off('resume', tick) })
  onMeetingChange(refresh)
  onLanguage(refresh)
  onRecordingEvent((e) => { if (e.t === 'paused') refresh() })
  return {
    setVisible, setShowNextMeeting: (on: boolean) => { showNextMeeting = on; refresh() },
    refreshCalendar, items: () => { refresh(); return items.map((i) => i.label) }, click: act,
    /** whether the person can see the icon (on in Settings, and a tray to show it in): closing hides the window only then */
    shown: () => visible && hosted,
    /** for tests: each item's shortcut */
    accelerators: () => Object.fromEntries(items.filter((i) => i.accelerator).map((i) => [i.label, i.accelerator])),
  }
}
