import { attendeeSuggestions, searchPersonKey } from '../../../shared/searchPeople'
import { usePopoverPresence } from '../motion'
import { attendeePrivacy, emailName, groupPeople, initials, personEmail } from '../../../shared/people'
import { toasts } from './TrashToast'
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { useNotePopover } from '../useNotePopover'
import { Lock, Pencil, Plus, Trash2, Users } from './Icons'
import type { CalEvent, Meeting, Person } from '../../../shared/types'
import { t } from '../../../shared/i18n'
import { compactCount } from '../i18n'

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

function summarizePeople(people: Person[], me: string, limit: number, empty: string) {
  const others = people.filter(p => !same(p.name, me))
  const names = others.slice(0, limit).map(p => first(p.name)).reduce((a, b) => a ? t('{a}, {b}', { a, b }) : b, '') || empty
  const more = Math.max(0, others.length - limit)
  return { names, more, label: more ? `${names} ${t('and {count} more', { count: more })}` : names }
}

export function peopleSummary(people: Person[], me: string, limit = 3): string {
  return summarizePeople(people, me, limit, t('Me')).label
}

/** The header keeps room for the date and folder beside two names. */
export function peopleChipSummary(people: Person[], me: string) {
  return summarizePeople(people, me, 2, t('Add attendees'))
}

/** One settings read per surface, shared by all of its compact attendee labels. */
export function useMyName() {
  const [me, setMe] = useState('')
  useEffect(() => { void window.yogurt.settings.get().then((s) => setMe(s.myName || s.macName)) }, [])
  return me
}

/** Attendee membership and person details, separate from the calendar details. */
export function People({ m }: { m: Meeting }) {
  // Each opening gets a fresh list, even if the previous popover is still fading out.
  const [open, setOpen] = useState<false | number>(false)
  const presence = usePopoverPresence(open)
  const me = useMyName()
  const { names, more, label } = peopleChipSummary(m.attendees, me)
  const chip = useRef<HTMLButtonElement>(null)
  const close = useCallback((restore = true) => { setOpen(false); if (restore) chip.current?.focus({ preventScroll: true }) }, [])

  return (
    <div className="relative">
      <button ref={chip} data-testid="note-attendees" aria-label={label} aria-haspopup="dialog" aria-expanded={!!open} onClick={e => setOpen(open ? false : e.timeStamp)}
        title={m.attendees.map(a => a.email ? `${a.name} <${a.email}>` : a.name).join(', ') || undefined}
        className="note-chip flex items-center gap-1.5 rounded-md border border-line px-2.5 text-[13px] text-muted">
        <span data-testid="note-attendees-summary" className="flex items-center gap-1.5"><Users size={14} aria-hidden="true" /><span>{names}{more > 0 && <> {compactCount(more)}</>}</span></span>
      </button>
      {presence.value && <Card key={presence.value} m={m} me={me} motionProps={presence.props} chip={chip} onClose={close} />}
    </div>
  )
}

