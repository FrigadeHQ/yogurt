// Transcript lab, hooked into the app with one call from index.ts.
import { ipcMain, type BrowserWindow } from 'electron'
import { recordingFinished } from '../capture'
import { onMeetingStart, onMeetingStop } from '../meeting'
import { transcriptFinished, transcribing } from '../asr'
import { isId } from '../ipcArgs'
import type { AudioExt } from '../audio'
import type { Store } from '../store'
import { labFile, readLab, type LabConfig } from './config'
import { createTranscriptLab } from './index'

export function hookTranscriptLab(p: {
  store: Store
  userData: string
  dirOf: (id: string) => string
  exts: readonly AudioExt[]
  windows: () => Array<BrowserWindow | undefined>
  /** the transcript changed: search index and notes catch up */
  transcriptChanged: (id: string) => void
}) {
  const file = labFile(p.userData)
  let cached: { at: number; c: LabConfig | null } | undefined
  // read again at most every few seconds, so a change to the file counts without a restart
  const config = () => {
    if (!cached || Date.now() - cached.at > 5000) {
      try { cached = { at: Date.now(), c: readLab(file) } } catch (e) { console.error('lab:', e instanceof Error ? e.message : e); cached = { at: Date.now(), c: null } }
    }
    return cached.c
  }
  // meetings whose lines are still coming: from the start until the live transcript is all saved
  const going = new Set<string>()
  const send = (ch: string, ...args: unknown[]) => { for (const w of p.windows()) if (w && !w.isDestroyed()) w.webContents.send(ch, ...args) }
  const lab = createTranscriptLab({
    store: p.store, config, dirOf: p.dirOf, exts: p.exts,
    busy: () => transcribing(),
    live: (id) => going.has(id),
    // the window reads every line again on lab:changed (lines can go away, which transcript:speakers does not handle)
    changed: (id, transcript) => { send('lab:changed', id, transcript); if (transcript) p.transcriptChanged(id) },
  })
  onMeetingStart((m) => { going.add(m.id) })
  onMeetingStop((m) => {
    void Promise.all([recordingFinished(m.id), transcriptFinished(m.id)])
      .then(() => { going.delete(m.id); return lab.finished(m.id) })
      .catch((e) => { going.delete(m.id); console.error('lab:', e) })
  })

  ipcMain.handle('lab:enabled', () => lab.enabled())
  ipcMain.handle('lab:view', (_e, id: unknown) => (isId(id) ? lab.view(id) : null))
  ipcMain.handle('lab:run', (_e, id: unknown) => (isId(id) ? lab.run(id) : false))
  ipcMain.handle('lab:stop', (_e, id: unknown) => { if (isId(id)) lab.stop(id) })
  ipcMain.handle('lab:use', (_e, id: unknown, version: unknown) => { if (isId(id) && typeof version === 'string' && version.length < 100) lab.use(id, version) })
  ipcMain.handle('lab:fix', (_e, id: unknown, key: unknown, text: unknown) => {
    if (isId(id) && typeof key === 'string' && key.length < 64 && (text === null || (typeof text === 'string' && text.length < 20_000))) lab.fix(id, key, text)
  })
  ipcMain.handle('lab:scores', () => lab.scores())
  return lab
}
