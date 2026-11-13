import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom'
import { ChevronRight, Ellipsis, FolderIcon, ListChecks, Trash2 } from 'lucide-react'
import { t } from '../../../shared/i18n'
import { deleteMeetingFromKey } from '../meetingRowKeys'
import { FolderPicker } from './FolderPicker'
import { FolderName } from './FolderDialogs'
import { addMeetingsToFolder } from '../folders'
import type { FolderMemberships } from '../folderSelection'
import { toasts } from './TrashToast'

/** Metadata and actions share the trailing column without moving the row content. */
export function MeetingRow({ id, recording, children, selected, targets, memberships, busy, onSelect, onClick, onTrash }: {
  id: string; recording: boolean; children: (openFolders: (suggestedId: string) => void, more: ReactNode) => ReactNode; selected: boolean; targets: string[]; busy: boolean
  memberships: FolderMemberships
  onSelect: () => void; onClick: (event: MouseEvent) => void; onTrash: (ids: string[]) => void
}) {
  const row = useRef<HTMLLIElement>(null), button = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState<'button' | { x: number; y: number } | null>(null)
  const [inFolders, setInFolders] = useState(false), [namingFolder, setNamingFolder] = useState(false)
  const [suggestedId, setSuggestedId] = useState<string>()
  const folderTargets = suggestedId ? [id] : targets
  const menuId = useId()
  const focusRow = () => row.current?.querySelector<HTMLButtonElement>('.native-meeting-link')?.focus({ preventScroll: true })
  const close = () => { setOpen(null); focusRow() }
  const show = (anchor: NonNullable<typeof open>) => { setSuggestedId(undefined); setInFolders(false); setOpen(anchor) }

  useLayoutEffect(() => {
    if (!open || !button.current || !menu.current) return
    const popup = menu.current
    const anchor = open === 'button' ? button.current : { getBoundingClientRect: () => new DOMRect(open.x, open.y, 0, 0), contextElement: row.current! }
    let live = true, focus = true
    const update = () => { void computePosition(anchor, popup, { strategy: 'fixed', placement: open === 'button' ? 'bottom-end' : 'bottom-start', middleware: [offset(open === 'button' ? 6 : 0), flip(), shift({ padding: 8 })] }).then(({ x, y }) => {
      if (!live) return
      Object.assign(popup.style, { left: `${x}px`, top: `${y}px`, visibility: 'visible' })
      if (focus) { focus = false; popup.querySelector<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]')?.focus({ preventScroll: true }) }
    }) }
    const stop = autoUpdate(anchor, popup, update)
    return () => { live = false; stop() }
  }, [open, inFolders])
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => { if (!menu.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(null) }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open])
  const menuKey = (e: KeyboardEvent) => {
    const items = Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled), [role="menuitemcheckbox"]:not(:disabled)') ?? [])
    const at = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus() }
    else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); items[e.key === 'Home' ? 0 : items.length - 1]?.focus() }
    else if (e.key === 'Tab') close()
  }
  return <li ref={row} className="native-meeting-row row-swap" data-menu-open={!!open} data-selected={selected}
    onClickCapture={e => { if (row.current?.contains(e.target as Node) && (e.target as HTMLElement).closest('.native-meeting-link')) onClick(e) }}
    onContextMenu={(e) => { if (!row.current?.contains(e.target as Node)) return; e.preventDefault(); show({ x: e.clientX, y: e.clientY }) }}
    onKeyDown={(e) => {
      if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); const box = row.current!.getBoundingClientRect(); show({ x: box.left + 20, y: box.bottom }); return }
      deleteMeetingFromKey(e, e.target === row.current?.querySelector('.native-meeting-link'), busy || (recording && !selected), () => onTrash(targets))
    }}>
    {children(folderId => { setSuggestedId(folderId); setInFolders(true); setOpen('button') },
    <button ref={button} data-testid="past-note-more" className="workspace-icon meeting-more row-swap-actions" aria-label={t('More')} title={t('More')} aria-haspopup="menu" aria-expanded={!!open} aria-controls={open ? menuId : undefined}
      onClick={() => open ? close() : show('button')}><Ellipsis size={14} aria-hidden="true" /></button>)}
    {open && createPortal(<div ref={menu} id={menuId} data-testid="meeting-row-menu" role="menu" aria-label={t('More')} onKeyDown={menuKey}
      className="menu-entry meeting-row-menu" style={{ visibility: 'hidden' }}>
      {inFolders ? <FolderPicker key={folderTargets.join(',')} meetingIds={folderTargets} memberships={memberships} suggestedId={memberships[id]?.length ? undefined : suggestedId} testId="meeting-row-folders" onNew={() => { close(); setNamingFolder(true) }} /> : <>
        {!selected && <><button role="menuitem" data-testid="meeting-select" onClick={() => { onSelect(); close() }}><ListChecks size={15} aria-hidden="true" />{t('Select')}</button><div role="separator" className="meeting-menu-divider" /></>}
        <button role="menuitem" aria-haspopup="menu" onClick={() => setInFolders(true)}><FolderIcon size={15} aria-hidden="true" /><span className="flex-1">{selected ? t('Add {count} meetings to folder', { count: targets.length }) : t('Add to folder')}</span><ChevronRight size={14} aria-hidden="true" className="rtl:-scale-x-100" /></button>
        <button role="menuitem" data-testid="past-note-trash" disabled={busy || (recording && !selected)} title={recording ? t('Stop the recording first') : undefined} className="text-danger" onClick={() => { close(); onTrash(targets) }}><Trash2 size={15} aria-hidden="true" />{selected ? t('Move {count} meetings to Trash', { count: targets.length }) : t('Move to Trash')}</button>
      </>}
    </div>, document.body)}
    {namingFolder && <FolderName onDone={(made) => {
      setNamingFolder(false); focusRow()
      if (made) void addMeetingsToFolder(made.id, folderTargets).catch(() => toasts.add({ title: t("Yogurt couldn't make that change. Try again.") }))
    }} />}
  </li>
}
