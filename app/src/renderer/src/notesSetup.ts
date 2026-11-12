import type { BetterNotesState, SetupState } from '../../shared/types'
import { language, t } from '../../shared/i18n'

export const notesPercent = (fraction: number) => new Intl.NumberFormat(language(), { style: 'percent', maximumFractionDigits: 0 })
  .format(Math.floor(Math.max(0, Math.min(1, fraction)) * 100) / 100)

/** Missing estimates stay missing, including while a completed download is being verified. */
export function notesDownloadText(setup: SetupState) {
  const fallback = t("Downloading Yogurt's AI")
  if (!setup.notesTotalBytes || !Number.isFinite(setup.notesTotalBytes) || setup.notesTotalBytes < 0 || setup.notesFraction === undefined || !Number.isFinite(setup.notesFraction)) return { title: fallback, detail: fallback }
  const gb = new Intl.NumberFormat(language(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  const progress = t('{done} of {total} GB', {
    done: gb.format(setup.notesTotalBytes * Math.max(0, Math.min(1, setup.notesFraction)) / 1e9),
    total: gb.format(setup.notesTotalBytes / 1e9),
  })
  const seconds = setup.notesEtaSec
  const detail = setup.notesFraction < 1 && seconds !== undefined && Number.isFinite(seconds) && seconds > 0
    ? t('{progress} · about {minutes} min left', { progress, minutes: new Intl.NumberFormat(language()).format(Math.max(1, Math.round(seconds / 60))) })
    : progress
  return { title: t("Downloading Yogurt's AI: {progress}", { progress }), detail }
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

/** The bigger notes model's line in Settings: how far it is, that it's in use, or why not. failed has its own retry. */
export function betterNotesText(b: BetterNotesState): string {
  if (b.status === 'waiting') return t('Starts after the first notes model.')
  if (b.status === 'ready') return t('In use for notes')
  if (b.status === 'off') return t('Notes use the smaller model.')
  if (b.status === 'failed') return t('Download interrupted. Check your connection and try again.')
  const gb = new Intl.NumberFormat(language(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  const fraction = Math.max(0, Math.min(1, b.fraction ?? 0))
  const progress = t('{done} of {total} GB', { done: gb.format(b.totalBytes * fraction / 1e9), total: gb.format(b.totalBytes / 1e9) })
  const seconds = b.etaSec
  const withEta = fraction < 1 && seconds !== undefined && Number.isFinite(seconds) && seconds > 0
    ? t('{progress} · about {minutes} min left', { progress, minutes: new Intl.NumberFormat(language()).format(Math.max(1, Math.round(seconds / 60))) })
    : progress
  return t('Downloading · {progress}', { progress: withEta })
}
