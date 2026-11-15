import { app, BrowserWindow, ipcMain, Notification } from 'electron'
import type { AppUpdater } from 'electron-updater'
import { t } from '../shared/i18n'
import type { UpdateStatus } from '../shared/types'
import { autoUpdateOn, loadSettings, updateSettings } from './settings'

/** checking again while Yogurt stays open for days */
const EVERY_MS = 4 * 60 * 60 * 1000

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

/** how long a downloaded version waits for a quit before the corner offers Restart, and how long X puts it off */
export const OFFER_AFTER_MS = 24 * 60 * 60 * 1000

/**
 * The corner offers Restart Yogurt for a downloaded version. Most people quit within a day, and it installs then
 * without a word; only someone who keeps Yogurt open longer is asked. Never during a call or a recording (restarting would end it).
 */
export function offersRestart(o: { readyAt?: number; now: number; snoozedUntil: number; recording: boolean; on: boolean; afterMs?: number }): boolean {
  return o.readyAt !== undefined && o.on && !o.recording && o.now - o.readyAt >= (o.afterMs ?? OFFER_AFTER_MS) && o.now >= o.snoozedUntil
}

let updater: AppUpdater | undefined
let announce = () => {}
/** a recording started or stopped: the corner's offer may change now */
export const updateOfferChanged = (): void => announce()
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
export async function hookUpdates(d: { file: string; available: boolean; recording(): boolean; /** a call app is on the mic, recorded or not */ onCall?(): boolean; /** fake mode: a version already downloaded */ fake?: { version: string; afterMs: number; restarted(): void } }): Promise<void> {
  let state: UpdateStatus['state'] = 'idle'
  let next: string | undefined
  let readyAt: number | undefined, snoozedUntil = 0
  const status = (): UpdateStatus => {
    const on = autoUpdateOn(loadSettings(d.file))
    const offer = offersRestart({ readyAt, now: Date.now(), snoozedUntil, recording: d.recording() || !!d.onCall?.(), on, afterMs: d.fake?.afterMs })
    return { version: app.getVersion(), available: d.available || !!d.fake, on, recording: d.recording(), state, next, offer }
  }
  const set = (s: UpdateStatus['state'], version?: string) => {
    state = s
    if (version) next = version
    if (s === 'ready') readyAt ??= Date.now()
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('updates:status', status())
  }

  announce = () => set(state)
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
  ipcMain.handle('updates:restart', () => {
    if (state !== 'ready' || d.recording()) return false
    // fake mode: as if Yogurt came back on the new version
    if (d.fake) { d.fake.restarted(); readyAt = undefined; set('latest'); return true }
    installOnQuit = true
    app.quit()
    return true
  })
  // the corner's X: ask again tomorrow
  ipcMain.handle('updates:later', () => { snoozedUntil = Date.now() + (d.fake?.afterMs ?? OFFER_AFTER_MS); set(state) })
  // the offer depends on the clock and on recording, so tell the windows again now and then once a version is ready
  setInterval(() => { if (state === 'ready') set(state) }, d.fake ? Math.max(200, d.fake.afterMs / 4) : 60 * 1000).unref?.()

  if (d.fake) { set('ready', d.fake.version); return }

  const check = () => { if (updater && autoUpdateOn(loadSettings(d.file)) && state !== 'ready') updater.checkForUpdates().catch(() => {}) }
  if (!d.available) return

  // loaded here: it reads Electron's app as it loads, which tests don't have
  updater = (await import('electron-updater')).default.autoUpdater
  updater.autoDownload = true
  updater.autoInstallOnAppQuit = autoUpdateOn(loadSettings(d.file))
  updater.logger = null
  updater.on('checking-for-update', () => set('checking'))
  updater.on('update-not-available', () => set('latest'))
  updater.on('update-available', (info) => set('downloading', info.version))
  updater.on('update-downloaded', (info) => {
    set('ready', info.version)
    if (!Notification.isSupported()) return
    new Notification({ title: t('Yogurt {version} is ready', { version: info.version }), body: t('It installs the next time you quit Yogurt.') }).show()
  })
  updater.on('error', (err) => {
    console.warn('checking for a new version failed', err.message)
    set('error')
  })
  setTimeout(check, 30_000)
  setInterval(check, EVERY_MS)
}