function Card({ m, me, motionProps, chip, onClose }: { m: Meeting; me: string; motionProps: ReturnType<typeof usePopoverPresence>['props']; chip: RefObject<HTMLButtonElement | null>; onClose: (restore?: boolean) => void }) {
  const [text, setText] = useState('')
  const [adding, setAdding] = useState(() => !m.attendees.some(p => !same(p.name, me)))
  const [focused, setFocused] = useState(false)
  const [known, setKnown] = useState<Person[]>([]), [events, setEvents] = useState<CalEvent[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ p: Person; i: number } | null>(null)
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
  const addButton = useRef<HTMLButtonElement>(null)
  const focusAfterEdit = useRef<{ key: string; index: number; before?: Person[] } | null>(null)
  useLayoutEffect(() => {
    const target = focusAfterEdit.current
    if (!target || editing || motionProps.inert || !card.current) return
    const rows = Array.from(card.current.querySelectorAll<HTMLButtonElement>('[data-person-key]'))
    const matches = rows.filter(row => row.dataset.personKey === target.key)
    const row = matches.find(button => button.dataset.index === String(target.index)) ?? matches[0]
    const button = row ?? addButton.current
    button?.focus()
    // A save can return before the meeting refresh moves or merges the row.
    if (m.attendees !== target.before) focusAfterEdit.current = null
  }, [editing, m.attendees, motionProps.inert])
  useNotePopover(card, chip, onClose, !motionProps.inert)
  useEffect(() => { card.current?.querySelector('[role="option"][aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [active])
  useEffect(() => { if (adding) input.current?.focus({ preventScroll: true }) }, [adding])
  const change = async (action: 'add' | 'remove', p: Person, index?: number) => {
    try { if (await window.yogurt.meetings.changeAttendee(m.id, action, p, index)) return true } catch { /* show the same retry message */ }
    toasts.add({ title: t("Yogurt couldn't make that change. Try again.") })
    return false
  }
  const add = async (p = parsePerson(text)) => {
    if (!p || m.attendees.some(a => p.email?.trim() && a.email?.trim() ? same(a.email, p.email) : same(a.name, p.name))) return
    if (await change('add', p)) { setText(''); setActive(null); input.current?.focus() }
  }
  const showList = (p: Person, before?: Person[]) => {
    focusAfterEdit.current = { key: searchPersonKey(p), index: editing!.i, before }
    setEditing(null)
  }
  const save = async (next: Person) => {
    const { p, i } = editing!
    if (next.name === personName(p.name) && same(next.email ?? '', p.email ?? '')) { showList(p); return }
    if (!await window.yogurt.meetings.renameAttendee(m.id, i, next.name, p, next.email)) throw new Error('Attendee unavailable')
    showList(next, m.attendees)
  }
  const remove = async (p: Person, i: number) => {
    if (!await change('remove', p, i)) return
    addButton.current?.focus({ preventScroll: true })
    const id = toasts.add({ title: t('{name} removed from meeting', { name: personName(p.name) }), timeout: 8000,
      actionProps: { children: t('Undo'), onClick: async () => { if (await change('add', p, i)) toasts.close(id) } },
    })
  }
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !e.nativeEvent.isComposing) { e.preventDefault(); e.stopPropagation(); onClose() }
  }
  // Keep original attendee indices when grouping; an invite lists the person themself once.
  const others = m.attendees.map((p, i) => ({ p, i })).filter(({ p }) => m.ownEmail && p.email ? personEmail(p.email) !== personEmail(m.ownEmail) : !same(p.name, me))

  const groups = groupPeople<{ p: Person; i: number; mine?: boolean }>([{ p: { name: me || t('Me'), email: m.ownEmail ?? null }, i: -1, mine: true }, ...others])

  return (
    <div ref={card} data-testid="people-card" {...motionProps} data-anchor="start" role="dialog" aria-label={t('People')} onKeyDown={key}
      className="people-card menu-entry absolute start-0 top-full z-30 mt-2 w-[min(340px,calc(100vw-48px))] rounded-lg border border-line bg-float text-ink shadow-[var(--shadow)]">
      {editing ? <AttendeeEditor person={editing.p} onSave={save} onCancel={() => showList(editing.p)} /> : <>
        <div data-testid="people-list" className="people-list grouped-people overflow-y-auto p-1.5">
          {groups.map(group => <section key={group.domain} aria-label={group.label || t('Other people')}>
            <h4 className="company-heading" title={group.domain || undefined}>{group.label || t('Other people')}</h4>
            <ul>{group.people.map(({ p, i, mine }) => <Row key={searchPersonKey(p) + ':' + i} person={p} index={i} mine={mine}
              onEdit={mine ? undefined : () => setEditing({ p, i })} onRemove={mine ? undefined : () => remove(p, i)} />)}</ul>
          </section>)}
        </div>
        <div className={`border-t border-line ${adding ? 'p-3' : ''}`}>
          <button ref={addButton} data-testid="people-add-open" onClick={() => { setAdding(true); input.current?.focus() }} className={`flex w-full items-center gap-2 text-start text-[13px] text-muted ${adding ? 'mb-2' : 'h-11 px-4 hover:bg-card'}`}><Plus size={14} aria-hidden="true" />{t('Add an attendee')}</button>
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
          <Lock size={12} aria-hidden="true" className="mt-0.5 shrink-0" />
          <span>{t('Nothing is sent. This is only for your notes.')}</span>
        </p>}
        </div>
      </>}
    </div>
  )
}

