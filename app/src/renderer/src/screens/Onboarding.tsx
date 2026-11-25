import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { LoaderCircle } from '../components/Icons'
import type { OnboardingPlan, OnboardingStep, PermissionKind, SetupState } from '../../../shared/types'
import { screensOf, type OnboardingScreen } from '../../../shared/onboarding'
import type { GranolaMethod } from '../../../shared/granola'
import { quotaMessage, useGranolaImport } from '../components/GranolaImport'
import { Wordmark } from '../components/Logo'
import { GranolaArt, ReadyArt, ScreenArt, WelcomeArt } from '../components/OnboardingArt'
import { SettingsArt } from '../components/SettingsGuide'
import { CalendarLinkForm } from '../components/CalendarLinkForm'
import { SetupStatus, transcriptionPhase, transcriptionPercent } from '../components/SetupStatus'
import { permissionCopy, screenCopy } from '../permissionCopy'
import { usePermissionFlow } from '../permissionFlow'
import { t } from '../../../shared/i18n'

/**
 * First run: one welcome screen, then one screen per idea still to ask (the mic and the call audio share one), each
 * with a picture of what it does. Every one can be put off ("Not now"); home's Finish setup and Settings have them
 * again. Then the download, if it isn't done yet. The models keep downloading in the background the whole time.
 */
export function Onboarding({ state, plan, onDone }: { state: SetupState; plan: OnboardingPlan; onDone(): void }) {
  const screens = useMemo(() => screensOf(plan.steps), [plan])
  const [stage, setStage] = useState<'intro' | 'steps' | 'granola' | 'progress'>(plan.intro ? 'intro' : screens.length ? 'steps' : plan.granola ? 'granola' : 'progress')
  const [i, setI] = useState(0)
  const finish = () => { setStage('progress'); void window.yogurt.onboarding.done().finally(onDone) }
  const afterPermissions = () => plan.granola ? setStage('granola') : finish()
  const introDone = () => {
    void window.yogurt.onboarding.introSeen()
    if (screens.length) setStage('steps'); else afterPermissions()
  }
  const next = () => { if (i + 1 < screens.length) setI(i + 1); else afterPermissions() }
  const screen = screens[i]
  // the welcome counts as the first step, so the bar shows how much is left from the start
  const first = plan.intro ? 1 : 0
  const progress = { n: stage === 'intro' ? 0 : first + (stage === 'granola' ? screens.length : i), total: first + screens.length + Number(!!plan.granola) }
  return (
    <div data-testid="onboarding" data-phase={state.phase} data-stage={stage} className="setup-screen">
      {stage === 'intro' ? <Welcome state={state} progress={progress} onDone={introDone} />
        : stage === 'steps' && screen ? (screen.id === 'calendar' && window.yogurt.capabilities.calendarLink
          ? <CalendarLinkScreen key={screen.id} state={state} progress={progress} onNext={next} />
          : <PermissionScreen key={screen.id} screen={screen} state={state} progress={progress} onNext={next} />)
          : stage === 'granola' ? <GranolaStep state={state} progress={progress} onNext={() => { void window.yogurt.granola.dismiss().finally(finish) }} />
          : <Ready state={state} />}
    </div>
  )
}

type Progress = { n: number; total: number }

/**
 * Every screen of the first run: the words on one side, the picture on the other. The headline, the sentence and the
 * buttons sit in the same place on every screen; the note under the buttons has its own room so nothing moves.
 * motionKey: a change fades the words in again; its part before ":" does the same for the picture.
 */
function Layout({ testId, step, kind, motionKey, art, artLabel, title, text, chooser, textTestId = 'step-reason', actions, note, progress, state }: {
  testId: string; step?: string; kind?: string; motionKey: string; art: ReactNode; artLabel?: string; title: string; text: string; chooser?: ReactNode; textTestId?: string
  actions: ReactNode; note?: ReactNode; progress?: Progress; state?: SetupState
}) {
  return (
    <section data-testid={testId} data-step={step} data-kind={kind} className="ob">
      <div className="ob-side">
        {step !== 'welcome' && <div className="ob-brand"><Wordmark height={22} /></div>}
        <div className="ob-main">
          <div key={motionKey} className="ob-copy">
            {step === 'welcome' && <div className="ob-brand ob-intro-brand"><Wordmark height={22} /></div>}
            <h1 data-testid="step-title" className="ob-title"><span>{title}</span></h1>
            {chooser}
            <p id="step-reason" data-testid={textTestId} className="ob-text">{text}</p>
            <div className="ob-actions">{actions}</div>
            <div className="ob-note-slot">{note}</div>
          </div>
        </div>
        <div className="ob-foot">
          {progress && <Steps {...progress} />}
          {state && <SetupStatus state={state} />}
        </div>
      </div>
      <div className="ob-stage" role={artLabel ? 'region' : undefined} aria-label={artLabel} aria-hidden={artLabel ? undefined : true}>
        <div key={motionKey} className="ob-stage-art">{art}</div>
      </div>
    </section>
  )
}

