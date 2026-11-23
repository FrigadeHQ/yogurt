import { Tooltip } from '@base-ui/react/tooltip'
import { ActionTooltipPopup } from './ActionTooltipPopup'
import { Loading } from './Loading'
import { LoadingContent } from './LoadingContent'
import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type RefObject } from 'react'
import { ArrowDown, ArrowUp, Ellipsis, Palette, Pencil, FolderPlus, Trash2 } from './Icons'
import { Reorder, useDragControls } from 'motion/react'
import { useReducedMotion, usePopoverPresence } from '../motion'
import type { Folder } from '../../../shared/types'
import { t } from '../../../shared/i18n'
import { FolderGlyph } from './FolderAppearance'
import { MEETING_DRAG, addMeetingsToFolder } from '../folders'
import { draggedMeetings } from '../meetingSelection'
import { DeleteFolder, FolderName, FolderAppearanceDialog } from './FolderDialogs'
import { toasts } from './TrashToast'

const sectionOpenKey = 'sidebar.foldersOpen'

export function FoldersNav({ folders, route, go }: { folders?: Folder[]; route: string; go: (route: string) => void }) {
  const [expanded, setExpanded] = useState(() => {
    try { return window.localStorage.getItem(sectionOpenKey) !== 'false' } catch { return true }
  })
  const setSectionOpen = (open: boolean) => {
    setExpanded(open)
    try { window.localStorage.setItem(sectionOpenKey, String(open)) } catch { /* Still works for this visit. */ }
  }
  const [naming, setNaming] = useState<{ folder?: Folder }>()
  const [appearance, setAppearance] = useState<Folder>()
  const [deleting, setDeleting] = useState<Folder>()
  const [order, setOrder] = useState<string[]>()
  const [busy, setBusy] = useState(false)
  const dragging = useRef(false)
  const group = useRef<HTMLDivElement>(null)
  const ids = order ? [...order.filter(id => folders?.some(f => f.id === id)), ...(folders ?? []).filter(f => !order.includes(f.id)).map(f => f.id)] : (folders ?? []).map(f => f.id)
  const latest = useRef(ids)
  latest.current = ids
  useEffect(() => { if (!dragging.current && !busy) setOrder(undefined) }, [folders])
  const save = async (next: string[]) => {
    dragging.current = false
    if (next.every((id, i) => id === folders?.[i]?.id)) { setOrder(undefined); return }
    setOrder(next); setBusy(true)
    try {
      if (!await window.yogurt.folders.reorder(next)) throw new Error('Folder list changed')
    } catch {
      setOrder(undefined)
      toasts.add({ title: t("Yogurt couldn't make that change. Try again.") })
    } finally { setBusy(false) }
  }
  const move = (id: string, step: number) => {
    const at = ids.indexOf(id), next = [...ids]
    if (busy || at + step < 0 || at + step >= ids.length) return
    next.splice(at, 1); next.splice(at + step, 0, id)
    void save(next)
  }
  const foldersLabel = t('Folders')
  const newFolderLabel = t('New folder')
  return <>
    <nav className="workspace-folders" aria-label={foldersLabel} data-testid="sidebar-folders">
      <div className="workspace-folder-header" data-empty={folders?.length === 0}>
        <h2>
          <button type="button" className="workspace-folder-toggle" data-testid="workspace-folders-toggle"
            aria-label={foldersLabel} aria-expanded={expanded}
            aria-controls="workspace-folder-panel" onClick={() => setSectionOpen(!expanded)}>
            <span>{foldersLabel}</span>
            <svg className="workspace-folder-caret" width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
              <path d="M9 5 3 8.464V1.536Z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
            </svg>
          </button>
        </h2>
        <Tooltip.Root>
          <Tooltip.Trigger type="button" data-testid="folder-create" className="ghost-btn workspace-icon workspace-folder-new"
            aria-label={newFolderLabel} delay={180} onClick={() => setNaming({})}><FolderPlus size={16} aria-hidden="true" /></Tooltip.Trigger>
          <ActionTooltipPopup label={newFolderLabel} />
        </Tooltip.Root>
      </div>
      <div id="workspace-folder-panel" className="workspace-folder-panel" data-open={expanded} inert={!expanded}>
        <LoadingContent pending={!folders} skeleton={<Loading layout="folders" testId="folders-loading" />}>
          <Reorder.Group as="div" ref={group} axis="y" values={ids} className="workspace-folder-list" data-testid="folder-reorder-list"
            onReorder={next => { latest.current = next; setOrder(next) }}>
            {ids.map((id, i) => {
              const s = folders!.find(f => f.id === id)!
              return <FolderItem key={s.id} folder={s} current={route === `/folder/${s.id}`} go={go}
                constraints={group} reorderable={!busy && ids.length > 1} onDragStart={() => { dragging.current = true }} onDragEnd={() => void save(latest.current)}
                moveUp={!busy && i > 0 ? () => move(id, -1) : undefined} moveDown={!busy && i < ids.length - 1 ? () => move(id, 1) : undefined}
                onAppearance={() => setAppearance(s)} onRename={() => setNaming({ folder: s })} onDelete={() => setDeleting(s)} />
            })}
          </Reorder.Group>
        </LoadingContent>
      </div>
    </nav>
    {appearance && <FolderAppearanceDialog folder={appearance} onDone={() => setAppearance(undefined)} />}
    {naming && <FolderName folder={naming.folder} onDone={made => {
      setNaming(undefined)
      if (made) {
        if (!expanded) setSectionOpen(true)
        go(`/folder/${made.id}`)
      }
    }} />}
    {deleting && <DeleteFolder folder={deleting} onDone={(gone) => {
      setDeleting(undefined)
      if (gone && route === `/folder/${deleting.id}`) go('')
    }} />}
  </>
}

