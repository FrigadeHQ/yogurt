import { createElement, useEffect, useState } from 'react'
import { Smartphone } from './Icons'
import type { CompanionStatus } from '../../../shared/companion'
import { language, t } from '../../../shared/i18n'

/** m:ss left on the code */
const countdown = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** "Last seen 2h ago" in the interface language, from the language's own relative-time words */
function lastSeen(at: number, now: number) {
  const s = Math.max(0, (now - at) / 1000)
  if (s < 60) return t('Last seen just now')
  const rtf = new Intl.RelativeTimeFormat(language(), { style: 'narrow' })
  const when = s < 3600 ? rtf.format(-Math.floor(s / 60), 'minute') : s < 86400 ? rtf.format(-Math.floor(s / 3600), 'hour') : rtf.format(-Math.floor(s / 86400), 'day')
  return t('Last seen {when}', { when })
}

/** Settings → iPhone */
export function PhoneSettings() {
  return globalThis.window?.yogurt?.phone ? createElement(PhoneSection) : null
}

/** pair the iPhone app with a code, see the paired phone, unpair it */
function PhoneSection() {
  const [status, setStatus] = useState<CompanionStatus | null>()
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    // a push that lands before the first answer is newer than it
    let live = true, pushed = false
    void window.yogurt.companion.status().then((s) => { if (live && !pushed) setStatus(s) }, () => { if (live && !pushed) setStatus(null) })
    const off = window.yogurt.companion.onStatus((s) => { pushed = true; setStatus(s) })
    return () => { live = false; off() }
  }, [])
  // the countdown moves every second, "last seen" by the minute
  const tick = status?.pairing ? 1000 : status?.paired ? 30_000 : 0
  useEffect(() => {
    if (!tick) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), tick)
    return () => clearInterval(timer)
  }, [tick])
  // fake mode, or it didn't start: nothing here to pair
  if (status === null) return null

  const act = async (run: () => Promise<CompanionStatus | null>) => {
    setBusy(true)
    try { const s = await run(); if (s) setStatus(s) } catch { /* the next status push says what is true */ } finally { setBusy(false) }
  }
  const start = () => act(async () => {
    setFailed(false); setConfirming(false)
    const r = await window.yogurt.companion.startPairing().catch(() => ({ ok: false, status: null }))
    if (!r.ok) setFailed(true)
    return r.status
  })
  const cancel = () => act(() => window.yogurt.companion.cancelPairing())
  const unpair = () => act(async () => { setConfirming(false); return window.yogurt.companion.unpair() })

  const pairing = status?.pairing
  const paired = status?.paired
  // the phone can't find this computer: say what to allow, in this computer's words
  const network = status?.error !== 'network' ? null
    : <p role="alert" data-testid="phone-network" className="settings-description text-danger">{globalThis.window?.yogurt?.platform === 'darwin'
      ? t("Your iPhone can't see this computer. Allow Local Network for Yogurt in System Settings → Privacy & Security.")
      : t("Your iPhone can't see this computer. Allow Yogurt through your firewall on private networks.")}</p>
  const notice = status?.error === 'keychain' ? t("Yogurt couldn't reach this computer's secure storage, so it can't pair right now.")
    : failed || status?.error === 'listen' ? t("Yogurt couldn't start pairing. Try again.")
    : status?.pairingClosed === 'tooMany' ? t('Too many wrong codes. Start pairing again.')
    : status?.pairingClosed === 'expired' ? t('The code ran out. Start pairing again.')
    : ''
  const pairButton = <button type="button" data-testid="phone-pair" disabled={busy || !status} onClick={() => void start()} className="workspace-button settings-action">{t('Pair a phone')}</button>

  return <section data-testid="phone-settings" aria-labelledby="phone-settings-heading">
    <h2 id="phone-settings-heading" className="settings-section-heading">iPhone</h2>
    <div className="settings-group">
      {pairing ? <div data-testid="phone-pairing" className="settings-row">
        <div className="settings-row-copy">
          <p className="settings-label">{t('Open Yogurt on your iPhone and type this code')}</p>
          <p data-testid="phone-code" dir="ltr" aria-label={pairing.code.split('').join(' ')} className="my-2 flex gap-3 font-mono text-[28px] leading-[36px] font-semibold tracking-[0.12em] tabular-nums">
            <span>{pairing.code.slice(0, 3)}</span><span>{pairing.code.slice(3)}</span>
          </p>
          <p data-testid="phone-countdown" aria-live="off" className="settings-description">{t('Code works for {time}', { time: countdown(pairing.expiresAt - now) })}</p>
          {network}
        </div>
        <button type="button" data-testid="phone-cancel" disabled={busy} onClick={() => void cancel()} className="workspace-button settings-action">{t('Cancel')}</button>
      </div>
      : paired && status?.error !== 'keychain' ? <div data-testid="phone-paired" className="settings-row">
        <Smartphone size={16} aria-hidden="true" className="shrink-0 text-muted" />
        <div className="settings-row-copy" aria-live="polite">
          <p className="settings-label truncate">{paired.name}</p>
          {confirming
            ? <p className="settings-description">{t('Unpair your iPhone? It keeps its copy until you pair again.')}</p>
            : <p className="settings-description flex items-center gap-1.5">
              {status.connected && <span data-testid="phone-live-dot" aria-hidden="true" className="phone-live-dot inline-block size-2 shrink-0 rounded-full" style={{ backgroundColor: 'var(--status-live)' }} />}
              {status.connected ? t('Connected') : paired.lastSeen == null ? t('Not connected yet') : lastSeen(paired.lastSeen, now)}
            </p>}
          {status.error === 'listen' && <p role="alert" data-testid="phone-notice" className="settings-description text-danger">{t("Your iPhone can't reach this computer right now. Try restarting Yogurt.")}</p>}
          {network}
        </div>
        {confirming ? <div className="flex shrink-0 gap-2">
          <button type="button" data-testid="phone-unpair-cancel" disabled={busy} onClick={() => setConfirming(false)} className="workspace-button">{t('Cancel')}</button>
          <button type="button" data-testid="phone-unpair-confirm" disabled={busy} onClick={() => void unpair()} className="workspace-button text-danger">{t('Unpair')}</button>
        </div>
          : <button type="button" data-testid="phone-unpair" disabled={busy} onClick={() => setConfirming(true)} className="workspace-button settings-action">{t('Unpair')}</button>}
      </div>
      : <div data-testid="phone-unpaired" className="settings-row">
        <Smartphone size={16} aria-hidden="true" className="shrink-0 text-muted" />
        <div className="settings-row-copy">
          <p className="settings-label">{t('Already have Yogurt on your iPhone?')}</p>
          {notice && <p role="alert" data-testid="phone-notice" className="settings-description text-danger">{notice}</p>}
        </div>
        {status?.error !== 'keychain' && pairButton}
      </div>}
      <p className="settings-row settings-description">{t('Your iPhone talks to this computer only on the same Wi-Fi. Nothing goes through the internet.')}</p>
    </div>
  </section>
}
