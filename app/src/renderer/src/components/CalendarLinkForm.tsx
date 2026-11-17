import { useState, type FormEvent, type ReactNode } from 'react'
import { ExternalLink, LoaderCircle } from 'lucide-react'
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
  ? [t('Under "Settings for my calendars", choose your calendar, then "Integrate calendar".'), t('Copy "Secret address in iCal format" and paste it below.'),
    t('Only see "Public address in iCal format"? Your organization turned off secret addresses, so this calendar can\'t be connected this way.')]
  : p === 'outlook'
    ? [t('Under "Publish a calendar", choose your calendar and "Can view all details", then Publish.'), t('Copy the ICS link and paste it below.')]
    : [t('In your calendar app\'s settings, find its private iCal address. It ends in .ics or starts with webcal://.'), t('Paste it below.')]

const ERRORS = {
  'bad-url': () => t('That doesn\'t look like a calendar address. It should start with https:// or webcal://.'),
  'unreachable': () => t('Yogurt couldn\'t reach that address. Check your connection and the address.'),
  'not-calendar': () => t('That address isn\'t a calendar. Copy the iCal address, not the page\'s address.'),
  'public-address': () => t('That\'s the public address, which only works if your calendar is public. Copy "Secret address in iCal format" instead.'),
}

/**
 * settings: the address and Connect on one row, as Settings' other rows. onboarding: Connect becomes the screen's main
 * button, beside `extra` (Not now), so the screen ends like every other first-run screen.
 */
export function CalendarLinkForm({ onConnected, autoFocus, variant = 'settings', extra }: { onConnected(name: string): void; autoFocus?: boolean; variant?: 'settings' | 'onboarding'; extra?: ReactNode }) {
  const [provider, setProvider] = useState<Provider>('google')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<keyof typeof ERRORS | null>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!url.trim() || busy) return
    setBusy(true); setError(null)
    try {
      const got = await window.yogurt.calendar.addLink(url)
      if (got.ok) { setUrl(''); onConnected(got.name) } else setError(got.error)
    } catch { setError('unreachable') } finally { setBusy(false) }
  }
  const page = PAGE[provider]
  const connect = (className: string) => <button data-testid="calendar-link-connect" type="submit" disabled={busy || !url.trim()} className={className}>
    {busy && <LoaderCircle size={13} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />}{t('Connect')}
  </button>
  return (
    <form data-testid="calendar-link-form" className="calendar-link-form" onSubmit={(e) => void submit(e)}>
      <div role="tablist" aria-label={t('Your calendar')} className="calendar-link-providers">
        {PROVIDERS.map((p) => <button key={p.id} type="button" role="tab" aria-selected={provider === p.id} data-testid={`calendar-link-provider-${p.id}`}
          className="calendar-link-provider" onClick={() => setProvider(p.id)}>{p.name || t('Other')}</button>)}
      </div>
      {page && <a href={page} target="_blank" rel="noreferrer" data-testid="calendar-link-open" className="workspace-button calendar-link-open">
        <span>{provider === 'google' ? t('Open Google Calendar settings') : t('Open Outlook calendar settings')}</span><ExternalLink size={12} aria-hidden="true" />
      </a>}
      <ol className="calendar-link-steps">{steps(provider).map((s) => <li key={s}>{s}</li>)}</ol>
      <div className="calendar-link-row">
        <input data-testid="calendar-link-input" type="url" inputMode="url" autoComplete="off" spellCheck={false} autoFocus={autoFocus}
          aria-label={t('Calendar address')} placeholder="https://… .ics" value={url} onChange={(e) => { setUrl(e.target.value); setError(null) }} className="calendar-link-input" />
        {variant === 'settings' && connect('workspace-button primary shrink-0')}
      </div>
      {error && <p data-testid="calendar-link-error" role="alert" className="calendar-link-error">{ERRORS[error]()}</p>}
      <p className="calendar-link-note">{t('The address stays on this computer. Anyone who has it can see your calendar, so keep it private.')}</p>
      {variant === 'onboarding' && <div className="calendar-link-actions">{connect('ob-button primary no-drag')}{extra}</div>}
    </form>
  )
}
