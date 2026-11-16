import { useEffect, useState } from 'react'
import { Popover } from '@base-ui/react/popover'
import { DirectionProvider } from '@base-ui/react/direction-provider'
import type { UpdateStatus } from '../../../shared/types'
import { dirOf, language, t } from '../../../shared/i18n'

export function UpdateReady({ recording }: { recording: boolean }) {
  const [status, setStatus] = useState<UpdateStatus>()
  const [open, setOpen] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let active = true, updated = false
    const update = (next: UpdateStatus) => {
      if (!active) return
      updated = true; setStatus(next)
      if (next.state !== 'ready') { setOpen(false); setFailed(false) }
    }
    const off = window.yogurt.updates.onStatus(update)
    void window.yogurt.updates.status().then(next => { if (!updated) update(next) }).catch(() => {})
    return () => { active = false; off() }
  }, [])
  const restart = async () => {
    if (recording || restarting || status?.state !== 'ready') return
    setRestarting(true); setFailed(false)
    try {
      if (await window.yogurt.updates.restart()) setOpen(false)
      else setFailed(true)
    } catch { setFailed(true) }
    finally { setRestarting(false) }
  }
  if (status?.state !== 'ready') return null
  return <DirectionProvider direction={dirOf(language())}><span className="notes-download-status update-ready-status">
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger data-testid="update-ready" className="bar-btn notes-download-trigger no-drag" title={t('Update ready')}>
        <span className="truncate">{t('Update ready')}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={8} collisionPadding={12} positionMethod="fixed" className="notes-download-positioner">
          <Popover.Popup data-testid="update-popover" data-anchor="end" data-pointer="true" className="menu-entry notes-download-menu update-ready-menu">
            <Popover.Title>{t('Yogurt {version}', { version: status.next ?? '' })}</Popover.Title>
            <Popover.Description className="update-ready-description">{recording ? t('You can restart after recording') : t('Installs when you restart Yogurt')}</Popover.Description>
            <div className="update-ready-actions">
              <Popover.Close data-testid="update-later" className="update-ready-later">{t('Later')}</Popover.Close>
              <button data-testid="update-restart" className="workspace-button primary" disabled={recording || restarting} onClick={() => void restart()}>{t('Restart')}</button>
            </div>
            {failed && !recording && <p role="alert">{t("Yogurt couldn't restart. Try again.")}</p>}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  </span></DirectionProvider>
}
