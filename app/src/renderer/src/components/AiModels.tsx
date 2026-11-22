import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from './Icons'
import { LoadingContent } from './LoadingContent'
import { retryToast, toasts } from './TrashToast'
import { AI_TASKS, SERVER_CONTEXT, type AiStatus, type AiTask, type Provider } from '../../../shared/ai'
import { language, t } from '../../../shared/i18n'
import type { SetupState } from '../../../shared/types'
import { osWords } from '../keys'
import { notesUpgradeSize } from '../notesSetup'

const label = (task: AiTask) => task === 'notes' ? t('Summaries and titles') : task === 'ask' ? t('Ask') : t('Folder suggestions')
const description = (task: AiTask) => task === 'notes' ? t('Written after each meeting, and when you write a summary again.')
  : task === 'ask' ? t('Answers to your questions about meetings.') : t('A folder suggested for each new meeting.')

/** what can write a task's text: this computer, and the server once saved */
export function aiOptions(s: AiStatus): Array<{ value: Provider; label: string }> {
  return [
    { value: 'local', label: s.local ? osWords({ mac: t('Yogurt AI on this Mac'), other: t('Yogurt AI on this computer') }) : t('Yogurt AI (not on this computer)') },
    ...(s.server?.model ? [{ value: 'server' as const, label: t('Your server · {model}', { model: s.server.model }) }] : []),
  ]
}

/** the names meeting text goes to, in the order picked, once each */
export function aiElsewhere(s: AiStatus): string[] {
  const names = AI_TASKS.map((task) => s.tasks[task]).filter((p) => p !== 'local').map(() => t('your server'))
  return [...new Set(names)]
}

/** a change that failed gets the toast every failed action gets, with Try again */
function attempt(run: () => Promise<void>, retryId: string): Promise<void> {
  const id = `${retryId}-error`
  toasts.close(id)
  return run().catch(() => retryToast(id, t("Couldn't save your changes"), retryId, () => attempt(run, retryId)))
}

