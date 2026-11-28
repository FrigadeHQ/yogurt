// Transcript lab. Which version the transcript shows, the extra models' readings side
// by side, and the person's fixes, which measure the models.
import { Fragment, useCallback, useEffect, useMemo, useState, type SVGProps } from 'react'
import { Check, Pencil, Play, Square, X } from './Icons'

/** Compare's three columns, drawn like upstream's rounded set (its Icons.tsx has no Columns3). */
function Columns3({ size = 16, ...props }: SVGProps<SVGSVGElement> & { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" data-icon="Columns3" {...props}>
    <path d="M2.5 12C2.5 7.52166 2.5 5.28249 3.89124 3.89124C5.28249 2.5 7.52166 2.5 12 2.5C16.4783 2.5 18.7175 2.5 20.1088 3.89124C21.5 5.28249 21.5 7.52166 21.5 12C21.5 16.4783 21.5 18.7175 20.1088 20.1088C18.7175 21.5 16.4783 21.5 12 21.5C7.52166 21.5 5.28249 21.5 3.89124 20.1088C2.5 18.7175 2.5 16.4783 2.5 12Z" />
    <path d="M9 2.5V21.5" /><path d="M15 2.5V21.5" />
  </svg>
}
import type { LabScores, LabView, LabWindow } from '../../../shared/lab'
import { align, keyOf, words } from '../../../shared/labCombine'
import { clock } from '../../../shared/transcript'
import './TranscriptLab.css'

const LIVE = 'live', COMBINED = 'combined'

/** the lab's view of a meeting, read again whenever the main process says it changed */
export function useLab(id: string) {
  const [enabled, setEnabled] = useState(false)
  const [view, setView] = useState<LabView | null>(null)
  useEffect(() => { void window.yogurt.lab.enabled().then(setEnabled) }, [])
  const load = useCallback((active: () => boolean) => { void window.yogurt.lab.view(id).then((v) => { if (active()) setView(v) }) }, [id])
  useEffect(() => {
    if (!enabled) return
    let active = true
    setView(null)
    load(() => active)
    const off = window.yogurt.lab.onChanged((m) => { if (m === id) load(() => active) })
    return () => { active = false; off() }
  }, [enabled, id, load])
  return { enabled, view }
}

const percent = (s?: { errors: number; words: number }) => (s && s.words ? `${((100 * s.errors) / s.words).toFixed(1)}%` : '')

/** The bar over the transcript: the version shown, what the lab is doing, run and compare */
export function LabBar({ id, view, comparing, onCompare }: { id: string; view: LabView | null; comparing: boolean; onCompare: (on: boolean) => void }) {
  const [scores, setScores] = useState<LabScores>({})
  // the scores move only when a run ends or a fix changes, not at each step of a run
  const fixes = view?.windows.map((w) => w.fixed ?? '').join('\u0000') ?? ''
  const state = view?.status.state
  useEffect(() => { if (state !== 'running' && state !== 'queued') void window.yogurt.lab.scores().then(setScores) }, [state, fixes])
  if (!view) return null
  const st = view.status
  const busy = st.state === 'running' || st.state === 'queued'
  const versions = [{ id: LIVE, label: 'Live' }, ...(view.windows.some((w) => w.combined) ? [{ id: COMBINED, label: 'Combined' }] : []),
    ...view.models.filter((m) => Object.keys(view.readings[m.id] ?? {}).length).map((m) => ({ id: m.id, label: m.label }))]
  // the version shown is always on the list, even when its readings are gone, so another can be picked
  if (!versions.some((v) => v.id === st.using)) versions.push({ id: st.using, label: st.using })
  const label = (v: { id: string; label: string }) => (scores[v.id]?.words ? `${v.label} (${percent(scores[v.id])} errors)` : v.label)
  return (
    <div className="lab-bar" data-testid="lab-bar">
      <select aria-label="Transcript version" value={st.using} disabled={busy || versions.length < 2} onChange={(e) => void window.yogurt.lab.use(id, e.target.value)} className="lab-select">
        {versions.map((v) => <option key={v.id} value={v.id}>{label(v)}</option>)}
      </select>
      <span className="lab-status" aria-live="polite">
        {st.state === 'queued' && 'Waiting to read again…'}
        {st.state === 'running' && `Reading again: ${st.step ?? ''}…`}
        {st.state === 'failed' && <span className="text-danger" title={st.error}>Lab: {st.error}</span>}
      </span>
      {busy
        ? <button className="ghost-btn" onClick={() => void window.yogurt.lab.stop(id)} title="Stop the extra models on this meeting"><Square size={13} aria-hidden="true" />Stop</button>
        : <button className="ghost-btn" onClick={() => void window.yogurt.lab.run(id)} title="Read the recording again with every model"><Play size={13} aria-hidden="true" />Run models</button>}
      {view.windows.length > 0 && <button className="ghost-btn" aria-pressed={comparing} onClick={() => onCompare(!comparing)} title="Compare the models' readings"><Columns3 size={13} aria-hidden="true" />{comparing ? 'Transcript' : 'Compare'}</button>}
    </div>
  )
}

/** for each word of `text`, whether `other` has a different word (or none) there */
function differs(text: string[], other: string[]): boolean[] {
  const out = text.map(() => false)
  for (const [x, y] of align(text, other)) if (x !== null && (y === null || keyOf(text[x]) !== keyOf(other[y]))) out[x] = true
  return out
}

/** words with some of them marked */
function Marked({ ws, marks, className, title }: { ws: string[]; marks: boolean[]; className: string; title?: string }) {
  return <>{ws.map((w, i) => <Fragment key={i}>{i > 0 && ' '}{marks[i] ? <mark className={className} title={title}>{w}</mark> : w}</Fragment>)}</>
}

/** One stretch: the text shown with the words some model heard otherwise, the models' readings when opened, the person's fix */
function Stretch({ id, w, view }: { id: string; w: LabWindow; view: LabView }) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const shown = w.fixed ?? w.combined ?? w.texts.join(' ')
  const rows = useMemo(() => [{ id: LIVE, label: 'Live', text: w.texts.join(' ') },
    ...view.models.map((m) => ({ id: m.id, label: m.label, text: view.readings[m.id]?.[w.key] })).filter((r): r is { id: string; label: string; text: string } => r.text !== undefined)], [w, view])
  const shownWords = useMemo(() => words(shown), [shown])
  // a word is disputed when one of the models (live left out) heard something else there
  const disputed = useMemo(() => {
    const out = shownWords.map(() => false)
    for (const r of rows) if (r.id !== LIVE) differs(shownWords, words(r.text)).forEach((d, i) => { if (d) out[i] = true })
    return out
  }, [rows, shownWords])
  const count = disputed.filter(Boolean).length
  const save = (text: string | null) => { void window.yogurt.lab.fix(id, w.key, text); setEditing(null) }
  return (
    <li className="lab-stretch" data-testid="lab-stretch">
      <div className="lab-stretch-head">
        <span className="lab-time">{clock(w.startMs)}</span>
        <span className="lab-who">{w.track === 'me' ? 'You' : w.speaker || 'Them'}</span>
        {w.language && <span className="lab-lang">{w.language}</span>}
        {w.fixed && <span className="lab-fixed" title="Your text: the models are measured against it"><Check size={12} aria-hidden="true" />fixed</span>}
        <span className="flex-1" />
        <button className="ghost-btn !px-1.5" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Hide models' : count ? `${count} disputed` : 'Models'}</button>
        <button className="ghost-btn !px-1.5" onClick={() => setEditing(shown)} title="Write what was really said"><Pencil size={12} aria-hidden="true" />Fix</button>
      </div>
      {editing === null
        ? <p className="lab-text">{w.fixed ? w.fixed : <Marked ws={shownWords} marks={disputed} className="lab-disputed" title="Some model heard something else here" />}</p>
        : <div className="lab-edit">
            <textarea value={editing} onChange={(e) => setEditing(e.target.value)} rows={Math.min(8, Math.ceil(editing.length / 70) + 1)} autoFocus />
            <div className="flex gap-2">
              <button className="ghost-btn" onClick={() => save(editing.trim() || null)}><Check size={13} aria-hidden="true" />Save</button>
              {w.fixed && <button className="ghost-btn" onClick={() => save(null)}>Remove my fix</button>}
              <button className="ghost-btn" onClick={() => setEditing(null)}><X size={13} aria-hidden="true" />Cancel</button>
            </div>
          </div>}
      {open && <table className="lab-readings"><tbody>
        {rows.map((r) => { const ws = words(r.text); return <tr key={r.id}>
          <th scope="row">{r.label}</th>
          <td><Marked ws={ws} marks={differs(ws, shownWords)} className="lab-diff" /></td>
          <td><button className="ghost-btn !px-1" title="Use this reading as my fix" onClick={() => save(r.text)}>Use</button></td>
        </tr> })}
      </tbody></table>}
    </li>
  )
}

/** Every stretch, to compare and fix */
export function LabCompare({ id, view }: { id: string; view: LabView }) {
  return (
    <ol className="lab-compare flex flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4 pt-2 text-sm leading-[1.55]" data-testid="lab-compare">
      {view.windows.map((w) => <Stretch key={w.key} id={id} w={w} view={view} />)}
    </ol>
  )
}
