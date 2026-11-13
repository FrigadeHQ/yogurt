import { afterEach, describe, expect, it } from 'vitest'
import { notesDownloadText, notesDownloadVisible, notesPercent, notesReadyNotice, notesUpgradeActive } from '../src/renderer/src/notesSetup'
import { setLanguage } from '../src/shared/i18n'
import type { SetupState } from '../src/shared/types'

const downloading: SetupState = { phase: 'ready', fraction: 1, notesDownloading: true, notesFraction: 0.42 }
const ready: SetupState = { phase: 'ready', fraction: 1 }
afterEach(() => setLanguage('en'))

describe('first notes model progress', () => {
  it('clamps and floors progress without rounding up before the download finishes', () => {
    expect([-0.1, 0, 0.429, 0.999, 1, 2].map(notesPercent)).toEqual(['0%', '0%', '42%', '99%', '100%', '100%'])
  })
  it('announces once after a noticeable download, never again on ready updates', () => {
    const notice = notesReadyNotice()
    expect(notice(downloading, true, 0)).toBe(false)
    expect(notice(downloading, true, 1100)).toBe(false)
    expect(notice(ready, true, 1200)).toBe(true)
    expect(notice(ready, true, 1300)).toBe(false)
    expect(notice(downloading, true, 1400)).toBe(false)
    expect(notice(ready, true, 3000)).toBe(false)
  })
  it('skips cached launches, brief downloads, and downloads only seen while hidden', () => {
    expect(notesReadyNotice()(ready, true, 5000)).toBe(false)
    const brief = notesReadyNotice()
    brief(downloading, true, 0)
    expect(brief(ready, true, 999)).toBe(false)
    const hidden = notesReadyNotice()
    hidden(downloading, false, 0)
    expect(hidden(ready, false, 5000)).toBe(false)
    expect(hidden(ready, true, 6000)).toBe(false)
  })
  it('does not mistake a failed download for readiness; a retry can finish it', () => {
    const notice = notesReadyNotice()
    notice(downloading, true, 0)
    expect(notice({ ...ready, notesError: 'Offline' }, true, 2000)).toBe(false)
    expect(notice(downloading, true, 3000)).toBe(false)
    expect(notice(ready, true, 4000)).toBe(true)
  })
  it('does not count hidden time toward a briefly visible download', () => {
    const notice = notesReadyNotice()
    notice(downloading, true, 0)
    notice(downloading, false, 100)
    expect(notice(ready, false, 5000)).toBe(false)
  })
})


describe('title bar download visibility', () => {
  it.each([
    undefined,
    ready,
    { phase: 'checking', fraction: 0 },
    { phase: 'downloading', fraction: .5 },
    { ...ready, notesFraction: 1, notesTotalBytes: 5e9, notesUpgradeFraction: 1, notesUpgradeTotalBytes: 14e9 },
    { ...ready, notesDownloading: false, notesUpgradeDownloading: false },
    { ...ready, notesUpgradeInstalled: true, notesUpgradeChanging: true, notesRestoreFraction: .42, notesRestoreTotalBytes: 5.2e9, notesRestoreEtaSec: 240 },
  ] satisfies (SetupState | undefined)[])('hides when no notes model download or failure is active: %j', setup => {
    expect(notesDownloadVisible(setup)).toBe(false)
  })
  it.each([
    downloading,
    { ...ready, notesUpgradePending: true },
    { ...downloading, notesFraction: 1 },
    { ...ready, notesError: 'Offline' },
    { ...ready, notesUpgradeDownloading: true, notesUpgradeFraction: .27 },
    { ...ready, notesUpgradeDownloading: true, notesUpgradeFraction: 1 },
    { ...ready, notesUpgradeError: 'Offline' },
    { ...downloading, notesUpgradeDownloading: true },
    { ...ready, notesError: 'Offline', notesUpgradeError: 'Offline' },
  ])('shows downloading, verifying and failed states for either stage: %j', setup => {
    expect(notesDownloadVisible(setup)).toBe(true)
  })
})

