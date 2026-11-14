import { attendeeSuggestions, searchPersonKey } from '../../../shared/searchPeople'
import { usePopoverPresence } from '../motion'
import { attendeePrivacy, emailName } from '../../../shared/people'
import { toasts } from './TrashToast'
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { useNotePopover } from '../useNotePopover'
import { Lock, Pencil, Plus, Users, X } from 'lucide-react'
import type { CalEvent, Meeting, Person } from '../../../shared/types'
import { t } from '../../../shared/i18n'

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
const first = (name: string) => personName(name).split(/\s+/)[0] ?? name

/** An address can identify someone without turning the visible name into an invitation chip. */
export function personName(name: string): string {
  const person = parsePerson(name)
  if (!person?.email || person.name !== person.email) return person?.name ?? name
  return emailName(person.email)
}

/** Accept a display name, an email address, or a name followed by an address in angle brackets. */
export function parsePerson(raw: string): Person | null {
  const text = raw.replace(/\s+/g, ' ').trim()
  if (!text) return null
  const email = /<?([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>?/.exec(text)
  if (!email) return { name: text, email: null }
  const name = text.replace(email[0], '').replace(/[,;]/g, ' ').trim()
  return { name: name || email[1], email: email[1] }
}

/** Compact labels show up to three first names, without counting the person themself. */
export function peopleSummary(people: Person[], me: string, limit = 3): string {
  const others = people.filter((p) => !same(p.name, me))
  if (!others.length) return t('Me')
  const names = others.slice(0, limit).map((p) => first(p.name)).reduce((a, b) => t('{a}, {b}', { a, b }))
  return others.length > limit ? t('{name} + {more}', { name: names, more: others.length - limit }) : names
}

/** The header keeps room for the date and folder beside two names. */
export function peopleChipSummary(people: Person[], me: string): string {
  return people.some(p => !same(p.name, me)) ? peopleSummary(people, me, 2) : t('Add attendees')
}

/** One settings read per surface, shared by all of its compact attendee labels. */
export function useMyName() {
  const [me, setMe] = useState('')
  useEffect(() => { void window.yogurt.settings.get().then((s) => setMe(s.myName || s.macName)) }, [])
  return me
}

/** Attendee membership and inline person editing, separate from the calendar details. */
export function People({ m }: { m: Meeting }) {
  const [open, setOpen] = useState<false | 'pointer' | 'keyboard'>(false)
  const presence = usePopoverPresence(open, open === 'pointer')
  const me = useMyName()
  const chip = useRef<HTMLButtonElement>(null)
  const close = useCallback((restore = true) => { setOpen(false); if (restore) chip.current?.focus({ preventScroll: true }) }, [])

  return (
    <div className="relative">
      <button ref={chip} data-testid="note-attendees" aria-haspopup="dialog" aria-expanded={!!open} onClick={(e) => setOpen((o) => o ? false : e.detail > 0 ? 'pointer' : 'keyboard')}
        title={m.attendees.map(a => a.email ? `${a.name} <${a.email}>` : a.name).join(', ') || undefined}
        className="note-chip flex items-center gap-1.5 rounded-md border border-line px-2.5 text-[13px] text-muted">
        <span data-testid="note-attendees-summary" className="flex items-center gap-1.5"><Users size={14} strokeWidth={1.75} aria-hidden="true" />{peopleChipSummary(m.attendees, me)}</span>
      </button>
      {presence.value && <Card m={m} me={me} motionProps={presence.props} chip={chip} onClose={close} />}
    </div>
  )
}

function Card({ m, me, motionProps, chip, onClose }: { m: Meeting; me: string; motionProps: ReturnType<typeof usePopoverPresence>['props']; chip: RefObject<HTMLButtonElement | null>; onClose: (restore?: boolean) => void }) {
  const [text, setText] = useState('')
  const [adding, setAdding] = useState(() => !m.attendees.some(p => !same(p.name, me)))
  const [focused, setFocused] = useState(false)
  const [known, setKnown] = useState<Person[]>([]), [events, setEvents] = useState<CalEvent[]>([])
  const [active, setActive] = useState<string | null>(null)
  const listId = useId()
  const suggestions = attendeeSuggestions(text, known, m.attendees, me, events, m.eventId)
  const activeIndex = suggestions.findIndex(p => searchPersonKey(p) === active)
  useEffect(() => {
    let sequence = 0
    const load = () => {
      const current = ++sequence
      void window.yogurt.search.people().then(p => { if (current === sequence) setKnown(p) }, () => {})
      void window.yogurt.calendar.day(m.eventStartedAt ?? m.startedAt).then(day => {
        if (current === sequence) setEvents(day.status === 'granted' ? day.events : [])
      }, () => { if (current === sequence) setEvents([]) })
    }
    load()
    const offPeople = window.yogurt.meetings.onChange(load), offCalendar = window.yogurt.calendar.onChange(load)
    return () => { sequence++; offPeople(); offCalendar() }
  }, [m.id, m.startedAt, m.eventStartedAt, m.eventId])
  const input = useRef<HTMLInputElement>(null)
  const card = useRef<HTMLDivElement>(null)
  useNotePopover(card, chip, onClose, !motionProps.inert)
  useEffect(() => { card.current?.querySelector('[role="option"][aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [active])
  useEffect(() => { if (adding) input.current?.focus({ preventScroll: true }) }, [adding])
  const save = async (people: Person[]) => {
    try { await window.yogurt.meetings.setAttendees(m.id, people); return true }
    catch { toasts.add({ title: t("Yogurt couldn't make that change. Try again.") }); return false }
  }
  const add = async (p = parsePerson(text)) => {
    if (!p) return
    // already there: nothing to add
    if (m.attendees.some((a) => p.email?.trim() && a.email?.trim() ? same(a.email, p.email) : same(a.name, p.name))) return
    if (await save([...m.attendees, p])) { setText(''); setActive(null); input.current?.focus() }
  }
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
  }
  // the person themself first, marked; an invite that lists them too shows them once
  const others = m.attendees.map((p, i) => ({ p, i })).filter(({ p }) => !same(p.name, me))

  return (
    <div ref={card} data-testid="people-card" {...motionProps} data-anchor="start" role="dialog" aria-label={t('People')} onKeyDown={key}
      className="people-card menu-entry absolute start-0 top-full z-30 mt-2 w-[min(340px,calc(100vw-48px))] rounded-lg border border-line bg-float text-ink shadow-[var(--shadow)]">
      <ul data-testid="people-list" className="people-list max-h-64 overflow-y-auto p-1.5">
        <Row name={me || t('Me')} email={m.attendees.find(p => same(p.name, me))?.email} mine />
        {others.map(({ p, i }) => (
          <Row key={p.email || i} name={personName(p.name)} email={p.email} onRename={name => window.yogurt.meetings.renameAttendee(m.id, i, name, p)} onRemove={() => void save(m.attendees.filter((_, j) => j !== i))} />
        ))}
      </ul>
      <div className={`border-t border-line ${adding ? 'p-3' : ''}`}>
        <button data-testid="people-add-open" onClick={() => { setAdding(true); input.current?.focus() }} className={`flex w-full items-center gap-2 text-start text-[13px] text-muted ${adding ? 'mb-2' : 'h-11 px-4 hover:bg-card'}`}><Plus size={14} aria-hidden="true" />{t('Add an attendee')}</button>
        {adding && <div className="people-add-field flex h-9 items-center rounded-md border border-line bg-card px-2.5">
          <input ref={input} data-testid="people-add" value={text} onChange={(e) => { setText(e.target.value); setActive(null) }} maxLength={200}
            role="combobox" aria-autocomplete="list" aria-expanded={focused && suggestions.length > 0} aria-controls={focused && suggestions.length > 0 ? listId : undefined}
            aria-activedescendant={focused && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return
              if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && suggestions.length) {
                e.preventDefault()
                const next = activeIndex < 0 ? (e.key === 'ArrowDown' ? 0 : suggestions.length - 1)
                  : (activeIndex + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length
                setActive(searchPersonKey(suggestions[next]))
              } else if (e.key === 'Enter') { e.preventDefault(); void add(suggestions[activeIndex] ?? parsePerson(text)) }
            }}
            placeholder={t('Name or email')} aria-label={t('Add an attendee')} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
            className="h-full min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted" />
        </div>}
        {adding && focused && suggestions.length > 0 && <ul id={listId} role="listbox" aria-label={t('People')} className="mt-1">
          {suggestions.map((p, i) => <li key={searchPersonKey(p)} id={`${listId}-${i}`} role="option" aria-selected={i === activeIndex}
            onMouseDown={e => e.preventDefault()} onMouseMove={() => setActive(searchPersonKey(p))} onClick={() => void add(p)}
            className={`person-row flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] hover:bg-[var(--line)] ${i === activeIndex ? 'bg-[var(--line)]' : ''}`}>
            <Users size={14} aria-hidden="true" className="shrink-0 text-muted" />
            <span className="min-w-0"><span className="block truncate">{personName(p.name)}</span>
              {p.email && <span className="block truncate text-xs text-muted">{p.email}</span>}</span>
          </li>)}
        </ul>}
      {attendeePrivacy(focused, text) && <p data-testid="people-private" className="mt-2 flex items-start gap-2 text-xs leading-relaxed text-muted">
        <Lock size={12} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0" />
        <span>{t('Nothing is sent. This is only for your notes.')}</span>
      </p>}
      </div>
    </div>
  )
}

function Row({ name, email, mine, onRemove, onRename }: { name: string; email?: string | null; mine?: boolean; onRemove?: () => void; onRename?: (name: string) => Promise<boolean> }) {
  const nameButton = useRef<HTMLButtonElement>(null)
  const stopEditing = () => { setEditing(false); requestAnimationFrame(() => nameButton.current?.focus()) }
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(name), [saving, setSaving] = useState(false)
  const save = async () => {
    if (!draft.trim() || saving) return
    setSaving(true)
    try {
      if (!await onRename?.(draft)) throw new Error('Attendee no longer available')
      stopEditing()
    } catch { toasts.add({ title: t("Yogurt couldn't make that change. Try again.") }) }
    finally { setSaving(false) }
  }
  return (
    <li data-testid="people-row" data-me={mine ? '' : undefined} className={`person-row flex ${email ? 'min-h-[52px]' : 'min-h-10'} items-center gap-2 rounded-md px-2.5 py-1.5`}>
      <div className="min-w-0 flex-1 text-[13px]" title={email ?? undefined}>
        {editing ? <input data-testid="people-rename" autoFocus value={draft} disabled={saving} maxLength={200} aria-label={t('Rename')} onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void save() } if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stopEditing() } }} className="w-full rounded border border-line bg-card px-1 py-0.5" />
          : onRename ? <button ref={nameButton} data-testid="people-name" title={t('Rename')} className="block max-w-full truncate text-start" onClick={() => { setDraft(name); setEditing(true) }}>{name}</button>
          : <span>{name}{mine && <span className="text-muted"> {t('(me)')}</span>}</span>}
        {email && <span data-testid="people-email" className="block break-words text-xs leading-[17px] text-muted">{email}</span>}
      </div>
      {onRename && !editing && <button data-testid="people-edit" aria-label={t('Rename')} title={t('Rename')} onClick={() => { setDraft(name); setEditing(true) }} className="person-remove grid size-6 shrink-0 place-items-center rounded text-muted hover:bg-[var(--line)] hover:text-ink"><Pencil size={14} strokeWidth={1.75} aria-hidden="true" /></button>}
      {onRemove && (
        <button data-testid="people-remove" onClick={onRemove} aria-label={t('Remove {name}', { name })} title={t('Remove')}
          className="person-remove grid size-6 shrink-0 place-items-center rounded-full text-muted hover:bg-[var(--line)] hover:text-ink">
          <X size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
      )}
    </li>
  )
}