/** Settings → AI models: what writes each kind of text, and the person's own server */
export function AiModels() {
  const [status, setStatus] = useState<AiStatus>()
  useEffect(() => { void window.yogurt.ai.status().then(setStatus).catch(() => {}) }, [])
  const pick = (task: AiTask, provider: Provider) => {
    setStatus((s) => s && { ...s, tasks: { ...s.tasks, [task]: provider } })
    void attempt(async () => setStatus(await window.yogurt.ai.setTask(task, provider)), 'ai-task-retry')
  }
  const elsewhere = status ? aiElsewhere(status) : []
  return (
    <>
      <h2 className="settings-section-heading">{t('AI models')}</h2>
      <LoadingContent pending={!status} testId="ai-models-loading"><div data-testid="ai-models" className="settings-group">
        {AI_TASKS.map((task) => (
          <div key={task} className="settings-row">
            <div className="settings-row-copy">
              <label htmlFor={`ai-task-${task}`} className="settings-label">{label(task)}</label>
              <p id={`ai-task-${task}-description`} className="settings-description">{description(task)}</p>
            </div>
            <span className="settings-select-wrap">
              <select id={`ai-task-${task}`} data-testid={`ai-task-${task}`} aria-describedby={`ai-task-${task}-description`} value={status?.tasks[task] ?? 'local'} disabled={!status}
                onChange={(e) => pick(task, e.target.value as Provider)} className="settings-select">
                {status && aiOptions(status).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <ChevronDown size={14} aria-hidden="true" />
            </span>
          </div>
        ))}
        {elsewhere.length > 0 && <div className="settings-row"><p data-testid="ai-models-elsewhere" role="status" className="settings-description">
          {t('Meeting text goes to {names} for these. What happens to it there is up to them.', { names: elsewhere.join(', ') })}
        </p></div>}
        {status && <LocalSetting onChange={setStatus} />}
        {status && <ServerSetting key={status.server?.url ?? ''} status={status} onChange={setStatus} />}
      </div></LoadingContent>
    </>
  )
}

const percent = (fraction: number) => new Intl.NumberFormat(language(), { style: 'percent', maximumFractionDigits: 0 }).format(fraction)

/** Yogurt AI kept on this computer or not: Remove frees its space (tasks on it wait), Download brings it back */
function LocalSetting({ onChange }: { onChange: (s: AiStatus) => void }) {
  const [setup, setSetup] = useState<SetupState>()
  const [busy, setBusy] = useState(false)
  const downloading = useRef(false)
  useEffect(() => {
    void window.yogurt.setup.state().then(setSetup)
    return window.yogurt.setup.onState((s) => {
      setSetup(s)
      // the notes model just landed: the choices say so
      if (downloading.current && !s.notesDownloading) void window.yogurt.ai.status().then(onChange)
      downloading.current = !!s.notesDownloading
    })
  }, [])
  if (setup?.phase !== 'ready') return null
  const keep = async (on: boolean) => {
    setBusy(true)
    try { await attempt(async () => onChange(await window.yogurt.ai.setLocal(on)), 'ai-local-retry') } finally { setBusy(false) }
  }
  const off = !!setup.localNotesOff
  const note = setup.localNotesUnavailable ? t('No notes model fits this computer: pick another AI above for each task.')
    : off ? t('Not on this computer. Tasks set to it wait until you download it.')
    : setup.notesDownloading ? t('Downloading AI · {percent}', { percent: percent(setup.notesFraction ?? 0) })
    : t('On this computer, so it works offline. Remove it to free its space.')
  return (
    <div data-testid="ai-local" className="settings-row">
      <div className="settings-row-copy">
        <p className="settings-label">{osWords({ mac: t('Yogurt AI on this Mac'), other: t('Yogurt AI on this computer') })}</p>
        <p data-testid="ai-local-status" role="status" className="settings-description">{note}</p>
      </div>
      {!setup.localNotesUnavailable && (off
        ? <button data-testid="ai-local-download" disabled={busy} onClick={() => void keep(true)} className="workspace-button settings-action">{t('Download ({size} GB)', { size: notesUpgradeSize(setup.localNotesBytes ?? 0) })}</button>
        : <button data-testid="ai-local-remove" disabled={busy} onClick={() => void keep(false)} className="workspace-button settings-action">{t('Remove')}</button>)}
    </div>
  )
}

/** the person's own OpenAI-compatible server: address, key, model and how much it reads at once */
function ServerSetting({ status, onChange }: { status: AiStatus; onChange: (s: AiStatus) => void }) {
  const saved = status.server
  const [url, setUrl] = useState(saved?.url ?? '')
  // the saved key never comes back to the window: a new one replaces it
  const [key, setKey] = useState('')
  const [model, setModel] = useState(saved?.model ?? '')
  const [context, setContext] = useState(String(saved?.contextSize ?? SERVER_CONTEXT))
  const [models, setModels] = useState<string[]>([])
  const [test, setTest] = useState<{ state: 'testing' | 'ok' | 'failed'; detail?: string }>()
  const [busy, setBusy] = useState(false)
  const typedKey = key.trim() ? { key: key.trim() } : {}
  const connect = async () => {
    setTest({ state: 'testing' })
    const r = await window.yogurt.ai.serverModels({ url, ...typedKey }).catch(() => ({ error: 'unreachable' as const }))
    if ('models' in r) { setModels(r.models); setTest({ state: 'ok' }); if (!model && r.models[0]) setModel(r.models[0]) }
    else setTest({ state: 'failed', detail: 'detail' in r ? r.detail : undefined })
  }
  const change = async (write: () => Promise<AiStatus>, retryId: string) => {
    setBusy(true)
    try { await attempt(async () => { onChange(await write()); setKey('') }, retryId) } finally { setBusy(false) }
  }
  const save = () => change(() => window.yogurt.ai.setServer({ url, model, contextSize: Number(context) || SERVER_CONTEXT, ...typedKey }), 'ai-server-save-retry')
  const remove = () => change(() => window.yogurt.ai.setServer(null), 'ai-server-remove-retry')
  return (
    <div data-testid="ai-server" className="settings-row">
      <div className="settings-row-copy">
        <p className="settings-label">{t('Your server')}</p>
        <p className="settings-description">{t('An OpenAI-compatible server, like LM Studio, Ollama or a hosted one. Once saved, pick it above.')}</p>
        <div className="settings-ai-server">
          <label>{t('Address')}<input data-testid="ai-server-url" dir="ltr" value={url} placeholder="http://localhost:1234/v1" autoComplete="off" spellCheck={false} onChange={(e) => { setUrl(e.target.value); setTest(undefined) }} /></label>
          <label>{t('Key')}<input data-testid="ai-server-key" dir="ltr" type="password" value={key} placeholder={saved?.hasKey ? t('Saved') : t('Optional')} autoComplete="off" onChange={(e) => setKey(e.target.value)} /></label>
          <label>{t('Model')}<input data-testid="ai-server-model" dir="ltr" list="ai-server-models" value={model} autoComplete="off" spellCheck={false} onChange={(e) => setModel(e.target.value)} /></label>
          <datalist id="ai-server-models">{models.map((m) => <option key={m} value={m} />)}</datalist>
          <label>{t('Context, in tokens')}<input data-testid="ai-server-context" dir="ltr" type="number" min={4096} step={1024} value={context} onChange={(e) => setContext(e.target.value)} /></label>
        </div>
        <div className="settings-ai-actions">
          <button data-testid="ai-server-test" disabled={!url.trim() || test?.state === 'testing'} onClick={() => void connect()} className="workspace-button">{t('Test connection')}</button>
          <button data-testid="ai-server-save" disabled={!url.trim() || !model.trim() || busy} onClick={() => void save()} className="workspace-button primary">{t('Save')}</button>
          {saved && <button data-testid="ai-server-remove" disabled={busy} onClick={() => void remove()} className="workspace-button">{t('Remove')}</button>}
          <span data-testid="ai-server-status" role="status">{test?.state === 'testing' ? t('Connecting…') : test?.state === 'ok' ? t('Connected') : test?.state === 'failed' ? [t("Couldn't reach the server."), test.detail].filter(Boolean).join(' ') : ''}</span>
        </div>
      </div>
    </div>
  )
}
