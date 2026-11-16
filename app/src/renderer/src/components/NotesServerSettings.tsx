import { useEffect, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { NotesServerCheck, NotesServerView } from '../../../shared/types'
import { t } from '../../../shared/i18n'
import { LoadingContent } from './LoadingContent'

/** what a connection check means, in words */
export function checkText(c: NotesServerCheck): string {
  if (c.ok) return c.models.length ? t('Connected. Pick a model below.') : t('Connected, but the server lists no models.')
  if (c.reason === 'address') return t('That isn’t an http or https address.')
  if (c.reason === 'refused') return t('The server refused the key ({status}).', { status: c.status ?? '' })
  if (c.reason === 'status') return t('The server answered with an error ({status}).', { status: c.status ?? '' })
  return t('Couldn’t reach the server.')
}

/**
 * Settings → Notes server: a notes model on another computer the person runs (an OpenAI-compatible server), tried before
 * the one on this computer. Off until turned on. The key is typed here, saved by the main process, and never shown again.
 */
export function NotesServerSettings({ onChange }: { onChange?: (on: boolean) => void }) {
  const [saved, setSaved] = useState<NotesServerView>()
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [model, setModel] = useState('')
  const [key, setKey] = useState('')
  const [check, setCheck] = useState<NotesServerCheck>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const show = (v: NotesServerView) => { setSaved(v); setUrl(v.url); setModel(v.model); onChange?.(v.enabled) }
  useEffect(() => { void window.yogurt.notesServer.get().then(show) }, [])

  const on = !!saved?.enabled
  const fields = on || open
  const models = check?.ok ? check.models : []

  const toggle = async () => {
    if (!saved) return
    setError('')
    if (on) { show(await window.yogurt.notesServer.set({ enabled: false })); setOpen(false); return }
    if (saved.url && saved.model) { show(await window.yogurt.notesServer.set({ enabled: true })); return }
    setOpen(true)
  }
  const test = async () => {
    setBusy(true); setError('')
    try {
      const c = await window.yogurt.notesServer.check(url, key || undefined)
      setCheck(c)
      if (c.ok && !model && c.models.length) setModel(c.models[0])
    } finally { setBusy(false) }
  }
  const save = async () => {
    setBusy(true); setError('')
    try {
      show(await window.yogurt.notesServer.set({ url, model, enabled: true, ...(key ? { key } : {}) }))
      setKey('')
    } catch {
      setError(t('That isn’t an http or https address.'))
    } finally { setBusy(false) }
  }
  const removeKey = async () => { show(await window.yogurt.notesServer.set({ key: '' })) }
  const ready = !!url.trim() && !!model.trim()

  return (
    <>
      <h2 className="settings-section-heading">{t('Notes server')}</h2>
      <LoadingContent pending={!saved} testId="notes-server-loading"><div data-testid="notes-server" className="settings-group">
        <div className="settings-row">
          <div className="settings-row-copy">
            <p className="settings-label">{t('Write notes on your own server')}</p>
            <p className="settings-description">{t('Yogurt sends a meeting’s transcript to this server to write its notes and answer Ask. When the server doesn’t answer, the model on this computer takes over.')}</p>
          </div>
          <button data-testid="notes-server-toggle" role="switch" aria-checked={on} aria-label={t('Write notes on your own server')} onClick={() => void toggle()} className="settings-toggle">
            <span className="settings-toggle-knob" />
          </button>
        </div>
        {fields &&
          <div className="settings-row">
            <div className="settings-row-copy flex flex-col gap-3">
              <p className="settings-description">{t('Any OpenAI-compatible server works, such as LiteLLM, vLLM, Ollama or llama.cpp. Use the address that ends in /v1.')}</p>
              <label className="flex flex-col gap-1">
                <span className="settings-label">{t('Address')}</span>
                <input data-testid="notes-server-url" dir="ltr" value={url} spellCheck={false} autoComplete="off" placeholder="http://192.168.1.10:4000/v1"
                  onChange={(e) => { setUrl(e.target.value); setCheck(undefined) }} className="settings-name-field settings-server-field font-mono" />
              </label>
              <label className="flex flex-col gap-1">
                <span className="settings-label">{t('Key')}</span>
                <input data-testid="notes-server-key" dir="ltr" type="password" value={key} autoComplete="off"
                  placeholder={saved?.hasKey ? t('Saved. Type a new one to replace it.') : t('Optional')}
                  onChange={(e) => { setKey(e.target.value); setCheck(undefined) }} className="settings-name-field settings-server-field font-mono" />
                {saved?.hasKey && <button data-testid="notes-server-remove-key" onClick={() => void removeKey()} className="self-start text-[12px] text-muted underline">{t('Remove the saved key')}</button>}
              </label>
              {check && <p data-testid="notes-server-check" aria-live="polite" className="text-[12px] leading-[18px] text-muted">{checkText(check)}</p>}
              <label className="flex flex-col gap-1">
                <span className="settings-label">{t('Model')}</span>
                {models.length
                  ? <span className="settings-select-wrap settings-server-field">
                    <select data-testid="notes-server-model" value={model} onChange={(e) => setModel(e.target.value)} className="settings-select">
                      {!models.includes(model) && model && <option value={model}>{model}</option>}
                      {models.map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                    <ChevronDown size={14} aria-hidden="true" />
                  </span>
                  : <input data-testid="notes-server-model" dir="ltr" value={model} spellCheck={false} autoComplete="off" placeholder={t('Test the connection to pick one')}
                    onChange={(e) => setModel(e.target.value)} className="settings-name-field settings-server-field font-mono" />}
              </label>
              {error && <p role="alert" className="settings-description">{error}</p>}
              <div className="flex gap-2">
                <button data-testid="notes-server-test" disabled={busy || !url.trim()} aria-busy={busy} onClick={() => void test()} className="workspace-button">{t('Test connection')}</button>
                <button data-testid="notes-server-save" disabled={busy || !ready} onClick={() => void save()} className="workspace-button">{t('Save')}</button>
              </div>
            </div>
          </div>
        }
      </div></LoadingContent>
    </>
  )
}