describe('download details', () => {
  const progress = { ...downloading, notesTotalBytes: 5e9, notesEtaSec: 240 }
  const upgrade = { ...ready, notesUpgradeDownloading: true, notesUpgradeFraction: .42, notesUpgradeTotalBytes: 14e9, notesUpgradeEtaSec: 240 }
  const restore = { ...ready, notesUpgradeInstalled: true, notesUpgradeChanging: true, notesRestoreFraction: .02, notesRestoreTotalBytes: 5.2e9, notesRestoreEtaSec: 240 }
  it('formats the smaller model restore with the same bytes and ETA as a download', () => {
    expect(notesDownloadText(restore)).toEqual({ progress: '0.1 of 5.2 GB', eta: 'about 4 min left', detail: '0.1 of 5.2 GB · about 4 min left' })
    expect(notesDownloadText(restore)).toEqual(notesDownloadText({ ...downloading, notesFraction: .02, notesTotalBytes: 5.2e9, notesEtaSec: 240 }))
    expect(notesDownloadText({ ...restore, notesRestoreFraction: 0 }).detail).toBe('0.0 of 5.2 GB · about 4 min left')
    expect(notesDownloadText({ ...restore, notesRestoreFraction: 1 }).detail).toBe('5.2 of 5.2 GB')
  })
  it.each([undefined, 0, -1, NaN, Infinity])('omits missing or invalid restore ETA (%s)', seconds => {
    expect(notesDownloadText({ ...restore, notesRestoreEtaSec: seconds }).detail).toBe('0.1 of 5.2 GB')
  })
  it('localizes restore amounts and ETA', () => {
    setLanguage('fr')
    expect(notesDownloadText(restore).detail).toBe('0,1 sur 5,2 Go · reste environ 4 min')
  })
  it('shows the upgrade size and ETA only after the first model is ready', () => {
    expect(notesUpgradeActive(upgrade)).toBe(true)
    expect(notesDownloadText(upgrade)).toEqual({ progress: '5.9 of 14.0 GB', eta: 'about 4 min left', detail: '5.9 of 14.0 GB · about 4 min left' })
    const both = { ...upgrade, ...progress }
    expect(notesUpgradeActive(both)).toBe(false)
    expect(notesDownloadText(both)).toEqual(notesDownloadText(progress))
    expect(notesUpgradeActive({ ...upgrade, notesError: 'Offline' })).toBe(false)
    expect(notesUpgradeActive({ ...ready, notesUpgradeError: 'Offline' })).toBe(true)
    expect(notesUpgradeActive(ready)).toBe(false)
  })
  it('does not invent upgrade estimates, or keep an ETA during verification', () => {
    expect(notesDownloadText({ ...upgrade, notesUpgradeEtaSec: undefined }).detail).toBe('5.9 of 14.0 GB')
    expect(notesDownloadText({ ...upgrade, notesUpgradeFraction: 1 }).detail).toBe('14.0 of 14.0 GB')
    expect(notesDownloadText({ ...upgrade, notesUpgradeTotalBytes: undefined })).toEqual({ progress: '', eta: '', detail: 'Upgrading AI' })
  })
  it('localizes upgrade details', () => {
    setLanguage('fr')
    expect(notesDownloadText(upgrade)).toEqual({ progress: '5,9 sur 14,0 Go', eta: 'reste environ 4 min', detail: '5,9 sur 14,0 Go · reste environ 4 min' })
  })
  it('separates model size and measured ETA for the popover, preserving Settings details', () => {
    expect(notesDownloadText(progress)).toEqual({
      progress: '2.1 of 5.0 GB', eta: 'about 4 min left',
      detail: '2.1 of 5.0 GB · about 4 min left',
    })
  })
  it.each([undefined, 0, -1, NaN, Infinity])('does not invent a missing or invalid ETA (%s)', seconds => {
    expect(notesDownloadText({ ...progress, notesEtaSec: seconds }).detail).toBe('2.1 of 5.0 GB')
  })
  it('shows at least a minute, then no ETA while the finished file is being verified', () => {
    expect(notesDownloadText({ ...progress, notesEtaSec: 10 }).detail).toBe('2.1 of 5.0 GB · about 1 min left')
    expect(notesDownloadText({ ...progress, notesFraction: 1 }).detail).toBe('5.0 of 5.0 GB')
  })
  it.each([undefined, 0, -1, NaN, Infinity])('never fabricates a model size (%s)', bytes => {
    expect(notesDownloadText({ ...progress, notesTotalBytes: bytes })).toEqual({ progress: '', eta: '', detail: 'Downloading AI' })
  })
  it('bounds downloaded GB and falls back when the fraction is missing', () => {
    expect(notesDownloadText({ ...progress, notesFraction: 2 }).detail).toBe('5.0 of 5.0 GB')
    expect(notesDownloadText({ ...progress, notesFraction: -1, notesEtaSec: undefined }).detail).toBe('0.0 of 5.0 GB')
    expect(notesDownloadText({ ...progress, notesFraction: undefined }).detail).toBe('Downloading AI')
  })
  it('retains stopped amounts without showing a stale ETA', () => {
    expect(notesDownloadText({ ...progress, notesDownloading: undefined, notesError: 'Offline' })).toEqual({ progress: '2.1 of 5.0 GB', eta: '', detail: '2.1 of 5.0 GB' })
    expect(notesDownloadText({ ...upgrade, notesUpgradeDownloading: undefined, notesUpgradeError: 'Offline' })).toEqual({ progress: '5.9 of 14.0 GB', eta: '', detail: '5.9 of 14.0 GB' })
  })
  it.each([undefined, NaN, Infinity])('does not fabricate progress from an invalid fraction (%s)', fraction => {
    expect(notesDownloadText({ ...progress, notesFraction: fraction })).toEqual({ progress: '', eta: '', detail: 'Downloading AI' })
  })
  it('localizes the amounts and the whole detail line', () => {
    setLanguage('fr')
    expect(notesDownloadText(progress)).toEqual({ progress: '2,1 sur 5,0 Go', eta: 'reste environ 4 min', detail: '2,1 sur 5,0 Go · reste environ 4 min' })
  })
})
