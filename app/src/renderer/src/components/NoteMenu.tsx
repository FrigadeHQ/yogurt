import { Tooltip } from '@base-ui/react/tooltip'
import { usePopoverPresence } from '../motion'
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { AudioLines, ChevronRight, Ellipsis, FolderIcon, Pencil, RotateCcw, Trash2 } from 'lucide-react'
import { RegenerateForm } from './RegenerateForm'
import { t } from '../../../shared/i18n'

/** Only show generation when it can produce a summary; explain temporary waits. */
export function summaryAction({ hasSummary, hasContent, recording, busy, downloading, trashed }: {
  hasSummary: boolean; hasContent: boolean; recording: boolean; busy: boolean; downloading: boolean; trashed: boolean
}) {
  if (trashed || (!hasSummary && !hasContent)) return undefined
  return {
    label: hasSummary ? t('Regenerate summary') : t('Generate summary'),
    reason: recording ? t('Available after recording') : downloading ? t('Waiting for Yogurt AI to download') : busy ? t('Writing the summary') : undefined,
  }
}

/** The note's actions share one menu and one anchor for folders and generation. */
export function NoteMenu({ transcription, recording, savePending, onRename, onDelete, folders, trashed, generation, hasSummary, edited, rewriteOpen, setRewriteOpen, onWriteAgain }: {
  transcription?: {reason?:string;run:()=>void}
  recording: boolean; savePending?: boolean; onRename: () => void; onDelete: () => void; folders?: (close: () => void) => ReactNode
  /** in the Trash already: Delete is for good */
  trashed?: boolean
  generation: ReturnType<typeof summaryAction>; hasSummary: boolean; edited: boolean
  rewriteOpen: boolean; setRewriteOpen: (open: boolean) => void; onWriteAgain: (note: string) => void
}) {
  const [open, setOpen] = useState<false | 'pointer' | 'keyboard'>(false)
  const presence = usePopoverPresence(rewriteOpen && generation ? 'rewrite' : open)
  const [inFolders, setInFolders] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const first = useRef<HTMLButtonElement>(null)

  const close = (restore = true) => { setOpen(false); setRewriteOpen(false); if (restore) button.current?.focus({ preventScroll: true }) }
  useEffect(() => { if (!generation) setRewriteOpen(false) }, [!!generation])
  useEffect(() => {
    if (rewriteOpen) root.current?.querySelector('input')?.focus({ preventScroll: true })
    if (!open && !rewriteOpen) { if (!presence.value) setInFolders(false); return }
    if (!rewriteOpen) first.current?.focus()
    const away = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) close(false) }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open, rewriteOpen, presence.value])
  const onKey = (e: KeyboardEvent) => {
    const list = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled), [role="menuitemcheckbox"]') ?? [])
    const at = list.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); button.current?.focus() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); list[(at + 1) % list.length]?.focus() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(at - 1 + list.length) % list.length]?.focus() }
    else if (e.key === 'Tab') setOpen(false)
  }
  const run = (fn: () => void) => { setOpen(false); fn() }

  const row = 'flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-start text-sm hover:bg-[var(--line)] focus-visible:bg-[var(--line)] focus-visible:outline-none disabled:opacity-50 disabled:hover:bg-transparent'
  return (
    <div ref={root} className="relative">
      <button ref={button} data-testid="note-menu-button" aria-haspopup={rewriteOpen ? "dialog" : "menu"} aria-expanded={!!open || rewriteOpen} aria-label={t('More')} title={t('More')}
        onClick={(e) => { if (rewriteOpen) close(); else setOpen((o) => o ? false : e.detail > 0 ? 'pointer' : 'keyboard') }} className="ghost-btn workspace-icon"><Ellipsis size={17} strokeWidth={1.75} aria-hidden="true" /></button>
      {presence.value === 'rewrite' ? (
        <div key="rewrite" role="dialog" data-testid="note-regenerate" aria-label={hasSummary ? t('Regenerate summary') : t('Generate summary')}
          aria-describedby={edited ? 'note-rewrite-description' : undefined} {...presence.props} data-anchor="end"
          className="menu-entry summary-regenerate" onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() } }}>
          <RegenerateForm active={rewriteOpen} hasSummary={hasSummary} edited={edited} disabled={!generation || !!generation.reason}
            onClose={close} onSubmit={(note) => { if (!generation || generation.reason) return; close(); onWriteAgain(note) }} />
        </div>
      ) : presence.value && (
        <div key="menu" data-testid="note-menu" {...presence.props} role="menu" data-anchor="end" aria-label={t('More')} onKeyDown={onKey}
          className="menu-entry absolute end-0 top-full z-30 mt-2 w-max min-w-60 max-w-[calc(100vw-32px)] rounded-xl border border-line bg-float p-1.5 shadow-[var(--shadow)]">
          {inFolders && folders ? folders(() => { setOpen(false); button.current?.focus() }) : <>
          <button ref={first} role="menuitem" data-testid="note-rename" onClick={() => run(onRename)} className={row}>
            <Pencil size={15} strokeWidth={1.75} aria-hidden="true" className="text-muted" />{t('Rename')}
          </button>
          {folders && <button role="menuitem" data-testid="note-add-to-folder" aria-haspopup="menu" onClick={() => {
            setInFolders(true)
            // the list takes the menu's place: keyboard focus moves to its first folder
            requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('[role="menuitemcheckbox"], [role="menuitem"]')?.focus())
          }} className={row}>
            <FolderIcon size={15} aria-hidden="true" className="text-muted" /><span className="flex-1">{t('Add to folder')}</span><ChevronRight size={14} aria-hidden="true" className="text-muted rtl:-scale-x-100" />
          </button>}
          {transcription&&<Tooltip.Root disabled={!transcription.reason}><Tooltip.Trigger delay={180} closeOnClick={false} role="menuitem" data-testid="note-transcribe-again" aria-disabled={!!transcription.reason} aria-description={transcription.reason} onClick={()=>{if(!transcription.reason)run(transcription.run)}} className={`${row} whitespace-nowrap aria-disabled:opacity-50 aria-disabled:hover:bg-transparent`}><AudioLines size={15} className="text-muted" aria-hidden="true"/>{t('Transcribe again')}</Tooltip.Trigger><Tooltip.Portal><Tooltip.Positioner side="left" sideOffset={6} className="z-[80]"><Tooltip.Popup role="tooltip" className="rounded-md border border-line bg-float px-2 py-1 text-xs text-ink shadow-[var(--shadow)]">{transcription.reason}</Tooltip.Popup></Tooltip.Positioner></Tooltip.Portal></Tooltip.Root>}
          {generation && <Tooltip.Root disabled={!generation.reason}><Tooltip.Trigger delay={180} closeOnClick={false} role="menuitem" data-testid="note-write-again" aria-disabled={!!generation.reason}
            aria-description={generation.reason}
            onClick={() => { if (generation.reason) return; setOpen(false); setRewriteOpen(true) }}
            className={`${row} whitespace-nowrap aria-disabled:opacity-50 aria-disabled:hover:bg-transparent`}>
            <RotateCcw size={15} strokeWidth={1.75} aria-hidden="true" className="text-muted" />{generation.label}
          </Tooltip.Trigger>
            <Tooltip.Portal><Tooltip.Positioner side="left" align="center" sideOffset={6} collisionPadding={12} className="z-[80]">
              <Tooltip.Popup role="tooltip" className="rounded-md border border-line bg-float px-2 py-1 text-xs whitespace-nowrap text-ink shadow-[var(--shadow)]">{generation.reason}</Tooltip.Popup>
            </Tooltip.Positioner></Tooltip.Portal>
          </Tooltip.Root>}
          <button role="menuitem" data-testid="note-delete" disabled={recording || savePending} onClick={() => run(() => { button.current?.focus(); onDelete() })} className={`${row} text-danger`}>
            <Trash2 size={15} strokeWidth={1.75} aria-hidden="true" />
            <span className="flex flex-col">
              {trashed ? t('Delete forever') : t('Delete note')}
              {recording && <span className="text-xs text-muted">{t('Stop the recording first')}</span>}
              {savePending && <span className="text-xs text-muted">{t('Finish saving first')}</span>}
            </span>
          </button>
          </>}
        </div>
      )}
    </div>
  )
}
