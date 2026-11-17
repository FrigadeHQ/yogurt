import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Toast } from '@animate-ui/react/primitives/base-ui/toast'
import { X } from 'lucide-react'
import { t } from '../../../shared/i18n'
import type { SetupState } from '../../../shared/types'
import { motion, useReducedMotion } from '../motion'
import { notesReadyNotice } from '../notesSetup'
import { changeMeetingRows } from '../meetingRowMotion'
import { trashMeetings, restoreMeetings } from '../trashMeetings'

let toastHost: HTMLDivElement | undefined
// Keep Undo reachable when Ask uses the native modal top layer on smaller windows.
export function setToastDialog(dialog: HTMLDialogElement | null) {
  if (toastHost) (dialog ?? document.body).append(toastHost)
}

type Shown = { ids: string[]; bulk?: boolean; error?: string; /** the note it was moved from: Undo opens it again */ from?: string }
let show: ((s: Shown) => void) | undefined
export const toasts = Toast.createToastManager<{ testId?: string; actionTestId?: string }>()

/** Confirm manual audio deletion without changing the retention preference. */
export async function recordingDeletedToast() {
  const prefs = await window.yogurt.settings.get().catch(() => undefined)
  const id = toasts.add({ title: t('Recording deleted'), timeout: 8000,
    data: { testId: 'recording-deleted-toast', actionTestId: 'recording-settings' },
    actionProps: prefs?.keepRecordings ? { children: t('Settings'), onClick: () => {
      window.yogurt.nav.go('/settings/recordings')
      toasts.close(id)
    } } : undefined,
  })
  return id
}

/**
 * Delete in a list or a note: the meeting goes to the Trash at once, no question asked, and a toast
 * says so with Undo. from: the route it was deleted on, when that was its own note (main has already gone home).
 */
export async function moveToTrash(id: string, from?: string): Promise<boolean> {
  return (await moveMeetingsToTrash([id], from, false)).includes(id)
}

export async function moveMeetingsToTrash(ids: string[], from?: string, bulk = true): Promise<string[]> {
  const result = await changeMeetingRows('trash', ids, () => trashMeetings(ids, id => window.yogurt.meetings.trash(id)), result => result.done)
  const error = result.error === 'recording' ? t('Stop the recording first, then try again.')
    : result.error === 'save-pending' ? t('Open this note and finish saving before deleting it.')
    : result.error ? t("Yogurt couldn't move this note to the Trash. Try again.") : undefined
  if (result.trashed.length || error) show?.({ ids: result.trashed, from, bulk, error })
  return result.done
}

/** "Moved to the Trash" with Undo, for a few seconds; one at a time, the newest wins */
export function TrashToast({ go }: { go: (route: string) => void }) {
  const [host] = useState(() => document.createElement('div'))
  const notice = useRef<ReturnType<typeof notesReadyNotice>>(undefined)
  notice.current ??= notesReadyNotice()
  useEffect(() => {
    let current: SetupState | undefined, active = true
    const update = (state: SetupState) => {
      current = state
      if (notice.current!(state, document.visibilityState === 'visible', Date.now())) {
        toasts.add({ title: t("Summaries and Ask are ready."), data: { testId: 'notes-ready-toast' } })
      }
    }
    const off = window.yogurt.setup.onState(update)
    void window.yogurt.setup.state().then(state => { if (active && !current) update(state) })
    const visibility = () => { if (current) update(current) }
    document.addEventListener('visibilitychange', visibility)
    return () => { active = false; off(); document.removeEventListener('visibilitychange', visibility) }
  }, [])
  useLayoutEffect(() => {
    toastHost = host
    document.body.append(host)
    return () => { toastHost = undefined; host.remove() }
  }, [host])
  useEffect(() => {
    const remind = () => {
      void window.yogurt.meetings.takeRecordingReminder().then(id => {
        if (id) toasts.add({ id: `recording-reminder-${id}`, title: t("Let everyone know you're recording."), timeout: 4000, data: { testId: 'recording-reminder' } })
      })
    }
    const off = window.yogurt.meetings.onChange(remind)
    remind()
    return off
  }, [])
  const previous = useRef<string>(undefined)
  useEffect(() => {
    show = (s) => {
      if (previous.current) toasts.close(previous.current)
      let restoring = false, remaining = s.ids
      const moved = s.bulk ? t('{count} meetings moved to Trash', { count: s.ids.length }) : t('Moved to the Trash')
      const id = toasts.add({
        title: s.error ? (s.ids.length ? `${moved} · ${s.error}` : s.error) : moved, timeout: s.error ? 0 : 8000,
        data: { testId: 'trash-toast', actionTestId: 'trash-undo' },
        actionProps: !s.ids.length ? undefined : { children: t('Undo'), onClick: async () => {
          if (restoring) return
          restoring = true
          try {
            remaining = await changeMeetingRows('restore', remaining, () => restoreMeetings(remaining, id => window.yogurt.meetings.restore(id)), failed => remaining.filter(id => !failed.includes(id)))
            if (remaining.length) { toasts.update(id, { title: t("Yogurt couldn't make that change. Try again."), timeout: 0 }); return }
            toasts.close(id)
            if (s.from) go(s.from)
          } catch { toasts.update(id, { title: t("Yogurt couldn't make that change. Try again."), timeout: 0 }) }
          finally { restoring = false }
        } },
      })
      previous.current = id
    }
    return () => { show = undefined }
  }, [go])
  return <Toast.Provider toastManager={toasts} timeout={6000} limit={3} progressBar={false}>
    <Toast.Portal container={host}><Toast.Viewport className="app-toast-viewport"><ToastList /></Toast.Viewport></Toast.Portal>
  </Toast.Provider>
}

function ToastList() {
  const reduced = useReducedMotion()
  const { toasts: shown } = Toast.useToastManager<{ testId?: string; actionTestId?: string }>()
  return shown.map(item => <Toast.Root key={item.id} toast={item} className="app-toast" transition={{ duration: (reduced ? motion.micro : motion.surface) / 1000, ease: motion.softCurve }} exitTransition={{ duration: (reduced ? motion.micro : motion.base) / 1000, ease: motion.out }} swipeDirection={['down', 'right']}
    data-kind={item.data?.testId} data-testid={item.transitionStatus === 'ending' ? undefined : item.data?.testId ?? 'app-toast'}>
    <Toast.Content className="app-toast-content" transition={{ duration: motion.micro / 1000, ease: motion.out }}>
      <Toast.Title className="app-toast-title" />
      {item.actionProps && <Toast.Action className="workspace-button" data-testid={item.data?.actionTestId} />}
      <Toast.Close className="ghost-btn workspace-icon" aria-label={t('Close')}><X size={14} aria-hidden="true" /></Toast.Close>
    </Toast.Content>
  </Toast.Root>)
}
