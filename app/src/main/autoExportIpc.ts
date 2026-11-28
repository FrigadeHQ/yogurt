import { dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import { createAutoExporter } from './autoExport'
import { isFake } from './paths'
import { loadSettings, updateSettings } from './settings'
import { t } from '../shared/i18n'
import type { AutoExportState } from '../shared/types'

/**
 * Settings → Backup's "Save a copy of each meeting to a folder". The folder always comes from the system's own folder
 * panel (tests name it with YOGURT_AUTO_EXPORT_PATH); the window only says on, off, change, open or save earlier ones.
 */
export function hookAutoExport(d: { settingsFile: string; indexFile: string; store: Parameters<typeof createAutoExporter>[0]['store']
  window: () => BrowserWindow | undefined; credit: () => boolean; busy: (id: string) => boolean; everyMs?: number }) {
  const settings = () => loadSettings(d.settingsFile)
  const send = (channel: string, payload: unknown) => { const w = d.window(); if (w && !w.isDestroyed()) w.webContents.send(channel, payload) }
  const exporter = createAutoExporter({ store: d.store, indexFile: d.indexFile, credit: d.credit, busy: d.busy,
    folder: () => { const s = settings(); return s.autoExport && s.autoExportFolder ? s.autoExportFolder : undefined },
    status: () => send('auto-export:state', state()) })
  const state = (): AutoExportState => {
    const s = settings()
    const on = !!s.autoExport && !!s.autoExportFolder
    return { on, folder: s.autoExportFolder ?? null, failed: on && exporter.status().failed, offerEarlier: on && s.autoExportAsked !== s.autoExportFolder }
  }
  const pick = async (): Promise<string | undefined> => {
    if (isFake()) return process.env.YOGURT_AUTO_EXPORT_PATH
    const opts = { title: t('Choose a folder for your meetings'), buttonLabel: t('Choose'), defaultPath: settings().autoExportFolder, properties: ['openDirectory' as const, 'createDirectory' as const] }
    const win = d.window()
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? undefined : r.filePaths[0]
  }
  // each time it's turned on or moved, earlier meetings are offered once
  const use = (folder: string) => { updateSettings(d.settingsFile, { autoExport: true, autoExportFolder: folder, autoExportAsked: undefined }); exporter.start() }

  ipcMain.handle('auto-export:get', state)
  // turning on without a folder asks for one first; cancelling leaves it off
  ipcMain.handle('auto-export:set', async (_e, on: unknown) => {
    if (on !== true) { updateSettings(d.settingsFile, { autoExport: undefined }); return state() }
    const folder = settings().autoExportFolder ?? await pick()
    if (folder) use(folder)
    return state()
  })
  ipcMain.handle('auto-export:choose', async () => {
    const folder = await pick()
    if (folder) use(folder)
    return state()
  })
  ipcMain.handle('auto-export:open', async () => {
    const folder = settings().autoExportFolder
    if (folder && !isFake()) { const err = await shell.openPath(folder); if (err) console.warn('auto export: could not open the folder', err) }
  })
  ipcMain.handle('auto-export:earlier', async (_e, save: unknown) => {
    const folder = settings().autoExportFolder
    if (folder) updateSettings(d.settingsFile, { autoExportAsked: folder })
    if (save !== true) return { saved: 0, failed: false }
    return exporter.saveEarlier((done, total) => send('auto-export:progress', { done, total }))
  })

  const timer = setInterval(() => { exporter.tick().catch((e) => console.error('auto export: tick failed', e)) }, d.everyMs ?? 2000)
  timer.unref?.()
  return { stop: () => clearInterval(timer) }
}
