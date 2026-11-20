import { usePopoverPresence } from '../motion'
import { retryToast, toasts } from './TrashToast'
import { Copy } from './Icons'
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Check, CircleAlert, FileDown, ChevronDown } from 'lucide-react'
import { t } from '../../../shared/i18n'
import { command, onMac } from '../keys'
import { flushOpenNotes } from '../noteAutosave'
import { shareTarget } from '../../../shared/exportNotes'
import type { NoteStatus } from '../../../shared/types'

type Feedback = { text: string; kind: 'copied' | 'saved' | 'notice' | 'error' }

/** Copy choices stay beside the meeting controls. Saving before use protects the latest edits. */
export function ShareMenu({ id, shown, status, hasEnhanced, beforeUse }: { id: string; shown: 'mine' | 'enhanced'; status: NoteStatus; hasEnhanced: boolean; beforeUse: () => Promise<boolean> }) {
  const [open, setOpen] = useState<false | 'pointer' | 'keyboard'>(false)
  const presence = usePopoverPresence(open)
  const [said, setSaid] = useState<Feedback>()
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const items = useRef<Array<HTMLButtonElement | null>>([])
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const target = shareTarget(shown, status, hasEnhanced)

  const say = useCallback((text: string, kind: Feedback['kind'] = 'notice') => {
    setSaid({ text, kind })
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setSaid(undefined), 2000)
  }, [])
  // a message belongs to the note it was said in
  useEffect(() => { setSaid(undefined); setOpen(false); return () => clearTimeout(timer.current) }, [id])

  const { side, writing, fellBack } = target
  const copy = useCallback(async (what: 'notes' | 'transcript', selected = shown) => {
    const { side, writing, fellBack } = shareTarget(selected, status, hasEnhanced)
    // the notes are still coming in: what is on screen is not whole, so nothing is copied
    if (what === 'notes' && writing) { say(t('Still generating your summary')); return }
    if (what === 'notes' && !await beforeUse()) { say(t("Couldn't save your latest changes. Try again before copying."), 'error'); return }
    const r = await window.yogurt.share.copy(id, what, side)
    say(r === 'failed' ? t("Couldn't copy. Try again.") : r === 'nothing' ? t('Nothing to copy yet') : what === 'notes' && fellBack ? t('Copied your notes') : t('Copied'),
      r === 'failed' ? 'error' : r === 'nothing' ? 'notice' : 'copied')
  }, [id, shown, status, hasEnhanced, beforeUse, say])
  const exporting = useRef(false)
  const save = async (retry = false) => {
    if (exporting.current) return
    const toastId = 'share-export-error-' + id
    toasts.close(toastId)
    const failed = (message: string) => retryToast(toastId, message, 'share-export-retry', () => save(true), 'share-export-error')
    setSaid(undefined)
    if (writing) { say(t('Still generating your summary')); return }
    exporting.current = true
    try {
      if (!await beforeUse() || (retry && !await flushOpenNotes())) { failed(t("Couldn't save your latest changes. Try again before exporting.")); return }
      if (retry && side === 'enhanced') {
        const current = await window.yogurt.notes.get(id)
        if (shareTarget(side, current.status, current.enhanced != null).writing) {
          failed(t('Still generating your summary'))
          return
        }
      }
      const r = await window.yogurt.share.save(id, side)
      if (r === 'saved') say(fellBack ? t('Saved your notes') : t('Saved'), 'saved')
      else if (r === 'failed') failed(t("Couldn't save the file"))
    } catch { failed(t("Couldn't save the file")) }
    finally { exporting.current = false }
  }
  const run = (fn: () => void) => { setOpen(false); button.current?.focus(); fn() }

  useEffect(() => {
    const key = (e: globalThis.KeyboardEvent) => {
      if (!e.repeat && command(e) && e.shiftKey && !e.altKey && !(onMac() && e.ctrlKey) && e.key.toLowerCase() === 'c') { e.preventDefault(); void copy('notes') }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [copy])

  useEffect(() => {
    if (!open) return
    items.current[0]?.focus()
    const away = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])

  const onMenuKey = (e: KeyboardEvent) => {
    const list = items.current.filter((item) => item && !item.disabled) as HTMLButtonElement[]
    const at = list.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); button.current?.focus() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); list[(at + 1) % list.length]?.focus() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(at - 1 + list.length) % list.length]?.focus() }
    else if (e.key === 'Home') { e.preventDefault(); list[0]?.focus() }
    else if (e.key === 'End') { e.preventDefault(); list.at(-1)?.focus() }
    // Tab leaves from the button, so focus goes on to what follows it
    else if (e.key === 'Tab') { setOpen(false); button.current?.focus() }
  }

  const row = 'flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-start text-sm hover:bg-[var(--line)] focus-visible:bg-[var(--line)] focus-visible:outline-none'
  const copied = said?.kind === 'copied'
  return (
    <div ref={root} className="relative flex items-center gap-1.5">
      {/* Feedback does not resize the titlebar controls or compete with the centered wordmark. */}
      <span data-testid="share-said" data-tone={said?.kind} role="status" aria-live="polite" aria-atomic="true"
        className={`pointer-events-none absolute end-0 top-full z-20 mt-2 flex w-max max-w-[min(280px,calc(100vw-48px))] items-start gap-1.5 rounded-md text-xs text-muted ${said ? 'border border-line bg-float px-2.5 py-1.5 shadow-[var(--shadow-soft)]' : ''}`}>
        {said && <>
          {(said.kind === 'copied' || said.kind === 'saved') && <Check data-testid="share-success" size={12} strokeWidth={1.75} aria-hidden="true" className="mt-px shrink-0" />}
          {said.kind === 'error' && <CircleAlert size={12} strokeWidth={1.75} aria-hidden="true" className="mt-px shrink-0 text-danger" />}
          {said.text}
        </>}
      </span>
      <button ref={button} data-testid="share-button" data-state={copied ? 'copied' : 'idle'} aria-haspopup="menu" aria-expanded={!!open} title={t('Copy and export')}
        onClick={(e) => setOpen((o) => o ? false : e.detail > 0 ? 'pointer' : 'keyboard')} className="ghost-btn">
        {/* the status under the button confirms a copy; the button itself stays put */}
        <Copy size={13} strokeWidth={1.75} aria-hidden="true" />{t('Copy')}
        <ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {presence.value && (
        <div data-testid="share-menu" {...presence.props} role="menu" aria-label={t('Copy and export')} onKeyDown={onMenuKey}
          className="menu-entry absolute end-0 top-full z-30 mt-2 w-60 rounded-xl border border-line bg-float p-1.5 text-ink shadow-[var(--shadow)]">
          <button ref={(el) => { items.current[0] = el }} role="menuitem" data-testid="share-copy-notes" onClick={() => run(() => void copy('notes', 'mine'))} className={row}>
            <Copy size={15} strokeWidth={1.75} aria-hidden="true" className="text-muted" /><span className="flex-1">{t('Copy my notes')}</span>
          </button>
          <button ref={(el) => { items.current[1] = el }} role="menuitem" data-testid="share-copy-summary" disabled={!hasEnhanced && !writing}
            onClick={() => run(() => void copy('notes', 'enhanced'))} className={`${row} disabled:opacity-40`}>
            <Copy size={15} strokeWidth={1.75} aria-hidden="true" className="text-muted" />{t('Copy summary')}
          </button>
          <button ref={(el) => { items.current[2] = el }} role="menuitem" data-testid="share-copy-transcript" onClick={() => run(() => void copy('transcript'))} className={row}>
            <Copy size={15} strokeWidth={1.75} aria-hidden="true" className="text-muted" />{t('Copy transcript')}
          </button>
          <button ref={(el) => { items.current[3] = el }} role="menuitem" data-testid="share-export" onClick={() => run(() => void save())} className={row}>
            <FileDown size={15} strokeWidth={1.75} aria-hidden="true" className="text-muted" />{t('Export Markdown…')}
          </button>
        </div>
      )}
    </div>
  )
}
