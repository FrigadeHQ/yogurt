import { useEffect, useState } from 'react'
import type { Folder } from '../../shared/types'

/** what a dragged meeting row carries: its id, under a type only Yogurt's own rows use */
export const MEETING_DRAG = 'application/x-yogurt-meeting'

/**
 * Folders as main has them, read again on every change to a folder and every change to meetings (a meeting deleted or
 * imported changes the counts). meetingId: only the folders that meeting is in.
 */
export function useFolders(meetingId?: string | null): Folder[] | undefined {
  return useFolderRead(meetingId).folders
}

export function useFolderRead(meetingId?: string | null) {
  const [folders, setFolders] = useState<Folder[]>()
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (meetingId === null) return
    let seq = 0
    const load = () => {
      const mine = ++seq
      void (meetingId ? window.yogurt.folders.of(meetingId) : window.yogurt.folders.list()).then((list) => { if (mine === seq) { setFolders(list); setFailed(false) } }, () => { if (mine === seq) setFailed(true) })
    }
    load()
    const offFolders = window.yogurt.folders.onChange(load)
    const offMeetings = window.yogurt.meetings.onChange(load)
    return () => { seq++; offFolders(); offMeetings() }
  }, [meetingId, attempt])
  return { folders, failed, retry: () => setAttempt(n => n + 1) }
}

/** Folder writes are idempotent; wait for every result before reporting a failure. */
export async function addMeetingsToFolder(folder: string, ids: string[]) {
  return setMeetingsInFolder(folder, ids, true)
}

export async function setMeetingsInFolder(folder: string, ids: string[], on: boolean) {
  const results = await Promise.allSettled([...new Set(ids)].map(async id => {
    await (on ? window.yogurt.folders.add(folder, id) : window.yogurt.folders.remove(folder, id))
    if ((await window.yogurt.folders.of(id)).some(item => item.id === folder) !== on) throw new Error('Folder membership not updated')
  }))
  if (results.some(result => result.status === 'rejected')) throw new Error(on ? 'Folder not added' : 'Folder not removed')
}
