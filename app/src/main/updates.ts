import { app, BrowserWindow, ipcMain, Notification } from 'electron'
import type { AppUpdater } from 'electron-updater'
import { deliveryFor } from '../shared/notificationDelivery'
import { t } from '../shared/i18n'
import type { UpdateStatus } from '../shared/types'
import { autoUpdateOn, loadSettings, updateSettings } from './settings'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
/** how often a running copy asks itself whether today's check is due */
const TICK_MS = 15 * 60 * 1000

/**
 * Each copy fetches latest*.yml about once per UTC day, so the release feed's daily downloads roughly count the copies
 * in use (no telemetry). Due when it never checked, on a later UTC day (once this copy's jitter, under an hour, has
 * passed, so copies don't all ask GitHub at midnight), after more than 24 h, or when the saved time is in the future
 * (the clock went back: that time can't be trusted, and waiting for it could mean weeks without updates).
 */
export function updateCheckDue(o: { now: number; last: number | undefined; jitterMs: number; on: boolean }): boolean {
  if (!o.on) return false
  const last = o.last
  if (typeof last !== 'number' || !Number.isFinite(last) || last > o.now || o.now - last >= DAY_MS) return true
  const today = Math.floor(o.now / DAY_MS) * DAY_MS
  return last < today && o.now >= today + Math.min(Math.max(o.jitterMs, 0), HOUR_MS - 1)
}

/**
 * Installed copies update themselves from GitHub Releases (latest-mac.yml, latest.yml for the Windows installer,
 * latest-linux.yml). Not while developing, testing, or on a separate profile; on Linux only the AppImage can replace itself.
 * Never in a preview build (preview.yml by hand): it was never released, so there is nothing to look for.
 */
export function updatesOn(o: { packaged: boolean; fake: boolean; profile: boolean; feed: boolean; platform?: string; appImage?: boolean; preview?: boolean }): boolean {
  return o.packaged && !o.fake && !o.profile && o.feed && !o.preview && (o.platform !== 'linux' || !!o.appImage)
}

/** preview.yml marks a build made by hand (not for a release) in the packaged package.json */
export const isPreviewBuild = (packageJson: string): boolean => {
  try { return JSON.parse(packageJson).yogurtPreview === true } catch { return false }
}

let updater: AppUpdater | undefined
let installOnQuit = false

/** After quit, installs a downloaded version and reopens if that was requested via Settings. */
export function finishQuit(): void {
  if (installOnQuit && updater) updater.quitAndInstall(true, true)
  else app.quit()
}

/**
 * Settings → Updates: the version, what the updater is doing, the on/off switch, and Restart Yogurt once a version is ready.
 * available: false in a build that never updates (see updatesOn); Settings then shows only the version.
 * DOES NOT WORK WHILE RECORDING.
 */
export async function hookUpdates(d: { file: string; available: boolean; recording(): boolean; /** started by an AI app and not opened yet: no notification (#147) */ quiet?(): boolean; /** fake mode: a version already downloaded */ fake?: { version: string; restarted(): void }; /** tests */ now?(): number; jitterMs?: number }): Promise<void> {
  const now = d.now ?? Date.now
  const jitterMs = d.jitterMs ?? Math.floor(Math.random() * HOUR_MS)
  let runningVersion = app.getVersion()
  let state: UpdateStatus['state'] = 'idle'
  let next: string | undefined, dismissedVersion: string | undefined
  const status = (): UpdateStatus => {
    const on = autoUpdateOn(loadSettings(d.file))
    return { version: runningVersion, available: d.available || !!d.fake, on, state, next, dismissed: !!next && next === dismissedVersion }
  }
  const set = (s: UpdateStatus['state'], version?: string) => {
    state = s
    if (version) next = version
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('updates:status', status())
  }

  ipcMain.handle('updates:status', status)
  ipcMain.handle('updates:set', (_e, on: unknown) => {
    if (typeof on !== 'boolean') return status()
    updateSettings(d.file, { autoUpdate: on ? undefined : false })
    // off means off: a version that already downloaded doesn't install on quit either (Restart Yogurt still can)
    if (updater) updater.autoInstallOnAppQuit = on
    if (on) check()
    return status()
  })
  ipcMain.handle('updates:check', () => { check() })
  ipcMain.handle('updates:later', () => {
    if (state !== 'ready' || !next) return
    dismissedVersion = next
    set(state)
  })
  ipcMain.handle('updates:restart', () => {
    if (state !== 'ready' || d.recording()) return false
    // fake mode: as if Yogurt came back on the new version
    if (d.fake) {
      d.fake.restarted()
      runningVersion = d.fake.version
      next = undefined
      set('latest')
      return true
    }
    installOnQuit = true
    app.quit()
    return true
  })
  // right away: at start (when due), Check for updates, and turning updates back on
  const check = () => { if (!d.fake && updater && autoUpdateOn(loadSettings(d.file)) && state !== 'ready') updater.checkForUpdates().catch(() => {}) }
  const checkIfDue = () => {
    const s = loadSettings(d.file)
    if (state !== 'checking' && updateCheckDue({ now: now(), last: s.lastUpdateCheck, jitterMs, on: autoUpdateOn(s) })) check()
  }
  // any feed that arrived counts as the day's check, a click on Check for updates too; a failed one is tried again next tick
  const checked = () => updateSettings(d.file, { lastUpdateCheck: now() })
  if (d.fake) { set('ready', d.fake.version); return }
  if (!d.available) return

  // loaded here: it reads Electron's app as it loads, which tests don't have
  updater = (await import('electron-updater')).default.autoUpdater
  updater.autoDownload = true
  updater.autoInstallOnAppQuit = autoUpdateOn(loadSettings(d.file))
  updater.logger = null
  updater.on('checking-for-update', () => set('checking'))
  updater.on('update-not-available', () => { checked(); set('latest') })
  updater.on('update-available', (info) => { checked(); set('downloading', info.version) })
  updater.on('update-downloaded', (info) => {
    set('ready', info.version)
    if (!Notification.isSupported() || d.quiet?.()) return
    const delivery = deliveryFor(loadSettings(d.file).notificationDelivery, 'updates')
    if (!delivery.system) return
    new Notification({ silent: !delivery.sound, title: t('Yogurt {version} is ready', { version: info.version }), body: t('It installs the next time you quit Yogurt.') }).show()
  })
  updater.on('error', (err) => {
    console.warn('checking for a new version failed', err.message)
    set('error')
  })
  setTimeout(checkIfDue, 30_000)
  setInterval(checkIfDue, TICK_MS)
}
