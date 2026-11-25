// Settings → iPhone talks to the companion through these. It starts after the window can ask, so each call waits for
// it; when it never started (fake mode, or it failed) the status is null and Settings shows nothing to pair.
import { ipcMain } from 'electron'
import type { CompanionStatus } from '../../shared/companion'
import type { Companion } from './index'

type Bridge = Pick<Companion, 'status' | 'onStatus' | 'startPairing' | 'cancelPairing' | 'unpair'>

export function hookCompanion(d: { companion: Promise<Bridge | undefined>; send: (s: CompanionStatus) => void }) {
  const ready = d.companion.catch(() => undefined)
  void ready.then((c) => { c?.onStatus(d.send) })
  ipcMain.handle('companion:status', async () => (await ready)?.status() ?? null)
  // the code itself is in the status; a failure's reason too (keychain, listen)
  ipcMain.handle('companion:start-pairing', async () => {
    const c = await ready
    if (!c) return { ok: false, status: null }
    try { await c.startPairing(); return { ok: true, status: c.status() } } catch { return { ok: false, status: c.status() } }
  })
  // a failure answers the status as it is, so the window shows what is true rather than an error it can't place
  ipcMain.handle('companion:cancel-pairing', async () => { const c = await ready; await c?.cancelPairing().catch(() => {}); return c?.status() ?? null })
  ipcMain.handle('companion:unpair', async () => { const c = await ready; await c?.unpair().catch(() => {}); return c?.status() ?? null })
}
