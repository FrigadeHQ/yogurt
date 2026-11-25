import { useEffect, useRef, useState } from 'react'
import { GRANOLA_CSV_BYTES, type GranolaStatus } from '../../../shared/granola'
import { language, t } from '../../../shared/i18n'
import { ChevronDown } from './Icons'

export function GranolaPrompt() {
  const [visible, setVisible] = useState(false)
  const [error, setError] = useState(false)
  useEffect(() => {
    let sequence = 0
    const refresh = () => {
      const token = ++sequence
      void window.yogurt.granola.offer().then(show => { if (token === sequence) setVisible(show) }, () => { if (token === sequence) setVisible(false) })
    }
    const off = window.yogurt.granola.onChange(refresh)
    const meetings = window.yogurt.meetings.onChange(refresh)
    refresh()
    return () => { sequence++; off(); meetings() }
  }, [])
  if (!visible) return null
  return <section className="settings-group granola-prompt" aria-labelledby="granola-prompt-title">
    <h2 className="settings-label" id="granola-prompt-title">{t('Bring your notes from Granola')}</h2>
    <p className="settings-description">{t('Search your Granola meetings and ask questions about them in Yogurt.')}</p>
    <div className="settings-backup-actions">
      <button className="workspace-button" onClick={() => window.yogurt.nav.go('/settings/import')}>{t('Import notes')}</button>
      <button className="ghost-btn" onClick={() => void window.yogurt.granola.dismiss().then(() => setVisible(false), () => setError(true))}>{t('Not now')}</button>
    </div>
    {error && <p role="alert" className="settings-description">{t("Couldn't save your changes")}</p>}
  </section>
}

export function ImportSettings({ reveal }: { reveal: boolean }) {
  const section = useRef<HTMLElement>(null)
  const source = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(reveal)
  useEffect(() => {
    if (reveal) setOpen(true)
  }, [reveal])
  useEffect(() => {
    if (reveal && open) { source.current?.focus({ preventScroll: true }); section.current?.scrollIntoView({ block: 'center' }) }
  }, [reveal, open])
  return <section ref={section} data-testid="import-settings">
    <h2 className="settings-section-heading">{t('Import')}</h2>
    <ul className="settings-group"><li>
      <button ref={source} type="button" className="settings-row settings-disclosure granola-source" aria-expanded={open} aria-controls="granola-methods" onClick={() => setOpen(!open)}>
        <span className="settings-row-copy settings-label">Granola</span><ChevronDown size={16} aria-hidden="true" />
      </button>
      <div id="granola-methods" hidden={!open}>{open && <GranolaMethods />}</div>
    </li></ul>
  </section>
}

export function useGranolaImport() {
  const file = useRef<HTMLInputElement>(null)
  const [status, setStatus] = useState<GranolaStatus>()
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [pending, setPending] = useState(false)
  const [key, setKey] = useState('')
  useEffect(() => {
    let sequence = 0
    const refresh = () => {
      const token = ++sequence
      void window.yogurt.granola.status().then(s => { if (token === sequence) setStatus(s) }, () => { if (token === sequence) setError(t("Couldn't load this content.")) })
    }
    refresh()
    const off = window.yogurt.granola.onChange(refresh)
    return () => { sequence++; off() }
  }, [attempt])
  const busy = pending || !status || status.phase !== 'idle'
  const act = async (fn: () => Promise<void>) => {
    if (busy) return
    setPending(true); setError('')
    try { await fn() } catch { setError(t("Yogurt couldn't make that change. Try again.")) }
    finally { setPending(false) }
  }
  const pick = (files: FileList | null) => {
    if (!files?.length || busy) return
    const chosen = files[0]
    if (files.length !== 1 || !/\.csv$/i.test(chosen.name) || chosen.size > GRANOLA_CSV_BYTES) { setError(t('Choose a CSV file under 128 MB.')); return }
    void act(async () => { await window.yogurt.granola.importCsv(await chosen.text()) })
  }
  const input = <input ref={file} type="file" accept=".csv,text/csv" hidden onChange={e => { pick(e.target.files); e.target.value = '' }} />
  const find = () => act(async () => {
    const value = key.trim()
    setKey('')
    await window.yogurt.granola.list(value || undefined)
  })
  return { status, error, retryStatus: () => { setError(''); setAttempt(n => n + 1) }, clearError: () => setError(''), busy, act, pick, input, choose: () => file.current?.click(), key, setKey, find }
}

export function quotaMessage(until: number) {
  const time = new Intl.DateTimeFormat(language(), { timeStyle: 'short' }).format(until)
  return t('Granola reached its limit. Yogurt will retry at {time}.', { time })
}