function FolderItem({ folder, current, go, onRename, onDelete, onAppearance, constraints, reorderable, onDragStart, onDragEnd, moveUp, moveDown }: {
  folder: Folder; current: boolean; go: (route: string) => void; onAppearance: () => void; onRename: () => void; onDelete: () => void
  constraints: RefObject<HTMLDivElement | null>; reorderable: boolean; onDragStart: () => void; onDragEnd: () => void; moveUp?: () => void; moveDown?: () => void
}) {
  const controls = useDragControls()
  const reduced = useReducedMotion()
  const dragged = useRef(false)
  const [moving, setMoving] = useState(false)
  const [drop, setDrop] = useState(false)
  const [menu, setMenu] = useState<{ style: CSSProperties; animate: boolean }>()
  const presence = usePopoverPresence(menu, menu?.animate ?? true)
  const row = useRef<HTMLDivElement>(null)
  const more = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menu) return
    list.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const away = (e: MouseEvent) => { if (!row.current?.contains(e.target as Node)) setMenu(undefined) }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [menu])
  // fixed under the row, so the sidebar's scrolling never cuts it off
  const openMenu = (animate: boolean) => {
    const box = row.current!.getBoundingClientRect()
    const rtl = getComputedStyle(row.current!).direction === 'rtl'
    setMenu({ animate, style: { position: 'fixed', top: box.bottom + 4, width: Math.max(180, box.width), insetInlineStart: rtl ? window.innerWidth - box.right : box.left } })
  }
  const key = (e: KeyboardEvent) => {
    const items = Array.from(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])
    const at = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setMenu(undefined); more.current?.focus() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(at + 1) % items.length]?.focus() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(at - 1 + items.length) % items.length]?.focus() }
    else if (e.key === 'Tab') setMenu(undefined)
  }
  const run = (fn: () => void) => { setMenu(undefined); more.current?.focus(); fn() }
  const carries = (e: DragEvent) => e.dataTransfer.types.includes(MEETING_DRAG)
  return <Reorder.Item as="div" ref={row} value={folder.id} className="workspace-folder-item" data-testid="sidebar-folder" data-folder={folder.id} data-moving={moving}
    dragListener={false} dragControls={controls} dragConstraints={constraints} dragElastic={0} dragMomentum={false}
    transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 520, damping: 42 }}
    onDragStart={() => { dragged.current = true; setMoving(true); setMenu(undefined); onDragStart() }}
    onDragEnd={() => { setMoving(false); onDragEnd() }}>
    <button className="workspace-nav" data-sidebar="menu-button" aria-label={folder.name} aria-description={t('{count} meetings', { count: folder.count })} data-testid="sidebar-folder-open" data-drop={drop} aria-current={current ? 'page' : undefined}
      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
      onPointerDown={e => { dragged.current = false; if (reorderable && e.button === 0) controls.start(e, { distanceThreshold: 4 }) }}
      onClick={e => { if (dragged.current && e.detail) { dragged.current = false; return } go(`/folder/${folder.id}`) }}
      onContextMenu={e => { e.preventDefault(); openMenu(true) }}
      onKeyDown={e => { if (e.key === 'ContextMenu' || e.shiftKey && e.key === 'F10') { e.preventDefault(); openMenu(false) } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); (e.key === 'ArrowUp' ? moveUp : moveDown)?.() } }}
      onDragEnter={(e) => { if (carries(e)) { e.preventDefault(); setDrop(true) } }}
      onDragOver={(e) => { if (carries(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'link' } }}
      onDragLeave={() => setDrop(false)}
      onDrop={(e) => {
        setDrop(false)
        const ids = draggedMeetings(e.dataTransfer.getData(MEETING_DRAG))
        if (ids.length) {
          e.preventDefault()
          void addMeetingsToFolder(folder.id, ids).catch(() => toasts.add({ title: t("Yogurt couldn't add this note to the folder. Try again.") }))
        }
      }}>
      <FolderGlyph appearance={folder} />
      <span className="workspace-folder-label"><span>{folder.name}</span>
        <small data-testid="sidebar-folder-count" aria-hidden="true"><bdi dir="ltr">{folder.count > 99 ? '99+' : folder.count}</bdi></small>
      </span>
    </button>
    <button ref={more} data-testid="sidebar-folder-more" className="ghost-btn workspace-icon workspace-folder-more" aria-haspopup="menu" aria-expanded={!!menu}
      aria-label={t('More for “{name}”', { name: folder.name })} title={t('More')} onClick={() => (menu ? setMenu(undefined) : openMenu(true))}>
      <Ellipsis size={15} aria-hidden="true" />
    </button>
    {presence.value && <div ref={list} data-testid="sidebar-folder-menu" role="menu" aria-label={folder.name} {...presence.props} data-anchor="start" onKeyDown={key} style={presence.value.style}
      className="menu-entry z-[70] rounded-xl border border-line bg-float p-1.5 shadow-[var(--shadow)]">
      <button role="menuitem" data-testid="sidebar-folder-appearance" onClick={() => run(onAppearance)} className="flex w-full items-center gap-2.5 text-start">
        <Palette size={15} aria-hidden="true" className="text-muted" />{t('Change icon')}
      </button>
      <button role="menuitem" data-testid="sidebar-folder-rename" onClick={() => run(onRename)} className="flex w-full items-center gap-2.5 text-start">
        <Pencil size={15} aria-hidden="true" className="text-muted" />{t('Rename')}
      </button>
      <button role="menuitem" data-testid="sidebar-folder-up" disabled={!moveUp} onClick={() => moveUp && run(moveUp)} className="flex w-full items-center gap-2.5 text-start">
        <ArrowUp size={15} aria-hidden="true" className="text-muted" />{t('Move up')}
      </button>
      <button role="menuitem" data-testid="sidebar-folder-down" disabled={!moveDown} onClick={() => moveDown && run(moveDown)} className="flex w-full items-center gap-2.5 text-start">
        <ArrowDown size={15} aria-hidden="true" className="text-muted" />{t('Move down')}
      </button>
      <button role="menuitem" data-testid="sidebar-folder-delete" onClick={() => run(onDelete)} className="flex w-full items-center gap-2.5 text-start text-danger">
        <Trash2 size={15} aria-hidden="true" />{t('Delete folder')}
      </button>
    </div>}
  </Reorder.Item>
}
