import { FolderGlyph } from './FolderAppearance'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Check, FolderIcon, Minus, Plus, X } from 'lucide-react'
import type { Folder, MeetingCard } from '../../../shared/types'
import { t } from '../../../shared/i18n'
import { setMeetingsInFolder, useFolders } from '../folders'
import { folderCheck, nextFolderCheck, reconcileFolderChecks, type FolderMemberships, type PendingFolderChecks } from '../folderSelection'
import { toasts } from './TrashToast'
import { motion, useReducedMotion, usePopoverPresence } from '../motion'

export type FolderSuggestion = { folder: Folder; dismiss: () => void }

/**
 * A full check removes the selection; an empty or mixed check adds it. The picker stays open for the next toggle.
 */
export function FolderPicker({ meetingId, meetingIds, memberships, suggestedId, onNew, testId, autoFocus = false }: { autoFocus?: boolean; meetingId?: string; meetingIds?: string[]; memberships?: FolderMemberships; suggestedId?: string; onNew: () => void; testId: string }) {
  const all = useFolders()
  const list = useRef<HTMLDivElement>(null)
  const loaded = all !== undefined
  useEffect(() => {
    if (autoFocus && loaded) list.current?.querySelector<HTMLElement>('[role="menuitemcheckbox"], [role="menuitem"]')?.focus()
  }, [autoFocus, loaded])
  const mine = useFolders(memberships ? null : meetingId)
  const ids = useMemo(() => meetingIds ?? (meetingId ? [meetingId] : []), [meetingIds, meetingId])
  const real = useMemo(() => memberships ?? { [meetingId ?? '']: mine?.map(folder => folder.id) ?? [] }, [memberships, meetingId, mine])
  const [pending, setPending] = useState<PendingFolderChecks>({})
  const saving = useRef(false)
  const busy = Object.values(pending).some(change => change.saving)
  useEffect(() => { setPending(p => reconcileFolderChecks(p, ids, real)) }, [ids, real, pending])
  const inIt = (id: string) => id in pending ? pending[id].checked : folderCheck(ids, real, id)
  const toggle = async (id: string) => {
    if (saving.current || !ids.length || (!memberships && !mine)) return
    const on = nextFolderCheck(inIt(id))
    saving.current = true
    setPending(p => ({ ...p, [id]: { checked: on, saving: true, source: real } }))
    try {
      await setMeetingsInFolder(id, ids, on)
      setPending(p => ({ ...p, [id]: { ...p[id], saving: false } }))
    } catch {
      setPending(p => { const next = { ...p }; delete next[id]; return next })
      toasts.add({ title: t("Yogurt couldn't make that change. Try again.") })
    } finally { saving.current = false }
  }
  const row = 'flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-start text-sm hover:bg-[var(--line)] focus-visible:bg-[var(--line)] focus-visible:outline-none'
  const ordered = suggestedId ? all?.filter(s => s.id === suggestedId).concat(all.filter(s => s.id !== suggestedId)) : all
  return <div ref={list} data-testid={testId} role="group" aria-label={t('Folders')}>
    {ordered?.map((s) => <button key={s.id} role="menuitemcheckbox" aria-checked={inIt(s.id)} aria-disabled={busy || (!memberships && !mine)} data-testid="folder-option" onClick={() => void toggle(s.id)} className={row}>
      <FolderGlyph appearance={s} size={15} />
      <span className="min-w-0 flex-1 truncate">{s.name}</span>
      {s.id === suggestedId && <span className="shrink-0 text-[10px] text-muted">{t('Suggested')}</span>}
      {inIt(s.id) === true && <Check size={15} aria-hidden="true" className="shrink-0 text-accent" />}
      {inIt(s.id) === 'mixed' && <Minus size={15} aria-hidden="true" className="shrink-0 text-accent" />}
    </button>)}
    <button role="menuitem" data-testid="folder-new" disabled={busy} onClick={onNew} className={`${row} ${all?.length ? 'folder-picker-new' : ''}`}>
      <Plus size={15} aria-hidden="true" className="shrink-0 text-muted" />{t('New folder…')}
    </button>
  </div>
}

