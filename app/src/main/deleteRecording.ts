import { readdirSync, rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { Store } from './store'
import { isId } from './ipcArgs'
import type { DeleteRecordingResult } from '../shared/types'

/** Only audio files go away. No meeting rows, text, people or folder links change. */
export async function deleteRecording(id: string, p: {
  store: Pick<Store, 'meeting' | 'segments' | 'notes'>
  dirOf: (id: string) => string
  busy: (id: string) => boolean
  settle: (id: string) => Promise<void>
  removed: (id: string) => void
  /** Supplied only for automatic deletion, checked again after the recorder settles. */
  keep?: (endedAt: number | null) => boolean
}): Promise<DeleteRecordingResult> {
  if (!isId(id)) return 'missing'
  const blocked = (): DeleteRecordingResult | undefined => {
    const m = p.store.meeting(id)
    if (!m) return 'missing'
    if (m.state === 'recording' || p.busy(id)) return 'recording'
    if (p.keep && (p.keep(m.endedAt) || !p.store.notes(id).enhanced?.trim())) return 'kept'
    if (m.transcriptionPending || !p.store.segments(id).some(s => s.text.trim())) return 'not-transcribed'
  }
  try {
    const before = blocked()
    if (before) return before
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([p.settle(id), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('recording is still being written')), 30_000)
      })])
    } finally { clearTimeout(timer) }
    const after = blocked()
    if (after) return after
    const dir = p.dirOf(id)
    let files: string[]
    try { files = readdirSync(dir) } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      files = []
    }
    // A failed join may still contain words missing from the saved transcript.
    if (files.some(f => /^part\.\d+\.json$|^(me|them)\.\d+\.(m4a|ogg|wav)$/.test(f))) return 'failed'
    // Native joins retain exact audio inputs here, sometimes as hard links.
    rmSync(join(dir, 'original'), { recursive: true, force: true })
    // Unlink synchronously so a resumed recording cannot start between the guard and deletion.
    for (const f of files) if (/^(me|them)(\.joined)?\.(m4a|ogg|wav|f32)(\.joined|\.tmp)?$/.test(f)) unlinkSync(join(dir, f))
    try { p.removed(id) } catch (e) { console.warn('recording deleted; window refresh failed', id, e) }
    return 'deleted'
  } catch (e) {
    console.error('deleting the recording failed', id, e)
    return 'failed'
  }
}
