import { usePopoverPresence } from '../motion'
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom'
import { Folder, Trash2, X } from 'lucide-react'
import { t } from '../../../shared/i18n'
import { addMeetingsToFolder } from '../folders'
import type { FolderMemberships } from '../folderSelection'
import { FolderPicker } from './FolderPicker'
import { FolderName } from './FolderDialogs'
import { toasts } from './TrashToast'

export function MeetingSelectionBar({ ids, memberships, list, busy, clear, trash }: {
  ids: string[]; list: RefObject<HTMLElement | null>; busy: boolean; clear: () => void; trash: () => void
  memberships: FolderMemberships
}) {
  const bar = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false), [naming, setNaming] = useState(false)
  const [pointer, setPointer] = useState(false)
  const presence = usePopoverPresence(open, pointer)
  useLayoutEffect(() => {
    const pane = list.current?.closest<HTMLElement>('.native-library'), el = bar.current
    if (!pane || !el) return
    return autoUpdate(pane, el, () => {
      const box = pane.getBoundingClientRect()
      Object.assign(el.style, { left: `${box.left + box.width / 2}px`, bottom: `${innerHeight - box.bottom + 20}px`, maxWidth: `${box.width - 32}px` })
    })
  }, [list])
  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return
    const anchor = trigger.current, popup = menu.current
    let live = true, focus = true
    const update = () => { void computePosition(anchor, popup, { placement: 'top-start', middleware: [offset(16), flip(), shift({ padding: 8 })] }).then(({ x, y }) => {
      if (!live) return
      Object.assign(popup.style, { left: `${x}px`, top: `${y}px`, visibility: 'visible' })
      if (focus) { focus = false; popup.querySelector<HTMLElement>('[role="menuitemcheckbox"], [role="menuitem"]')?.focus({ preventScroll: true }) }
    }) }
    const stop = autoUpdate(anchor, popup, update)
    return () => { live = false; stop() }
  }, [open])
  useEffect(() => {
    if (!open) return
    const away = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open])
  return createPortal(<>
    <div ref={bar} className="meeting-selection-bar" data-testid="meeting-selection-bar" role="region" aria-label={t('{count} selected', { count: ids.length })}
      onKeyDown={e => { if (e.key === 'Escape' && !open) { e.preventDefault(); e.stopPropagation(); clear(); list.current?.querySelector<HTMLButtonElement>('.native-meeting-link')?.focus() } }}>
      <span className="meeting-selection-count" role="status" aria-live="polite" aria-atomic="true">{t('{count} selected', { count: ids.length })}
        {ids.length === 1 && <small>{t('Click meetings to add more')}</small>}
      </span>
      <div className="meeting-selection-folder">
        <button ref={trigger} className="workspace-button" disabled={busy} aria-haspopup="menu" aria-expanded={open} onClick={e => { setPointer(e.detail > 0); setOpen(!open) }}><Folder size={14} aria-hidden="true" />{t('Add to folder')}</button>
        {presence.value && <div {...presence.props} data-anchor="bottom-start" ref={menu} role="menu" aria-label={t('Add to folder')} className="menu-entry meeting-selection-menu" style={{ visibility: 'hidden' }} onKeyDown={e => {
          const items = Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled), [role="menuitemcheckbox"]:not(:disabled)') ?? [])
          const at = items.indexOf(document.activeElement as HTMLElement)
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); trigger.current?.focus() }
          else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus() }
          else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); items[e.key === 'Home' ? 0 : items.length - 1]?.focus() }
          else if (e.key === 'Tab') setOpen(false)
        }}><FolderPicker key={ids.join(',')} meetingIds={ids} memberships={memberships} testId="selection-folders" onNew={() => { setOpen(false); setNaming(true) }} /></div>}
      </div>
      <button className="workspace-button meeting-selection-delete" disabled={busy} onClick={trash}><Trash2 size={14} aria-hidden="true" />{t('Delete')}</button>
      <button className="workspace-icon" aria-label={t('Clear selection')} onClick={e => { clear(); if (!e.detail) list.current?.querySelector<HTMLButtonElement>('.native-meeting-link')?.focus() }}><X size={16} aria-hidden="true" /></button>
    </div>
    {naming && <FolderName onDone={made => {
      setNaming(false); trigger.current?.focus()
      if (made) void addMeetingsToFolder(made.id, ids).catch(() => toasts.add({ title: t("Yogurt couldn't add this note to the folder. Try again.") }))
    }} />}
  </>, document.body)
}
