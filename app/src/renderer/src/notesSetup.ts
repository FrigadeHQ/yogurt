import type { SetupState } from '../../shared/types'
import { language, t } from '../../shared/i18n'

export const notesPercent = (fraction: number) => new Intl.NumberFormat(language(), { style: 'percent', maximumFractionDigits: 0 })
  .format(Math.floor(Math.max(0, Math.min(1, fraction)) * 100) / 100)

export const notesUpgradeActive = (setup: SetupState) => !setup.notesDownloading && !setup.notesError && !!(setup.notesUpgradePending || setup.notesUpgradeDownloading || setup.notesUpgradeError)

export const notesUpgradeSize = (bytes: number) => new Intl.NumberFormat(language(), { maximumFractionDigits: 1 }).format(bytes / 1e9)

export const notesDownloadVisible = (setup?: SetupState) => !!setup && !!(setup.notesDownloading || setup.notesError || notesUpgradeActive(setup))

/** Missing estimates stay missing, including while a completed download is being verified. */
export function notesDownloadText(setup: SetupState) {
  const restoring = setup.notesRestoreFraction !== undefined
  const upgrading = notesUpgradeActive(setup)
  const bytes = restoring ? setup.notesRestoreTotalBytes : upgrading ? setup.notesUpgradeTotalBytes : setup.notesTotalBytes
  const fraction = restoring ? setup.notesRestoreFraction : upgrading ? setup.notesUpgradeFraction : setup.notesFraction
  const seconds = restoring ? setup.notesRestoreEtaSec : upgrading ? setup.notesUpgradeEtaSec : setup.notesEtaSec
  const fallback = upgrading ? t('Upgrading AI') : t('Downloading AI')
  if (!bytes || !Number.isFinite(bytes) || bytes < 0 || fraction === undefined || !Number.isFinite(fraction)) return { progress: '', eta: '', detail: fallback }
  const gb = new Intl.NumberFormat(language(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  const progress = t('{done} of {total} GB', {
    done: gb.format(bytes * Math.max(0, Math.min(1, fraction)) / 1e9),
    total: gb.format(bytes / 1e9),
  })
  const minutes = !setup.notesError && !setup.notesUpgradeError && fraction < 1 && seconds !== undefined && Number.isFinite(seconds) && seconds > 0
    ? new Intl.NumberFormat(language()).format(Math.max(1, Math.round(seconds / 60))) : undefined
  return {
    progress,
    eta: minutes ? t('about {minutes} min left', { minutes }) : '',
    detail: minutes ? t('{progress} · about {minutes} min left', { progress, minutes }) : progress,
  }
}

/** Skip cached installs and flashes; announce only a download visible for at least a second. */
export function notesReadyNotice() {
  let since: number | undefined, noticed = false, announced = false
  return (setup: SetupState, visible: boolean, now: number): boolean => {
    if (announced) return false
    if (since !== undefined && now - since >= 1000) noticed = true
    const waiting = setup.notesDownloading || !!setup.notesError
    if (setup.phase === 'ready' && waiting && visible) since ??= now
    else since = undefined
    if (setup.phase !== 'ready' || waiting || !noticed) return false
    announced = true
    return true
  }
}