function GranolaMethods() {
  const { status, error, busy, act, pick, input, choose, key, setKey, find } = useGranolaImport()
  const [drag, setDrag] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const result = status?.result
  const progress = result ? result.added + result.skipped + result.failures.length : 0
  const alternatives = <>
    <div className="settings-row granola-drop" data-drag={drag} onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = busy ? 'none' : 'copy'; setDrag(!busy) }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrag(false) }}
      onDrop={e => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files) }}>
      <div className="settings-row-copy"><p className="settings-label">CSV</p>
        <p className="settings-description">{t('In Granola, go to Settings → Profile → Generate CSV. Drop the emailed file here.')}</p>
      </div>
      {input}
      <button className="workspace-button" disabled={busy} onClick={choose}>{t('Choose CSV')}</button>
    </div>
    <div className="granola-key-toggle"><button className="text-action" aria-expanded={showKey} aria-controls="granola-api-method" onClick={() => setShowKey(!showKey)}>{t('Use an API key instead')}</button></div>
    <div id="granola-api-method" hidden={!showKey}>
      <div className="settings-row flex-col !items-stretch !gap-0">
        <label className="settings-label" htmlFor={status?.hasKey ? undefined : 'granola-key'}>{t('API key')}</label>
        <p className="settings-description">{t('On Business or Enterprise, get your key in Settings → Connectors → API keys.')}</p>
        <form className="settings-backup-actions" onSubmit={e => {
          e.preventDefault()
          void find()
        }}>
          {!status?.hasKey && <input id="granola-key" type="password" className="settings-name-field" value={key} onChange={e => setKey(e.target.value)}
            autoComplete="off" spellCheck={false} disabled={busy} />}
          <button className="workspace-button" disabled={busy || (!status?.hasKey && !key.trim())}>{status?.phase === 'listing' ? t('Loading…') : t('Find meetings')}</button>
          {status?.hasKey && <button type="button" className="ghost-btn" disabled={busy} aria-label={t('Remove {name}', { name: t('API key') })} onClick={() => void act(() => window.yogurt.granola.remove())}>{t('Remove')}</button>}
        </form>
        {status?.available != null && <div className="settings-backup-actions">
          <span role="status" className="settings-label">{t('{count} meetings', { count: status.available })}</span>
          {status.available > 0 && <button className="workspace-button" disabled={busy} onClick={() => void act(() => window.yogurt.granola.importApi())}>{t('Import notes')}</button>}
        </div>}
      </div>
    </div>
  </>
  const planNote = <p id="granola-plan-note" className="settings-description">{status?.notice && status.phase === 'idle' ? status.notice : t('Search your Granola meetings and ask questions about them in Yogurt.')}</p>
  const actions = <>
    {status?.connected
      ? <button className="workspace-button" aria-describedby="granola-plan-note" disabled={busy} onClick={() => void act(() => window.yogurt.granola.importConnected())}>{t('Import notes')}</button>
      : <button className="workspace-button" aria-describedby="granola-plan-note" disabled={busy} onClick={() => void act(() => window.yogurt.granola.connect())}>{status?.phase === 'connecting' ? t('Finish signing in in your browser.') : t('Connect Granola')}</button>}
    {status?.phase === 'connecting' && <button className="ghost-btn" onClick={() => void window.yogurt.granola.cancelConnect()}>{t('Cancel')}</button>}
    {status?.connected && <button className="ghost-btn" disabled={busy && status.phase !== 'waiting'} onClick={() => void window.yogurt.granola.disconnect()}>{t('Disconnect')}</button>}
  </>
  const feedback = <>
    {status?.phase === 'finding' && <p className="granola-result" role="status">{t('Searching your meetings…')}</p>}
    {status?.retryAt && <p className="granola-result" role="status">{quotaMessage(status.retryAt)}</p>}
    {status?.cancelled && <p className="granola-result" role="status">{t('Sign-in cancelled.')}</p>}
    {status?.phase === 'importing' && !result && <p className="granola-result" role="status">{t('Importing…')}</p>}
    {(result || status?.error || error) && <div className="granola-result">
      {result && <><p role="status">{status?.phase !== 'idle'
        ? t('Importing…') + ' ' + t('{current} of {count}', { current: progress, count: result.total })
        : t('Added {count} meetings.', { count: result.added }) + ' ' + t('{count} were already here.', { count: result.skipped })}</p>
        {result.failures.length > 0 && <details><summary>{t('Failed imports · {n}', { n: result.failures.length })}</summary>
          <ul>{result.failures.map((f, i) => <li key={i}><strong>{f.title}</strong> — {f.reason}</li>)}</ul>
        </details>}</>}
      {(error || status?.error) && <p role="alert">{error || status?.error}</p>}
    </div>}
  </>
  return <div className="granola-methods">
    <div className="settings-row granola-connection flex-col !items-stretch !gap-0">
      {status?.connected && <p className="settings-label">{t('Connected')}</p>}
      {planNote}
      <div className="settings-backup-actions">{actions}</div>
      {feedback}
    </div>
    {alternatives}
  </div>
}