/** A quiet bar of segments: the ones done and this one filled, the rest waiting */
function Steps({ n, total }: Progress) {
  return (
    <div className="ob-steps" role="img" aria-label={t('Step {n} of {total}', { n: n + 1, total })}>
      {Array.from({ length: total }, (_, k) => <span key={k} data-done={k <= n} />)}
    </div>
  )
}

/** The keyboard focus goes to the main button whenever what it does changes, so Enter answers and a screen reader reads it */
function useFocus(ref: RefObject<HTMLButtonElement | null>, deps: unknown[]) {
  useEffect(() => { ref.current?.focus() }, deps)
}

function GranolaStep({ state, progress, onNext }: { state: SetupState; progress: Progress; onNext(): void }) {
  const { status, error, retryStatus, clearError, busy, act, input, choose, key, setKey, find } = useGranolaImport()
  const [method, setMethod] = useState<GranolaMethod>('connect')
  const select = (value: GranolaMethod) => { setMethod(value); setKey(''); clearError() }
  const primary = useRef<HTMLButtonElement>(null)
  const phase = status?.phase ?? 'idle'
  const matching = status?.source === method
  const result = matching ? status.result : null
  const processed = result ? result.added + result.skipped + result.failures.length : 0
  const count = result ? t('{current} of {count}', { current: processed, count: result.total }) : ''
  const problem = error || (matching && status.error)
  const active = phase === 'finding' || phase === 'importing' || phase === 'waiting'
  const found = method === 'key' && matching && status.available != null ? status.available : null
  const done = phase === 'idle' && (!!result || found === 0) && !problem
  const picking = phase === 'idle' && !done
  const selectingKey = picking && method === 'key' && !status?.hasKey
  const background = t('You can continue setup. Follow the import in Settings → Import.')
  let title = t('Bring your notes from Granola')
  let text = t('Sign in to Granola to add your meetings to Yogurt.')
  if (method === 'csv') text = t('In Granola, go to Settings → Profile → Generate CSV.')
  if (method === 'key') text = t('On Business or Enterprise, get your key in Settings → Connectors → API keys.')
  if (found && !result) text = t('{count} meetings', { count: found })
  if (phase === 'connecting') { title = t('Connect Granola'); text = t('Finish signing in in your browser.') }
  else if (phase === 'listing') { title = t('Searching your meetings…') }
  else if (phase === 'finding') { title = t('Searching your meetings…'); text = background }
  else if (phase === 'waiting' && status?.retryAt) { title = t('Import paused'); text = quotaMessage(status.retryAt) }
  else if (phase === 'importing') { title = t('Importing…'); text = background }
  else if (problem) { title = t("Couldn't import notes"); text = problem }
  else if (matching && status.cancelled) { title = t('Sign-in cancelled.'); text = t('Sign in to Granola to add your meetings to Yogurt.') }
  else if (done) {
    title = result?.total ? t('Added {count} meetings.', { count: result.added }) : t('No meetings')
    text = result?.total ? t('Open Meetings to read your notes.') : t('No meetings found in Granola.')
    if (result?.total && !result.added && !result.skipped) text = ''
    if (status?.notice) text = status.notice
  }
  const next = active || done
  const methodLabels = {
    connect: status?.connected ? t('Import notes') : t('Connect Granola'),
    csv: t('Choose CSV'),
    key: found ? t('Import notes') : t('Find meetings'),
  }
  const label = phase === 'connecting' ? t('Cancel') : next ? t('Continue') : problem ? t('Try again') : methodLabels[method]
  // Keep keyboard focus on the chosen radio while switching methods.
  useFocus(primary, [phase, !!status, done])
  const mainAction = () => {
    if (!status) retryStatus()
    else if (phase === 'connecting') void window.yogurt.granola.cancelConnect()
    else if (next) onNext()
    else if (method === 'csv') choose()
    else if (method === 'key') { if (found) void act(() => window.yogurt.granola.importApi()); else void find() }
    else void act(() => status?.connected ? window.yogurt.granola.importConnected() : window.yogurt.granola.connect(true))
  }
  const disabled = !status ? !error : !next && phase !== 'connecting' && (busy || (selectingKey && !key.trim()))
  return <Layout testId="granola-onboarding" step="granola" motionKey="granola" state={state} progress={progress}
    title={title} text={text} art={<GranolaArt status={status} />} artLabel={status?.result?.added ? t('Your meetings') : undefined}
    chooser={picking && <fieldset className="granola-picker"><legend className="sr-only">{t('Import')}</legend>
      {(['connect','csv','key'] as const).map(id => <label key={id}>
        <input type="radio" className="sr-only" name="granola-method" checked={id === method} onChange={() => select(id)} />
        {id === 'connect' ? t('Connect') : id === 'csv' ? 'CSV' : t('API key')}
      </label>)}
    </fieldset>}
    actions={<form className="granola-actions" onSubmit={e => { e.preventDefault(); if (!disabled) mainAction() }}>
      {selectingKey && <input type="password" autoComplete="off" spellCheck={false} className="settings-name-field" placeholder={t('API key')} aria-label={t('API key')} aria-describedby="step-reason" value={key} onChange={e => setKey(e.target.value)} />}
      <div>
        <button ref={primary} className="ob-button primary no-drag" disabled={disabled}>{label}</button>
        {!next && phase !== 'connecting' && <button type="button" className="ob-button quiet no-drag" onClick={onNext}>{t('Skip')}</button>}
      </div>
    </form>}
    note={<div className="ob-note">
      <div role="status" aria-live="polite">
        <span className="sr-only">{title}</span>
        {(active || problem) && count && <p>{count}</p>}
        {phase === 'waiting' && <p>{background}</p>}
        {done && !!result?.skipped && <p>{t('{count} were already here.', { count: result.skipped })}</p>}
        {result && result.failures.length > 0 && <details><summary>{t('Failed imports · {n}', { n: result.failures.length })}</summary>
          <ul>{result.failures.map((f,i) => <li key={i}>{f.title} — {f.reason}</li>)}</ul></details>}
      </div>
      {input}
      {done && (status?.notice || !result?.total || result.failures.length > 0) && <button className="text-action no-drag" disabled={busy} onClick={() => { select('csv'); choose() }}>{t('Import a CSV')}</button>}
    </div>}
  />
}

