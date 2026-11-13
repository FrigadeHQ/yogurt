import { useEffect, useState } from 'react'
import { Popover } from '@base-ui/react/popover'
import { DirectionProvider } from '@base-ui/react/direction-provider'
import type { SetupState } from '../../../shared/types'
import { dirOf, language, t } from '../../../shared/i18n'
import { notesDownloadText, notesDownloadVisible, notesPercent, notesUpgradeActive } from '../notesSetup'
import { toasts } from './TrashToast'

/** One download status in the shared title bar, across workspace pages. */
export function NotesSetup({ go }: { go: (route: string) => void }) {
  const [setup, setSetup] = useState<SetupState>()
  const [open, setOpen] = useState(false)
  const [pointer, setPointer] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [retryFailed, setRetryFailed] = useState(false)
  const [skipFailed, setSkipFailed] = useState(false)
  useEffect(() => {
    let current: SetupState | undefined, active = true
    const update = (state: SetupState) => {
      current = state; setSetup(state)
      if (!state.notesError && !state.notesUpgradeError) setRetryFailed(false)
      if (!notesDownloadVisible(state)) { setOpen(false); setSkipFailed(false) }
    }
    const off = window.yogurt.setup.onState(update)
    void window.yogurt.setup.state().then(state => { if (active && !current) update(state) })
    return () => { active = false; off() }
  }, [])
  const retry = async () => {
    setRetrying(true); setRetryFailed(false)
    try { await window.yogurt.setup.retry() } catch { setRetryFailed(true) }
    finally { setRetrying(false) }
  }
  const skip = async () => {
    setSkipFailed(false)
    try {
      await window.yogurt.setup.skipUpgrade()
      const id = toasts.add({
        title: t('AI upgrade skipped'), timeout: 8000,
        data: { testId: 'notes-skipped-toast' },
        actionProps: { children: t('Settings'), onClick: () => { toasts.close(id); go('/settings/notes-model') } },
      })
    } catch { setSkipFailed(true) }
  }
  if (!setup || !notesDownloadVisible(setup)) return null
  const upgrading = notesUpgradeActive(setup)
  const error = upgrading ? setup.notesUpgradeError : setup.notesError
  const failed = !!error
  const stopped = upgrading ? t('AI upgrade paused') : t('AI download stopped')
  const label = failed ? stopped : setup.notesUpgradePending && upgrading ? t('Upgrading AI') : upgrading
    ? t('Upgrading AI · {percent}', { percent: notesPercent(setup.notesUpgradeFraction ?? 0) })
    : t('Downloading AI · {percent}', { percent: notesPercent(setup.notesFraction ?? 0) })
  const text = notesDownloadText(setup)
  const fraction = upgrading ? setup.notesUpgradeFraction : setup.notesFraction
  const percent = fraction !== undefined && Number.isFinite(fraction) ? Math.floor(Math.max(0, Math.min(1, fraction)) * 100) : undefined
  return <DirectionProvider direction={dirOf(language())}><span className="notes-download-status">
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger data-testid="notes-setup-open" aria-label={label} title={label} onClick={e => setPointer(e.detail > 0)}
        className="bar-btn notes-download-trigger no-drag">
        <span aria-hidden="true" data-failed={failed} data-upgrade={upgrading} className="notes-download-dot" />
        <span className="truncate">{label}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={8} collisionPadding={12} positionMethod="fixed" className="notes-download-positioner">
          <Popover.Popup data-testid="notes-setup" data-failed={failed} data-pointer={pointer} data-anchor="end" aria-label={failed ? stopped : upgrading ? t('Upgrading AI') : t('Downloading AI')} className="menu-entry notes-download-menu">
            <div className="notes-download-readout">
              <strong role={failed ? 'status' : undefined}>{failed ? upgrading ? t('Upgrade paused') : t('Download stopped') : text.progress || (upgrading ? t('Upgrading AI') : t('Downloading AI'))}</strong>
              <span>{failed ? text.progress : upgrading ? percent !== undefined && notesPercent(fraction!) : text.eta}</span>
            </div>
            <div className="notes-download-progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
              <span style={{ width: `${percent ?? 0}%` }} />
            </div>
            <div className="notes-download-footer">
              <p className="notes-download-support">{failed
                ? error
                : upgrading ? t("Once this model is ready, we'll remove the old one.") : t('You can record meetings. AI summaries and Ask work when this finishes.')}</p>
              {(failed || upgrading) && <div className="notes-download-actions">
                {failed && <button data-testid="notes-setup-retry" className="notes-download-retry" disabled={retrying} onClick={() => void retry()}>{retrying ? t('Retrying…') : t('Try again')}</button>}
                {upgrading && <button data-testid="notes-setup-skip" className="notes-download-skip" disabled={setup.notesUpgradeChanging} onClick={() => void skip()}>{t('Skip for now')}</button>}
              </div>}
            </div>
            {retryFailed && <p role="alert">{t("Couldn't restart the download. Try again.")}</p>}
            {skipFailed && <p role="alert">{t("Couldn't change the notes model. Try again.")}</p>}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  </span></DirectionProvider>
}
