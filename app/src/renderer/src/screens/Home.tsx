import { LoadingContent } from '../components/LoadingContent'
import { StartRecording } from '../components/StartRecording'
import { Mic } from '../components/Icons'
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import { Circle, FileText, Users } from 'lucide-react'
import type { MeetingCard } from '../../../shared/types'
import { useScrollMemory } from '../useScrollMemory'
import { loadUpTo } from '../paging'
import { t } from '../../../shared/i18n'
import { dayLabel, timeOf, useDay } from '../dates'
import { useLanguage } from '../i18n'
import { moveMeetingsToTrash, toasts } from '../components/TrashToast'
import { MeetingRow } from '../components/MeetingRow'
import { FolderChip } from '../components/FolderPicker'
import { Agenda } from '../components/Agenda'
import { MEETING_DRAG } from '../folders'
import { command } from '../keys'
import { emptySelection, meetingSelection, meetingTargets, selectsMeeting } from '../meetingSelection'
import { MeetingSelectionBar } from '../components/MeetingSelectionBar'
import { peopleSummary, useMyName } from '../components/People'

const PAGE = 40
const loadedCounts = new Map<string, number>()

/** The workspace, backed by the existing meeting and calendar bridge. */
export function Home({ open, openFolder, agendaJump }: { open: (id: string) => void; openFolder?: (id: string) => void; agendaJump?: { at: number } }) {
  const past = usePastNotes()
  const day = useDay()
  const recording = past.cards?.find((c) => c.state === 'recording')
  const [calendarRevision, setCalendarRevision] = useState(0)
  const start = async (eventId: string | null) => {
    toasts.close('home-message')
    const r = await window.yogurt.meetings.start(eventId).catch(() => ({ error: 'failed' as const }))
    if (!('error' in r)) return
    if (r.error === 'gone') setCalendarRevision((revision) => revision + 1)
    toasts.add({ id: 'home-message', data: { testId: 'home-message' }, title: r.error === 'gone' ? t('That meeting is no longer on your calendar.') : t("Yogurt couldn't start the notes. Try again in a moment.") })
  }
  const noMeetings = past.cards?.length === 0
  const calendar = window.yogurt.capabilities.calendar
  return <div data-testid="home" className={calendar ? 'native-home' : 'native-home no-agenda'}>
    <StartRecording testId="new-note" onGone={() => setCalendarRevision(revision => revision + 1)} />
    <div className="native-library" ref={past.setRoot} tabIndex={-1}>
      <h1>{t('Your meetings')}</h1>
      <LoadingContent pending={!past.cards} testId="meetings-loading" skeleton={<MeetingListLoading />} className="library-load">{noMeetings ? <section data-testid="past-empty" className="library-empty empty-state"><div className="empty-state-content">
        <div className="empty-tile"><FileText size={28} strokeWidth={1.5} aria-hidden="true" /></div><h2>{t('Your notes will show up here')}</h2>
        <p>{t('Start recording, add a few notes, and Yogurt writes the rest when you stop.')}</p>
      </div></section> : <PastNotes cards={past.cards ?? []} day={day} more={past.more} sentinel={past.setSentinel} onOpen={open} openFolder={openFolder} />}</LoadingContent>
    </div>
    {calendar && <Agenda revision={calendarRevision} recording={recording} onStart={start} onOpen={open} jumpTo={agendaJump} />}
  </div>
}

/**
 * Past notes a page at a time: the next page loads as the end of the list comes near. Any change to a meeting
 * reloads what is already shown (one query, however far down the person scrolled). folder: only its meetings (a
 * folder's page), which also follow every change to folders.
 */