/** What Yogurt is, in the website's words */
function Welcome({ state, progress, onDone }: { state: SetupState; progress: Progress; onDone(): void }) {
  const c = screenCopy('welcome')
  const primary = useRef<HTMLButtonElement>(null)
  useFocus(primary, [])
  return (
    <Layout
      testId="intro-page" step="welcome" motionKey="welcome" art={<WelcomeArt />} title={c.title} text={c.text} progress={progress} state={state}
      actions={<button ref={primary} data-testid="intro-next" onClick={onDone} className="ob-button primary no-drag">{t('Get started')}</button>}
    />
  )
}

/**
 * Windows and Linux: the calendar screen asks for a calendar link instead of a permission, with the very form Settings
 * shows (CalendarLinkForm), so the steps for Google and Outlook are written once.
 */
function CalendarLinkScreen({ state, progress, onNext }: { state: SetupState; progress: Progress; onNext(): void }) {
  const [connected, setConnected] = useState<string | null>(null)
  const sc = screenCopy('calendar')
  const primary = useRef<HTMLButtonElement>(null)
  useFocus(primary, [connected])
  return (
    <Layout
      testId="onboarding-step" step="calendar" kind="calendar" motionKey={connected ? 'calendar-done' : 'calendar'}
      art={<ScreenArt kind="calendar" />} progress={progress} state={state}
      title={connected ? t('All set') : t('Connect your calendar')}
      text={connected ? t('{name} is connected. You can change this any time in Settings.', { name: connected }) : sc.text}
      actions={connected
        ? <button ref={primary} data-testid="step-allow" onClick={onNext} className="ob-button primary no-drag">{t('Continue')}</button>
        : <CalendarLinkForm variant="onboarding" onConnected={setConnected} onCancel={onNext}
          extra={<button type="button" data-testid="step-later" onClick={onNext} className="ob-button quiet no-drag">{t('Not now')}</button>} />}
    />
  )
}

/** Recording permissions share one progress segment. Each native request needs its own Allow press. */
function PermissionScreen({ screen, state, progress, onNext }: { screen: OnboardingScreen; state: SetupState; progress: Progress; onNext(): void }) {
  const [k, setK] = useState(0)
  const [leaving, setLeaving] = useState(false)
  const step = screen.steps[k]
  const on = () => {
    if (k + 1 < screen.steps.length) { setK(k + 1); return }
    // Keep the existing transition out of the grouped recording step.
    if (screen.kinds.length > 1) { setLeaving(true); setTimeout(onNext, 700) } else onNext()
  }
  return <Ask key={step.kind} screen={screen} step={step} leaving={leaving} state={state} progress={progress} onOn={on} onLater={onNext} />
}