/**
 * The note's folders chip, beside its date and people: the folders it is in, or Add to folder. It opens the same list
 * as the note's menu.
 */
export function FolderChip({ meetingId, onNew, suggestion: manualSuggestion, row, rowFolders, children, onChoose }: { meetingId: string; onNew?: () => void; suggestion?: FolderSuggestion; row?: boolean; rowFolders?: MeetingCard['folders']; children?: ReactNode; onChoose?: (folderId: string) => void }) {
  const [automatic, setAutomatic] = useState<Folder | null>(null)
  useEffect(() => {
    setAutomatic(null)
    let seq = 0
    const load = () => {
      const current = ++seq
      void window.yogurt.folders.suggestion(meetingId).then(folder => { if (current === seq) setAutomatic(folder) }, () => {})
    }
    load()
    const off = window.yogurt.folders.onChange(load), offMeetings = window.yogurt.meetings.onChange(load)
    return () => { seq++; off(); offMeetings() }
  }, [meetingId])
  const suggestion = manualSuggestion ?? (automatic ? { folder: automatic, dismiss: () => setAutomatic(null) } : undefined)
  const mine = useFolders(row ? null : meetingId)
  const folders = row ? rowFolders : mine
  const reduced = useReducedMotion()
  const [transition, setTransition] = useState<{ folder: Folder; phase: 'saving' | 'accepted' | 'dismissed' | 'settled' } | null>(null)
  const [adding, setAdding] = useState(false)
  const [open, setOpen] = useState<false | 'pointer' | 'keyboard'>(false)
  const presence = usePopoverPresence(open, open === 'pointer')
  const root = useRef<HTMLDivElement>(null)
  const chip = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (suggestion && folders?.length) suggestion.dismiss()
    if (transition?.phase === 'settled' && folders?.length) setTransition(null)
  }, [folders, suggestion, transition])
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])
  const key = (e: KeyboardEvent) => {
    const list = Array.from(root.current?.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"], [role="menuitem"]') ?? [])
    const at = list.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); chip.current?.focus() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); list[(at + 1) % list.length]?.focus() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(at - 1 + list.length) % list.length]?.focus() }
    else if (e.key === 'Tab') setOpen(false)
  }
  // Hold the clicked pill through independent suggestion/membership refreshes and the exit motion.
  const held = transition && !(transition.phase === 'settled' && folders?.length) ? transition : null
  const proposed = held?.folder ?? (folders?.length === 0 ? suggestion?.folder : undefined)
  const accepted = held?.phase === 'accepted' || held?.phase === 'settled'
  const label = proposed?.name ?? (!folders?.length ? t('Add to folder') : folders.length === 1 ? folders[0].name : t('{name} + {more}', { name: folders[0].name, more: folders.length - 1 }))
  const focusAfterSuggestion = () => row ? root.current?.closest('li')?.querySelector<HTMLButtonElement>('.native-meeting-link') : chip.current
  const clearSuggestion = (focus: HTMLButtonElement | null | undefined) => {
    toasts.close(`folder-suggestion-${meetingId}`); suggestion?.dismiss()
    setAutomatic(null); setOpen(false)
    requestAnimationFrame(() => { if (document.activeElement === document.body) (row ? focus : chip.current)?.focus({ preventScroll: true }) })
  }
  const dismissSuggestion = async () => {
    if (!proposed || adding || held) return
    const focus = focusAfterSuggestion()
    setAdding(true); setTransition({ folder: proposed, phase: 'saving' })
    try { await window.yogurt.folders.dismissSuggestion(meetingId); setTransition({ folder: proposed, phase: 'dismissed' }); clearSuggestion(focus) }
    catch { setTransition(null); toasts.add({ title: t("Yogurt couldn't make that change. Try again.") }) }
    finally { setAdding(false) }
  }
  const confirmSuggestion = async () => {
    if (!proposed || adding || held) return
    const focus = focusAfterSuggestion()
    const folderId = proposed.id
    setTransition({ folder: proposed, phase: 'saving' })
    setAdding(true); toasts.close(`folder-suggestion-${meetingId}`)
    try {
      await window.yogurt.folders.add(folderId, meetingId)
      // The folder may have disappeared since the proposal; never show a silent no-op as accepted.
      if (!(await window.yogurt.folders.of(meetingId)).some((folder) => folder.id === folderId)) throw new Error('Folder not added')
      setTransition({ folder: proposed, phase: 'accepted' }); clearSuggestion(focus)
    } catch {
      setTransition(null)
      toasts.add({ id: `folder-suggestion-${meetingId}`, data: { testId: 'folder-suggestion-error' }, title: t("Yogurt couldn't add this note to the folder. Try again.") })
    } finally { setAdding(false) }
  }
  useEffect(() => {
    if (!transition || transition.phase === 'saving' || transition.phase === 'settled') return
    const focus = focusAfterSuggestion()
    const finish = () => {
      setTransition(transition.phase === 'accepted' ? { ...transition, phase: 'settled' } : null)
      requestAnimationFrame(() => { if (document.activeElement === document.body) (row ? focus : chip.current)?.focus({ preventScroll: true }) })
    }
    const timer = setTimeout(finish, reduced ? motion.micro : motion.base)
    return () => clearTimeout(timer)
  }, [transition, reduced])
  const appearance = proposed ?? (folders?.length === 1 ? folders[0] : undefined)
  if (row && !proposed) return children
  const trigger = <button ref={chip} data-testid="note-folders" aria-haspopup="menu" aria-expanded={onChoose ? undefined : !!open} onClick={(e) => { if (onChoose && proposed) onChoose(proposed.id); else setOpen((o) => o ? false : e.detail > 0 ? 'pointer' : 'keyboard') }}
    title={proposed?.name ?? (folders?.map((s) => s.name).join(', ') || undefined)}
    className={proposed ? 'note-folder-name' : 'note-chip flex max-w-64 items-center gap-1.5 rounded-md border border-line px-2.5 text-[13px] text-muted'}>
    {row && proposed ? <span className="meeting-folder-dot" data-folder-color={proposed.color} aria-hidden="true" /> : appearance ? <FolderGlyph appearance={appearance} size={14} /> : <FolderIcon size={14} aria-hidden="true" className="shrink-0" />}<span data-testid="note-folders-summary" className="truncate">{label}</span>
  </button>
  return (
    <div ref={root} className={row ? 'meeting-folder-suggestion' : 'relative'} onClick={row ? e => e.stopPropagation() : undefined}>
      {proposed ? <div data-testid="folder-suggestion" role="group" aria-label={accepted ? t('Folders') : t('Suggested')} inert={held?.phase === 'dismissed'} data-phase={held?.phase} className={row ? 'meeting-folder-pill meeting-folder-proposal' : 'note-chip note-folder-proposal flex items-center rounded-md border border-line text-[13px] text-muted'}>
        {trigger}
        <div className="note-folder-actions" inert={accepted || held?.phase === 'dismissed'}>
          <button data-testid="folder-suggestion-cancel" className="workspace-icon" disabled={adding || !!held} onClick={() => void dismissSuggestion()} aria-label={t('Dismiss suggestion')} title={t('Dismiss suggestion')}><X size={row ? 12 : 15} aria-hidden="true" /></button>
          <button data-testid="folder-suggestion-confirm" className="workspace-icon" disabled={adding || !!held} onClick={() => void confirmSuggestion()} aria-label={t('Add to folder')} title={t('Add to folder')}><Check size={row ? 12 : 15} aria-hidden="true" /></button>
        </div>
      </div> : trigger}
      {presence.value && <div data-testid="folder-menu" {...presence.props} data-anchor="start" role="menu" aria-label={t('Add to folder')} onKeyDown={key}
        className="menu-entry absolute start-0 top-full z-30 mt-2 max-h-80 w-60 overflow-y-auto rounded-xl border border-line bg-float p-1.5 shadow-[var(--shadow)]">
        <FolderPicker autoFocus testId="folder-chip-list" meetingId={meetingId} suggestedId={proposed?.id} onNew={() => { setOpen(false); onNew?.() }} />
      </div>}
    </div>
  )
}