export function usePastNotes(folder?: string) {
  const [cards, setCards] = useState<MeetingCard[]>()
  const [more, setMore] = useState(false)
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null)
  const memoryKey = folder ? `folder/${folder}` : 'meetings'
  const scroll = useScrollMemory<HTMLDivElement>(memoryKey, !!cards)
  const attachRoot = useCallback((el: HTMLDivElement | null) => { scroll.current = el; setRoot(el) }, [scroll])
  const shown = useRef(loadedCounts.get(memoryKey) ?? 0)
  const loading = useRef(false)
  const seq = useRef(0)

  const reload = useCallback(() => {
    const mine = ++seq.current
    // however far down the person scrolled, in steps (one call to main is capped)
    void loadUpTo((o) => window.yogurt.meetings.cards({ ...o, ...(folder ? { folder } : {}) }), shown.current, PAGE).then(({ cards: list, more }) => {
      if (mine !== seq.current) return
      shown.current = list.length; loadedCounts.set(memoryKey, list.length); setCards(list); setMore(more)
    })
  }, [folder])
  useEffect(() => {
    reload()
    let timer: ReturnType<typeof setTimeout> | undefined
    // notes being written change meetings often: one reload for a burst
    const later = () => { clearTimeout(timer); timer = setTimeout(reload, 150) }
    const off = window.yogurt.meetings.onChange(later)
    const offFolders = window.yogurt.folders.onChange(later)
    return () => { off(); offFolders(); clearTimeout(timer) }
  }, [reload, folder])

  const next = useCallback(() => {
    if (loading.current || !cards?.length) return
    loading.current = true
    const last = cards[cards.length - 1]
    const mine = seq.current
    void window.yogurt.meetings.cards({ limit: PAGE, before: { at: last.startedAt, id: last.id }, ...(folder ? { folder } : {}) }).then((page) => {
      loading.current = false
      if (mine !== seq.current) return
      setCards((cur) => {
        const have = new Set(cur?.map((c) => c.id))
        const all = [...(cur ?? []), ...page.filter((c) => !have.has(c.id))]
        shown.current = all.length; loadedCounts.set(memoryKey, all.length)
        return all
      })
      setMore(page.length === PAGE)
    })
  }, [cards, folder])

  useEffect(() => {
    if (!sentinel || !root || !more) return
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) next() }, { root, rootMargin: '800px 0px' })
    io.observe(sentinel)
    return () => io.disconnect()
  }, [sentinel, root, more, next])

  return { cards, more, setRoot: attachRoot, setSentinel }
}