function Ask({ screen, step, leaving, state, progress, onOn, onLater }: {
  screen: OnboardingScreen; step: OnboardingStep; leaving: boolean; state: SetupState; progress: Progress; onOn(): void; onLater(): void
}) {
  const { kind } = step
  const c = permissionCopy(kind)
  const sc = screenCopy(kind)
  const flow = usePermissionFlow(kind, step.status, onOn)
  const away = flow.phase === 'away'
  const back = flow.phase === 'back'
  const busy = flow.phase === 'asking' || leaving
  const primary = useRef<HTMLButtonElement>(null)
  useFocus(primary, [kind, flow.phase])
  const denied = flow.status === 'denied'
  const label = back ? t('Continue') : away || denied ? t('Open System Settings') : t('Allow')
  const note = away ? <GuideNote kind={kind} />
    : flow.phase === 'failed' ? <p data-testid="step-access-status" role="status" className="ob-note">{t("Couldn't check access. Try again.")}</p>
      : flow.phase === 'idle' && denied ? <p data-testid="step-access-status" role="status" className="ob-note">{t('This was turned off before, so only System Settings can turn it on. Yogurt shows you where.')}</p>
        : null
  // the picture changes only when there is a new thing to show: System Settings, or the screen's own drawing
  const art = away ? <SettingsArt kind={kind} /> : <ScreenArt kind={kind} />
  return (
    <Layout
      testId="onboarding-step" step={screen.id} kind={kind} motionKey={away ? `${screen.id}-away` : screen.id}
      art={art} progress={progress} state={state} note={note}
      title={away ? t('Turn on Yogurt in System Settings') : back ? t('All set') : sc.title}
      text={away ? c.where : back ? t('{name} is on. You can change this any time in Settings.', { name: c.name }) : sc.text}
      actions={<>
        <button ref={primary} data-testid="step-allow" aria-describedby="step-reason" disabled={busy}
          onClick={() => (back ? onOn() : away ? void flow.openSettings() : void flow.allow())} className="ob-button primary no-drag">
          {flow.phase === 'asking' && <LoaderCircle size={14} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />}{label}
        </button>
        {!back && <button data-testid="step-later" disabled={busy} onClick={onLater} className="text-action no-drag">{t('Not now')}</button>}
      </>}
    />
  )
}

/** Under the buttons while System Settings is open: that Yogurt notices by itself, what to do if it isn't listed, and a reopen for the ones that need it */
function GuideNote({ kind }: { kind: PermissionKind }) {
  const [failed, setFailed] = useState(false)
  return (
    <div data-testid="settings-guide" className="ob-note">
      <p data-testid="settings-guide-waiting" role="status" className="ob-note-line">{t('Access is checked automatically.')}</p>
      <details key={kind} className="ob-guide-help">
        <summary>{t('Still not working?')}</summary>
        <div className="ob-guide-help-content">
        {(kind === 'accessibility' || kind === 'systemAudio') && <p>{t('Not in the list? Click +, then choose Yogurt in Applications.')}</p>}
        <p>{t('If you turned access on and this stays open, restart Yogurt.')}</p>
        <button data-testid="settings-guide-relaunch" className="workspace-button no-drag" onClick={() => {
          void window.yogurt.permissions.relaunch().then((ok) => setFailed(!ok), () => setFailed(true))
        }}>{t('Restart Yogurt')}</button>
      </div>
      </details>
      {failed && <p role="alert" className="ob-note-line ob-note-error">{t("Yogurt couldn't reopen. Quit it from the menu bar and open it again.")}</p>}
    </div>
  )
}

/** Speech setup: no choices to make. Home takes over when recording is ready; the notes model can arrive later. */
function Ready({ state }: { state: SetupState }) {
  const [shown, setShown] = useState(0)
  const pct = Math.floor(shown * 100 + 1e-8)
  const error = state.phase === 'error'
  const c = screenCopy('ready')
  return (
    <Layout
      testId="setup-ready" motionKey={error ? 'error' : 'ready'} art={<ReadyArt fraction={state.fraction} paused={error} onShown={setShown} />}
      title={error ? t("Couldn't finish setting up") : c.title} text={error ? state.message ?? '' : c.text} textTestId={error ? 'setup-error' : undefined}
      actions={error ? (
        <button data-testid="setup-retry" className="ob-button primary no-drag" onClick={() => void window.yogurt.setup.retry()}>{t('Try again')}</button>
      ) : (
        <div className="ob-progress">
          <div data-testid="setup-progress" role="progressbar" aria-label={transcriptionPhase(state)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="ob-progress-track">
            <div className="ob-progress-fill" style={{ transform: `scaleX(${pct / 100})` }} />
          </div>
          <p role="status" data-testid="setup-percent" className="ob-progress-label tabular-nums">
            <span>{transcriptionPhase(state)}</span><span className="ob-progress-percent">{transcriptionPercent({ ...state, fraction: shown + Number.EPSILON })}</span>
          </p>
        </div>
      )}
    />
  )
}
