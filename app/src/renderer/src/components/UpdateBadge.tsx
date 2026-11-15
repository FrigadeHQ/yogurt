import { useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { t } from '../../../shared/i18n'
import type { UpdateStatus } from '../../../shared/types'
import { toasts } from './TrashToast'

/** A downloaded version, in the title bar: restart now, or once the recording is finished. */
export function UpdateBadge() {
  const [status, setStatus] = useState<Pick<UpdateStatus, 'state' | 'recording'>>()
  const blockedId = useRef<string>(undefined)
  useEffect(() => {
    let active = true
    const apply = (s: UpdateStatus) => setStatus({ state: s.state, recording: s.recording })
    const off = window.yogurt.updates.onStatus(apply)
    void window.yogurt.updates.status().then(s => { if (active) apply(s) })
    return () => { active = false; off() }
  }, [])
  if (status?.state !== 'ready') return null
  const recording = status.recording
  const label = recording ? t('Update is ready to apply as soon the recording is finished.') : t('Restart Yogurt to install the new version')
  const blocked = () => {
    if (blockedId.current) toasts.close(blockedId.current)
    blockedId.current = toasts.add({
      id: 'update-badge-blocked', title: t('Update is ready to apply as soon the recording is finished.'), timeout: 8000,
      data: { testId: 'update-badge-blocked' },
    })
  }
  const restart = async () => {
    if (recording) { blocked(); return }
    const ok = await window.yogurt.updates.restart().catch(() => false)
    // only main's recording guard can refuse: a recording began after this render
    if (!ok) blocked()
  }
  return <button className="workspace-icon update-badge no-drag" data-testid="update-badge" data-recording={recording || undefined}
    aria-label={label} title={label} onClick={() => void restart()}>
    <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />
  </button>
}