/** Delete on a row moves the meeting to the Trash at once (Undo in the note at the bottom) */
export function PastNotes({ cards, day, more, sentinel, onOpen, openFolder, showFolders = true, loading = false }: { loading?: boolean; cards: MeetingCard[]; day: string; more: boolean; sentinel: (el: HTMLDivElement | null) => void; onOpen: (id: string) => void; openFolder?: (id: string) => void; showFolders?: boolean }) {
  const lang = useLanguage()
  const me = useMyName()
  const [selection, select] = useReducer(meetingSelection, emptySelection)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false), list = useRef<HTMLElement>(null)
  const visible = useMemo(() => cards.map(card => card.id), [cards])
  const memberships = useMemo(() => Object.fromEntries(cards.map(card => [card.id, (card.folders ?? []).map(folder => folder.id)])), [cards])
  const selected = selection.ids.filter(id => visible.includes(id))
  useEffect(() => { select({ type: 'prune', visible }) }, [visible])
  useEffect(() => {
    if (!selected.length) return
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || (e.target instanceof Element && e.target.closest('input,textarea,[contenteditable=true],[role="menu"],dialog,[role="dialog"]'))) return
      e.preventDefault(); select({ type: 'clear' })
    }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [selected.length > 0])
  const trash = async (ids: string[]) => {
    if (pending.current) return
    pending.current = true; setBusy(true)
    const keyboard = !!document.activeElement?.matches(':focus-visible')
    try {
      const done = await moveMeetingsToTrash(ids, undefined, selected.includes(ids[0]))
      select({ type: 'remove', ids: done })
      if (keyboard) {
        const next = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('.native-meeting-link') ?? []).find(row => !done.includes(row.dataset.meetingId!))
        const target = next ?? list.current?.closest<HTMLElement>('.native-library')
        target?.focus()
      }
    } finally { pending.current = false; setBusy(false) }
  }
  const days = useMemo(() => {
    const out: Array<{ key: string; label: string; cards: MeetingCard[] }> = []
    for (const c of cards) {
      const key = new Date(c.startedAt).toDateString()
      if (out.at(-1)?.key === key) out.at(-1)!.cards.push(c)
      else out.push({ key, label: dayLabel(c.startedAt, { weekday: true }), cards: [c] })
    }
    return out
  }, [cards, day, lang])
  return <section ref={list} aria-label={t('Saved meetings')} data-selecting={selected.length > 0} onKeyDown={e => {
    if (!list.current?.contains(e.target as Node) || (e.target as HTMLElement).closest('input,textarea,[contenteditable=true],[role="menu"]')) return
    if (command(e) && e.key.toLowerCase() === 'a' && !e.altKey && !e.shiftKey) { e.preventDefault(); select({ type: 'all', visible }) }
    else if (e.key === 'Escape') { e.preventDefault(); select({ type: 'clear' }) }
  }}>
    {days.map((group) => <div className="native-meeting-day" key={group.key}>
      <h2 data-testid={loading ? undefined : "past-day"}>{loading ? <span className="loading-bar" style={{ width: 48 }} /> : group.label}</h2>
      <ul>{group.cards.map((meeting) => loading ? <li className="native-meeting-row" key={meeting.id}><PastCard c={meeting} onOpen={onOpen} me="" showFolders={showFolders} loading /></li> : <MeetingRow key={meeting.id} id={meeting.id} recording={meeting.state === 'recording'} selected={selected.includes(meeting.id)} targets={meetingTargets(selected, meeting.id)} memberships={memberships} busy={busy}
        onSelect={() => select({ type: 'select', id: meeting.id, visible })} onTrash={ids => void trash(ids)}
        onClick={e => {
          if (selectsMeeting(selected.length, command(e), e.shiftKey)) {
            e.preventDefault(); e.stopPropagation(); select({ type: e.shiftKey ? 'range' : 'toggle', id: meeting.id, visible })
          }
        }}>
        {(openFolders, more) => <PastCard more={more} c={meeting} onOpen={onOpen} openFolder={openFolder} openFolders={openFolders} me={me} selected={selected.includes(meeting.id)} dragIds={meetingTargets(selected, meeting.id)} showFolders={showFolders} />}
      </MeetingRow>)}</ul>
    </div>)}
    {more && <div data-testid="past-more" ref={sentinel} className="h-8" aria-hidden="true" />}
    {!loading && selected.length > 0 && <MeetingSelectionBar ids={selected} memberships={memberships} list={list} busy={busy} clear={() => select({ type: 'clear' })} trash={() => void trash(selected)} />}
  </section>
}

