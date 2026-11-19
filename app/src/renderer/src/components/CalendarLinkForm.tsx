import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ExternalLink, LoaderCircle } from 'lucide-react'
import { calendarAddress } from '../../../shared/calendarLink'
import { t } from '../../../shared/i18n'

/**
 * Connecting a calendar on Windows and Linux: where to find the calendar's private address, and the box to paste it.
 * One form, used by Settings' calendars and by the first run's calendar screen, so the words and the steps are
 * written once. The address goes to the main process and is never shown again.
 */

type Provider = 'google' | 'outlook' | 'other'
const PROVIDERS: { id: Provider; name: string }[] = [
  { id: 'google', name: 'Google Calendar' },
  { id: 'outlook', name: 'Outlook' },
  { id: 'other', name: '' },
]
/** each calendar's own settings page, where its private address is */
const PAGE: Partial<Record<Provider, string>> = {
  google: 'https://calendar.google.com/calendar/r/settings',
  outlook: 'https://outlook.office.com/calendar/options/calendar/SharedCalendars',
}
const steps = (p: Provider): string[] => p === 'google'
  ? [t('Under "Settings for my calendars", choose your calendar, then "Integrate calendar".'), t('Copy "Secret address in iCal format" and paste it below.')]
  : p === 'outlook'
    ? [t('Under "Publish a calendar", choose your calendar and "Can view all details", then Publish.'), t('Copy the ICS link and paste it below.')]
    : [t('Copy the private iCal address from your calendar settings.')]

const ERRORS = {
  'bad-url': () => t('Enter an https:// or webcal:// calendar address.'),
  'unreachable': () => t('Yogurt couldn\'t reach that address. Check your connection and the address.'),
  'not-calendar': () => t('That address isn\'t a calendar. Copy the iCal address, not the page\'s address.'),
  'public-address': () => t('That\'s the public address, which only works if your calendar is public. Copy "Secret address in iCal format" instead.'),
}

/** Shared validation and copy; setup keeps its primary Connect and Not now actions. */
export function CalendarLinkForm({ onConnected, onCancel, onBusyChange, autoFocus, variant = 'settings', extra, only }: {
  onConnected(name: string): void; onCancel?(): void; onBusyChange?(busy: boolean): void
  autoFocus?: boolean; variant?: 'settings' | 'onboarding'; extra?: ReactNode
  /** A Mac adds its accounts in Calendar; only other links are pasted here. */
  only?: Provider
}) {
  const [provider, setProvider] = useState<Provider>(only ?? 'google')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<keyof typeof ERRORS | null>(null)
  const id = useId(), input = useRef<HTMLInputElement>(null)
  useEffect(() => { if (autoFocus) input.current?.focus({ preventScroll: true }) }, [autoFocus])
  const valid = !!calendarAddress(url)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    if (!valid) { if (url.trim()) setError('bad-url'); return }
    setBusy(true); onBusyChange?.(true); setError(null)
    try {
      const got = await window.yogurt.calendar.addLink(url)
      if (got.ok) { setUrl(''); onConnected(got.name) } else setError(got.error)
    } catch { setError('unreachable') } finally { setBusy(false); onBusyChange?.(false) }
  }
  const page = PAGE[provider]
  const connect = (className: string) => <button data-testid="calendar-link-connect" type="submit" disabled={busy || !valid} aria-busy={busy || undefined} className={className}>
    {busy && <LoaderCircle size={13} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />}{t('Connect')}
  </button>
  const note = <p id={`${id}-note`} className="calendar-link-note">{t('The address stays on this computer.')}</p>
  return (
    <form data-testid="calendar-link-form" className="calendar-link-form" noValidate onSubmit={(e) => void submit(e)} onKeyDown={e => {
      if (e.key === 'Escape' && onCancel) { e.preventDefault(); e.stopPropagation(); if (!busy) onCancel() }
    }}>
      <fieldset className="calendar-link-fields" disabled={busy}>
      {!only && <div role="tablist" aria-label={t('Your calendar')} className="calendar-link-providers">
        {PROVIDERS.map((p) => <button key={p.id} type="button" role="tab" aria-selected={provider === p.id} data-testid={`calendar-link-provider-${p.id}`}
          className="calendar-link-provider" onClick={() => setProvider(p.id)}>{p.name || t('Other')}</button>)}
      </div>}
      {page && <a href={page} target="_blank" rel="noreferrer" data-testid="calendar-link-open" className="workspace-button calendar-link-open">
        <span>{provider === 'google' ? t('Open Google Calendar settings') : t('Open Outlook calendar settings')}</span><ExternalLink size={12} aria-hidden="true" />
      </a>}
      {provider === 'other' ? <p className="calendar-link-instructions">{steps(provider)[0]}</p>
        : <ol className="calendar-link-steps">{steps(provider).map((s) => <li key={s}>{s}</li>)}</ol>}
      <div className="calendar-link-field">
        <label htmlFor={id}>{t('Calendar address')}</label>
        <input ref={input} id={id} data-testid="calendar-link-input" type="url" inputMode="url" autoComplete="off" spellCheck={false}
          aria-invalid={error === 'bad-url' || error === 'not-calendar' || error === 'public-address' || undefined}
          aria-describedby={`${id}-note${error ? ` ${id}-error` : ''}`} placeholder="https://… .ics" value={url}
          onBlur={(e) => { if (e.relatedTarget?.tagName !== 'BUTTON' && url.trim() && !valid) setError('bad-url') }}
          onChange={(e) => { setUrl(e.target.value); setError(null) }} className="calendar-link-input" />
      </div>
      {error && <p id={`${id}-error`} data-testid="calendar-link-error" role="alert" className="calendar-link-error">{ERRORS[error]()}</p>}
      {variant === 'settings' ? <div className="calendar-link-footer">{note}<div className="calendar-link-settings-actions">
        {onCancel && <button type="button" data-testid="calendar-link-cancel" className="text-action" onClick={onCancel}>{t('Cancel')}</button>}
        {connect('workspace-button primary')}
      </div></div> : <>{note}<div className="calendar-link-actions">{connect('ob-button primary no-drag')}{extra}</div></>}
      </fieldset>
    </form>
  )
}
