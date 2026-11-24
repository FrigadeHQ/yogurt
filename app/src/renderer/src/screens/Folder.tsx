import { InlineError } from '../components/InlineError'
import { Folder as FolderIcon, Plus } from '../components/Icons'
import { LoadingContent } from '../components/LoadingContent'
import { LibraryEmpty, MeetingListLoading } from './Home'
import { useEffect, useRef, useState } from 'react'
import { FolderGlyph } from '../components/FolderAppearance'
import { FolderAppearanceDialog } from '../components/FolderDialogs'
import type { Folder as FolderRow } from '../../../shared/types'
import { t } from '../../../shared/i18n'
import { useDay } from '../dates'
import { PastNotes, usePastNotes } from './Home'
import { AddMeetingsDialog } from '../components/AddMeetingsDialog'
import { keys, onMac } from '../keys'
import { toasts } from '../components/TrashToast'
import { StartRecording } from '../components/StartRecording'

/** A folder's page: its name (click to rename) and its meetings, newest first, as on Meetings */
export function Folder({ folder, open, onUploaded }: { folder: FolderRow; open: (id: string) => void; onUploaded: (id: string) => void }) {
  const [appearance, setAppearance] = useState(false)
  const [picker, setPicker] = useState(false)
  const [creating, setCreating] = useState(false)
  const [emptyActions, setEmptyActions] = useState<HTMLDivElement | null>(null)
  const headerAdd = useRef<HTMLButtonElement>(null)
  const opener = useRef<HTMLButtonElement | null>(null)
  const createPending = useRef(false)
  const add = (button: HTMLButtonElement) => { opener.current = button; setPicker(true) }
  const closePicker = (added: boolean) => {
    setPicker(false)
    const target = added ? headerAdd.current : opener.current
    requestAnimationFrame(() => (target?.isConnected ? target : headerAdd.current)?.focus({ preventScroll: true }))
  }
  const newNote = async () => {
    if (createPending.current) return
    createPending.current = true; setCreating(true)
    try { open(await window.yogurt.meetings.createFolderNote(folder.id)) }
    catch { toasts.add({ title: t("Yogurt couldn't start the notes. Try again in a moment.") }) }
    finally { createPending.current = false; setCreating(false) }
  }
  const past = usePastNotes(folder.id)
  const day = useDay()
  return <div data-testid="folder-page" className="native-folder">
    <StartRecording folderId={folder.id} onUploaded={onUploaded} emptyActions={emptyActions} />
    <div className="native-library" ref={past.setRoot} tabIndex={-1}>
      <div className="folder-page-heading flex-wrap">
        <div className="flex min-w-0 flex-[1_1_12rem] items-center gap-3"><button className="folder-heading-icon" data-testid="folder-heading-icon" aria-label={t('Change icon')} title={t('Change icon')} onClick={() => setAppearance(true)} data-folder-color={folder.color}><FolderGlyph appearance={folder} size={24} /></button><FolderTitle folder={folder} /></div>
        <div className="flex flex-wrap items-center gap-2">
          <button id="folder-new-note" disabled={creating} aria-keyshortcuts={onMac() ? 'Meta+N' : 'Control+N'} title={`${t('New note')} (${keys('⌘N')})`} className="workspace-button" onClick={() => void newNote()}>{t('New note')}</button>
          <button ref={headerAdd} aria-haspopup="dialog" className="workspace-button" onClick={e => add(e.currentTarget)}><Plus size={14} aria-hidden="true" />{t('Add meetings')}</button>
        </div>
      </div>
      {picker && <AddMeetingsDialog folder={folder} onDone={closePicker} />}
      {appearance && <FolderAppearanceDialog folder={folder} onDone={() => setAppearance(false)} />}
      {past.failed && !!past.cards?.length && <InlineError testId="meetings-read-error" retry={past.retry} />}
      <LoadingContent pending={!past.cards && !past.failed} testId="meetings-loading" skeleton={<MeetingListLoading showFolders={false} />} className="library-load">{!past.cards?.length ? <LibraryEmpty testId="folder-empty" icon={<FolderIcon size={28} aria-hidden="true" />} title={t('No meetings here yet')} description={t('Notes and recordings started here are saved in this folder.')} retry={past.failed ? past.retry : undefined}>
        <div className="flex flex-wrap justify-center gap-2" ref={setEmptyActions}>
          <button aria-haspopup="dialog" className="workspace-button" onClick={e => add(e.currentTarget)}>{t('Add meetings')}</button>
          <button className="workspace-button" disabled={creating} onClick={() => void newNote()}>{t('New note')}</button>
        </div>
      </LibraryEmpty> : <PastNotes showFolders={false} cards={past.cards ?? []} day={day} more={past.more} sentinel={past.setSentinel} onOpen={open} />}</LoadingContent>
    </div>
  </div>
}

/** The folder's name as the page heading: click to rename; Return or clicking away saves, Escape keeps the old one */
function FolderTitle({ folder }: { folder: FolderRow }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(folder.name)
  const cancelled = useRef(false)
  useEffect(() => { if (editing) { setDraft(folder.name); cancelled.current = false } }, [editing, folder.name])
  if (!editing) {
    return <h1 data-testid="folder-title"><button onClick={() => setEditing(true)} title={t('Rename')} className="note-title-btn -mx-1 max-w-full break-words rounded-lg px-1 text-start">{folder.name}</button></h1>
  }
  const done = () => {
    setEditing(false)
    if (!cancelled.current && draft.trim() && draft.trim() !== folder.name) void window.yogurt.folders.rename(folder.id, draft)
  }
  return <h1><input data-testid="folder-title-input" aria-label={t('Folder name')} autoFocus value={draft} maxLength={200}
    onFocus={(e) => e.currentTarget.select()} onChange={(e) => setDraft(e.target.value)} onBlur={done}
    onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); else if (e.key === 'Escape') { cancelled.current = true; e.currentTarget.blur() } }}
    className="-mx-1 w-full rounded-lg bg-transparent px-1 outline-none ring-1 ring-line focus-visible:ring-accent" /></h1>
}