/** when: in place of the time (the Trash shows the day); fixed: not dragged onto folders */
export function PastCard({ c, onOpen, openFolder, openFolders, more, when, fixed, me, selected, dragIds, showFolders = true, loading = false }: { more?: ReactNode; selected?: boolean; dragIds?: string[]; loading?: boolean; c: MeetingCard; onOpen: (id: string) => void; openFolder?: (id: string) => void; openFolders?: (suggestedId: string) => void; when?: string; fixed?: boolean; me: string; showFolders?: boolean }) {
  const recording = c.state === 'recording'
  const minutes = (c.state === 'done' || c.state === 'stopped') && c.endedAt != null
    ? Math.max(1, Math.round((c.durationMs ?? (c.endedAt - c.startedAt)) / 60_000)) : null
  const initials = c.attendees[0]?.name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => Array.from(part)[0]).join('').toLocaleUpperCase()
  const filed = c.folders?.map(folder => <button className="meeting-folder-pill" data-testid={loading ? undefined : "past-note-folder"} data-folder-color={folder.color} data-opens={!!openFolder && !loading} title={folder.name} key={folder.id} disabled={loading}
    onClick={e => { e.stopPropagation(); if (openFolder) openFolder(folder.id); else onOpen(c.id) }}>
    <span className="meeting-folder-dot" aria-hidden="true" /><span className="meeting-folder-name">{loading ? <span className="loading-bar" style={{ width: 46 }} /> : folder.name}</span>
  </button>)
  // dragged onto a folder in the sidebar, it goes into that folder
  return <div data-testid={loading ? undefined : "past-note"} className="native-meeting-card" draggable={!fixed && !loading} onDragStart={fixed ? undefined : (e) => {
    if ((e.target as HTMLElement).closest('.meeting-folders')) { e.preventDefault(); return }
    e.dataTransfer.setData(MEETING_DRAG, dragIds && dragIds.length > 1 ? JSON.stringify(dragIds) : c.id)
    e.dataTransfer.effectAllowed = 'link'
    const preview = document.createElement('div')
    preview.className = 'meeting-drag-preview'
    preview.setAttribute('aria-hidden', 'true')
    preview.append(e.currentTarget.querySelector('.meeting-identity')!.cloneNode(true), e.currentTarget.querySelector('.meeting-description strong')!.cloneNode(true))
    if (dragIds && dragIds.length > 1) { const count = document.createElement('span'); count.className = 'meeting-drag-count'; count.textContent = t('{count} meetings', { count: dragIds.length }); preview.append(count) }
    document.body.append(preview)
    e.dataTransfer.setDragImage(preview, 24, 24)
    // The native drag keeps its snapshot after this frame; no duplicate row stays in the page.
    requestAnimationFrame(() => preview.remove())
  }}>
    <button data-meeting-id={c.id} disabled={loading} onClick={() => onOpen(c.id)} aria-pressed={selected} className="native-meeting-link">
    <span className="meeting-content">
    <span className={`meeting-identity ${recording ? 'recording' : ''}`} aria-hidden="true">{loading ? null : recording ? <Mic size={16} /> : c.attendees.length > 1 ? <Users size={16} /> : initials || <FileText size={16} />}</span>
    <span className="meeting-description"><strong>{loading ? <span className="loading-bar" style={{ width: c.title.length * 6, maxWidth: '85%' }} /> : c.title}</strong><span data-testid={loading ? undefined : "past-note-attendees"} title={c.attendees.map((p) => p.name).join(', ') || undefined}>{loading ? <span className="loading-bar" style={{ width: 110 }} /> : c.attendees.length ? peopleSummary(c.attendees, me) : t('Personal notes')}</span>
    </span>
    </span>
    <span className="meeting-meta row-swap-meta">{recording ? <span className="meeting-live"><Circle size={6} fill="currentColor" />{c.paused ? t('Paused') : t('Recording')}</span> : <><time>{loading ? <span className="loading-bar" style={{ width: 45 }} /> : when ?? timeOf(c.startedAt)}</time>{minutes != null && <small data-testid="past-note-duration">{loading ? <span className="loading-bar" style={{ width: 26 }} /> : t('{count} min', { count: minutes })}</small>}</>}</span>
    </button>
    {more}
    {showFolders && <div className="meeting-folders" data-testid={loading ? undefined : "past-note-folders"}>
      {fixed || loading ? filed : <FolderChip meetingId={c.id} row rowFolders={c.folders ?? []} onChoose={openFolders ?? (() => onOpen(c.id))}>{filed}</FolderChip>}
    </div>}
  </div>
}

/** The real row and date-group layout, with representative line lengths rather than viewport-wide bars. */
export function MeetingListLoading({ grouped = true, showFolders = true }: { grouped?: boolean; showFolders?: boolean }) {
  const cards: MeetingCard[] = Array.from({ length: 5 }, (_, n) => ({
    id: `loading-${n}`, title: ['Weekly planning', 'Design and audio review', 'Team standup'][n % 3],
    state: 'done', preview: '', eventId: null, app: null, language: null, titleSource: 'user', startedAt: new Date(2026, 0, n < 3 ? 2 : 1).getTime(), endedAt: 1, durationMs: 120000,
    attendees: [], folders: n % 2 ? [{ id: 'loading-folder', name: '', color: 'violet', icon: 'folder', count: 0 }] : [],
  }))
  return grouped ? <PastNotes cards={cards} day="" more={false} sentinel={() => {}} onOpen={() => {}} showFolders={showFolders} loading />
    : <ul>{cards.map(c => <li className="native-meeting-row trash-row" key={c.id}><PastCard c={c} onOpen={() => {}} me="" loading /></li>)}</ul>
}