function Row({ person, index, mine, onEdit, onRemove }: { person: Person; index: number; mine?: boolean; onEdit?: () => void; onRemove?: () => Promise<void> }) {
  const [removing, setRemoving] = useState(false)
  const name = personName(person.name)
  return (
    <li data-testid="people-row" data-me={mine ? '' : undefined} className={`person-row flex ${person.email ? 'min-h-[52px]' : 'min-h-10'} items-center gap-2 rounded-md px-2.5 py-1.5`}>
      <span className="person-initials" aria-hidden="true">{initials(name)}</span>
      <div className="min-w-0 flex-1 text-[13px]" title={person.email ?? undefined}>
        {onEdit ? <button disabled={removing} data-person-key={searchPersonKey(person)} data-index={index} data-testid="people-name" title={t('Edit attendee')} className="block max-w-full truncate text-start" onClick={onEdit}>{name}</button>
          : <span className="block truncate">{name}{mine && <span className="text-muted"> {t('(me)')}</span>}</span>}
        {person.email && <span data-testid="people-email" className="block truncate text-xs leading-[17px] text-muted">{person.email}</span>}
      </div>
      {onEdit && <button disabled={removing} data-testid="people-edit" aria-label={t('Edit attendee')} title={t('Edit attendee')} onClick={onEdit} className="ghost-btn workspace-icon person-action"><Pencil size={14} aria-hidden="true" /></button>}
      {onRemove && <button disabled={removing} data-testid="people-remove" aria-label={t('Remove from meeting')} title={t('Remove from meeting')}
        className="ghost-btn workspace-icon person-action" onClick={async () => {
          setRemoving(true)
          try { await onRemove() } finally { setRemoving(false) }
        }}><Trash2 size={14} aria-hidden="true" /></button>}
    </li>
  )
}

function AttendeeEditor({ person, onSave, onCancel }: { person: Person; onSave: (next: Person) => Promise<void>; onCancel: () => void }) {
  const [busy, setBusy] = useState(false)
  const [invalid, setInvalid] = useState<string | null>(null)
  const errorId = useId()
  const field = 'h-8 w-full min-w-0 rounded-md border border-line bg-card px-2.5 text-[13px] font-normal text-ink placeholder:text-muted aria-invalid:border-danger'
  const error = <p id={errorId} role="alert" className="text-xs text-danger">{invalid === 'email' ? t('Enter a valid email address.') : t('Enter a name.')}</p>
  return <form noValidate onSubmit={async e => {
    e.preventDefault()
    if (busy) return
    const invalidField = e.currentTarget.querySelector<HTMLInputElement>('input:invalid')
    if (invalidField) { setInvalid(invalidField.name); invalidField.focus(); return }
    const data = new FormData(e.currentTarget)
    setBusy(true)
    try { await onSave({ name: String(data.get('name')).trim(), email: String(data.get('email')).trim() || null }) }
    catch { toasts.add({ title: t("Yogurt couldn't make that change. Try again.") }) }
    finally { setBusy(false) }
  }}
    onInput={e => { if (invalid && !e.currentTarget.querySelector('[aria-invalid="true"]:invalid')) setInvalid(null) }}
    onKeyDown={e => {
      if (e.key === 'Escape' && !e.nativeEvent.isComposing) { e.preventDefault(); e.stopPropagation(); if (!busy) onCancel() }
    }}>
    <fieldset disabled={busy} className="grid min-w-0 gap-3 p-4">
      <h3 className="text-sm font-semibold">{t('Edit attendee')}</h3>
      <div className="grid gap-1">
        <label className="grid gap-1 text-xs font-medium">{t('Name')}
          <input name="name" data-testid="people-rename" autoFocus defaultValue={personName(person.name)} required pattern={'.*\\S.*'} maxLength={200}
            aria-invalid={invalid === 'name' || undefined} aria-describedby={invalid === 'name' ? errorId : undefined} className={field} />
        </label>
        {invalid === 'name' && error}
      </div>
      <div className="grid gap-1">
        <label className="grid gap-1 text-xs font-medium">{t('Email')}
          <input name="email" type="email" defaultValue={person.email ?? ''} pattern={'.+@.+\\..+'} maxLength={200} spellCheck={false} placeholder={t('Add email')}
            aria-invalid={invalid === 'email' || undefined} aria-describedby={invalid === 'email' ? errorId : undefined} className={field} />
        </label>
        {invalid === 'email' && error}
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onCancel} className="workspace-button">{t('Cancel')}</button>
        <button type="submit" className="workspace-button primary">{t('Save')}</button>
      </div>
    </fieldset>
  </form>
}
