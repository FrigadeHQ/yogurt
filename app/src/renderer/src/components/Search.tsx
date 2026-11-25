import { settingsRoute, settingsSections } from '../../../shared/routes'
import { sections } from '../settingsSections'
import { useDialogFocus } from '../useDialogFocus'
import { InlineError } from './InlineError'
import { Dialog } from '@animate-ui/react/primitives/base-ui/dialog'
import { MotionPopup } from './MotionPopup'
import { motion } from '../motion'
import { FolderGlyph } from './FolderAppearance'
import { Fragment, useEffect, useRef, useState } from 'react'
import { AudioLines, CalendarDays, FileText, Folder as FolderIcon, Keyboard, LogIn, MessageCircle, Monitor, Moon, PanelLeft, Settings, Sun, Trash2, UserRound, X } from './Icons'
import type { SearchResult, SnippetPart, Folder, Person } from '../../../shared/types'
import { t, language } from '../../../shared/i18n'
import { command, keys, osWords } from '../keys'
import { markWords } from '../../../shared/highlight'
import { dayLabel, timeOf } from '../dates'
import { parseSearchQuery } from '../../../shared/searchQuery'
import { completeSearchPerson, matchSearchPeople, removeSearchSpan, searchPersonKey, uniqueSearchPeople, type SearchPersonMatch } from '../../../shared/searchPeople'
import { isSearchQuestion, searchPalette, searchSelectionKey } from '../searchRanking'
import { searchDateCommand, searchDateLabel, searchFilterEmptyMessage, searchFilterHighlights } from '../searchFilters'

/** typing settles this long before the search runs */
const DEBOUNCE_MS = 120

/** Pieces of text with the matched words marked: React text nodes only, so nothing in a note can run as markup */
function Marked({ parts }: { parts: SnippetPart[] }) {
  return <>{parts.map((p, i) => (p.hit ? <mark key={i} className="search-mark">{p.text}</mark> : <span key={i}>{p.text}</span>))}</>
}

/**
 * ⌘K searches meetings and the app's destinations and actions. A folder scopes meeting results and new questions.
 */
export function Search({ inSettings = false, folder, folders, onOpen, onNavigate, onSettingsChange, onShortcuts, onClose, sidebarCollapsed, onToggleSidebar }: {
  inSettings?: boolean; folder?: Folder; folders?: Folder[]; onOpen: (id: string) => void; onNavigate: (route: string, agendaDate?: number) => void; onSettingsChange: () => void; onShortcuts: () => void; onClose: () => void
  sidebarCollapsed: boolean; onToggleSidebar?: () => void
}) {
  const [open, setOpen] = useState(true)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    if (open) return
    const timer = setTimeout(() => close.current(), motion.micro)
    return () => clearTimeout(timer)
  }, [open])
  const [q, setQ] = useState('')
  const [scope, setScope] = useState(folder)
  const [people, setPeople] = useState<Person[]>([])
  const [chosenPeople, setChosenPeople] = useState<Person[]>([])
  const searchOptions = { locale: navigator.language, language: language() }
  const personQuery = matchSearchPeople(q, people, chosenPeople, searchOptions)
  const selectedPeople = uniqueSearchPeople(personQuery.matches.map(m => m.person))
  const peopleKey = selectedPeople.map(searchPersonKey).join('|')
  const parsed = parseSearchQuery(personQuery.text, searchOptions)
  const request = { q, scope, peopleKey, people: selectedPeople, date: parsed.date, jumpAt: parsed.jumpAt, suggestions: personQuery.suggestions.slice(0, 5) }
  const [results, setResults] = useState<typeof request & { list: SearchResult[] }>()
  const [active, setActive] = useState<number | null>(null)
  const [prefs, setPrefs] = useState<Awaited<ReturnType<typeof window.yogurt.settings.get>>>()
  const [error, setError] = useState(false)
  const [running, setRunning] = useState(false)
  useEffect(() => { void window.yogurt.settings.get().then(setPrefs) }, [])
  useEffect(() => {
    let live = true
    const load = () => void window.yogurt.search.people().then(p => { if (live) setPeople(p) }).catch(() => { if (live) setError(true) })
    load()
    const off = window.yogurt.meetings.onChange(load)
    return () => { live = false; off() }
  }, [])
  const [queryFailed, setQueryFailed] = useState(false)
  const retry = useRef<() => void>(() => {})
  const seq = useRef(0)
  const list = useRef<HTMLUListElement>(null)
  const scrollSelection = useRef(false)
  const hover = (e: React.MouseEvent, index: number) => {
    // Chromium can send a stationary mousemove when the popup or its rows move under the pointer.
    if (!e.movementX && !e.movementY) return
    scrollSelection.current = false
    setActive(index)
  }

  useEffect(() => {
    const scheduled = ++seq.current
    setQueryFailed(false)
    const run = (sequence: number) => {
      // Enter or Retry can supersede this read before the debounce fires.
      if (sequence !== seq.current) return
      void window.yogurt.search.query(q, scope?.id, selectedPeople).then(list => {
        if (sequence !== seq.current) return
        setQueryFailed(false); setResults({ ...request, list }); setActive(null)
      }, () => { if (sequence === seq.current) setQueryFailed(true) })
    }
    retry.current = () => run(++seq.current)
    if (!q.trim()) { run(scheduled); return }
    const timer = setTimeout(() => run(scheduled), DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [q, scope, peopleKey, people, searchOptions.language, searchOptions.locale])

  const { popupRef } = useDialogFocus()
  useEffect(() => () => { seq.current++ }, [])
  const input = useRef<HTMLInputElement>(null)
  const highlight = useRef<HTMLDivElement>(null)
  const syncHighlight = () => { if (highlight.current && input.current) highlight.current.scrollLeft = input.current.scrollLeft }
  useEffect(syncHighlight, [q])

  // Keep one coherent result set on screen until the next search is ready.
  const typed = results?.q.trim() ?? ''
  const settled = results?.q === q && results?.scope?.id === scope?.id && results?.peopleKey === peopleKey
  const shown = results ?? request
  const filtered = !!shown.date || shown.people.length > 0
  const navigate = (route: string) => { onNavigate(route) }
  const settingsAction = async (run: () => Promise<void>) => { await run(); onSettingsChange() }
  const sectionCommands = inSettings ? settingsSections.map(id => ({
    id: 'settings-' + id, label: sections[id].label(),
    group: t('Go to'), Icon: sections[id].icon, run: () => navigate(settingsRoute(id)),
  })) : []
  const allCommands: {
    id: string; label: string; group: string; Icon: typeof Settings; run(): void | Promise<void>
    synonyms?: string[]; shortcut?: string; folder?: Folder
  }[] = [
    { id: 'meetings', label: t('Meetings'), group: t('Go to'), Icon: FileText, run: () => navigate(''), shortcut: keys('⌘1') },
    { id: 'chat', synonyms: ['chat'], label: t('Ask'), group: t('Go to'), Icon: MessageCircle, run: () => navigate('/chat'), shortcut: keys('⌘2') },
    { id: 'trash', label: t('Trash'), group: t('Go to'), Icon: Trash2, run: () => navigate('/trash'), shortcut: keys('⌘3') },
    { id: 'settings', synonyms: ['preferences', 'prefs'], label: t('Settings'), group: t('Go to'), Icon: Settings, run: () => navigate('/settings'), shortcut: keys('⌘,') },
    ...sectionCommands,
    { id: 'shortcuts', label: t('Keyboard shortcuts'), group: t('Go to'), Icon: Keyboard, run: onShortcuts, shortcut: keys('⌘/') },
    ...(onToggleSidebar ? [{ id: 'sidebar', label: sidebarCollapsed ? t('Show Sidebar') : t('Hide Sidebar'), group: t('Go to'), synonyms: [t('View')], Icon: PanelLeft, run: onToggleSidebar, shortcut: keys('⌃⌘S') }] : []),
    ...(folders ?? []).map((f) => ({ id: `folder-${f.id}`, label: f.name, group: t('Go to'), synonyms: [t('Folders')], Icon: FolderIcon, folder: f, run: () => navigate(`/folder/${f.id}`) })),
    { id: 'theme-light', synonyms: ['theme', 'appearance', 'mode', 'light'], label: t('Light theme'), group: t('Appearance'), Icon: Sun, run: () => settingsAction(() => window.yogurt.settings.setTheme('light')) },
    { id: 'theme-dark', synonyms: ['theme', 'appearance', 'mode', 'dark'], label: t('Dark theme'), group: t('Appearance'), Icon: Moon, run: () => settingsAction(() => window.yogurt.settings.setTheme('dark')) },
    { id: 'theme-system', synonyms: ['theme', 'appearance', 'mode', 'system'], label: osWords({ mac: t('Match my Mac'), windows: t('Match Windows'), linux: t('Match my system') }), group: t('Appearance'), Icon: Monitor, run: () => settingsAction(() => window.yogurt.settings.setTheme('system')) },
    ...(prefs ? [
      { id: 'login', label: prefs.openAtLogin ? t('Turn off open at login') : t('Open Yogurt at login'), group: t('Settings'), Icon: LogIn, run: () => settingsAction(() => window.yogurt.settings.setOpenAtLogin(!prefs.openAtLogin)) },
      { id: 'auto-stop', label: prefs.stopWhenCallEnds ? t('Keep recording when the call ends') : t('Stop recording when the call ends'), group: t('Settings'), Icon: AudioLines, run: () => settingsAction(() => window.yogurt.settings.setStopWhenCallEnds(!prefs.stopWhenCallEnds)) },
    ] : []),
  ].filter(c => (!c.id.startsWith('theme-') || !!prefs) && (c.id !== 'auto-stop' || prefs?.detectMeetingsAutomatically !== false))
  const defaultSelection = useRef<string | undefined>(undefined)
  const rank = (search: typeof request, list: SearchResult[]) => {
    const date = searchDateCommand(search.jumpAt, search.q)
    const commands = date ? [{ ...date, Icon: CalendarDays, run: () => onNavigate('', date.at) }, ...allCommands] : allCommands
    const matches = searchPalette(commands, list, search.q, search.q, search.suggestions, defaultSelection.current, !!search.date || search.people.length > 0)
    if (!search.q.trim()) {
      const destinations = inSettings ? sectionCommands : commands.filter(c => c.id === 'settings')
      const rows = destinations.map(command => ({ kind: 'command' as const, command, score: 0 }))
      if (inSettings) matches.rows.unshift(...rows)
      else matches.rows.push(...rows)
    }
    return matches
  }
  const palette = results ? rank(results, results.list) : { rows: [], active: 0 }
  const rows = palette.rows
  const count = rows.length
  const activeIndex = active !== null && rows[active] ? active : palette.active
  const selected = rows[activeIndex]
  useEffect(() => {
    if (settled) defaultSelection.current = typed && rows[palette.active] ? searchSelectionKey(rows[palette.active]) : undefined
  })
  const dateLabel = shown.date && searchDateLabel(shown.date)
  const clearDate = () => { if (parsed.dateSpan) setQ(removeSearchSpan(q, parsed.dateSpan)); input.current?.focus() }
  const clearPerson = (person: Person) => {
    const key = searchPersonKey(person)
    setChosenPeople(current => current.filter(p => searchPersonKey(p) !== key))
    const match = personQuery.matches.find(m => searchPersonKey(m.person) === key)
    if (match) setQ(removeSearchSpan(q, match))
    input.current?.focus()
  }
  const pickPerson = (choice: SearchPersonMatch) => {
    const match = personQuery.suggestions.find(m => searchPersonKey(m.person) === searchPersonKey(choice.person))
    if (!match) return
    setChosenPeople(current => uniqueSearchPeople([...current.filter(p => p.name !== match.person.name), match.person]))
    setQ(completeSearchPerson(q, match)); input.current?.focus()
  }
  useEffect(() => {
    if (!scrollSelection.current) return
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, results])
  const runCommand = async (command: Pick<typeof allCommands[number], 'id' | 'run'>) => {
    if (running) return
    setRunning(true); setError(false)
    try {
      if (command.id !== `theme-${prefs?.theme}`) await command.run()
      setOpen(false)
    } catch { setError(true); setRunning(false) }
  }
  const ask = async (query: string) => {
    if (running || !query.trim()) return
    setRunning(true); setError(false)
    try {
      const id = await window.yogurt.conversations.current(scope ? [{ kind: 'folder', id: scope.id }] : [], true)
      const sent = await window.yogurt.conversations.ask(id, query)
      if (!sent) throw new Error('Question was not saved')
      if (typeof sent !== 'string') await window.yogurt.conversations.draft(id, query)
      onNavigate(`/chat/${typeof sent === 'string' ? sent : id}`); setOpen(false)
    } catch { setError(true); setRunning(false) }
  }
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter' && command(e)) { e.preventDefault(); if (q.trim()) void ask(q.trim()); return }
    if ((e.key === 'Enter' || e.key === ' ') && e.target instanceof HTMLButtonElement) return
    if (e.key === 'ArrowDown') { e.preventDefault(); scrollSelection.current = true; setActive(Math.min(Math.max(0, count - 1), activeIndex + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); scrollSelection.current = true; setActive(Math.max(0, activeIndex - 1)) }
    else if (e.key === 'Backspace' && (parsed.date || selectedPeople.length) && e.target === input.current && input.current?.selectionStart === 0 && input.current.selectionEnd === 0) { e.preventDefault(); if (parsed.date) clearDate(); else clearPerson(selectedPeople[selectedPeople.length - 1]) }
    else if (e.key === 'Enter') { e.preventDefault(); enter() }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false) }
    else if (e.key === 'Tab') {
      e.preventDefault()
      if (!e.shiftKey && e.target === input.current && selected?.kind === 'person') { pickPerson(selected); return }
      const controls = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('input, button'))
      const at = controls.indexOf(document.activeElement as HTMLElement)
      controls[(at + (e.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus()
    }
  }
  const activate = (row: typeof rows[number] | undefined) => {
    if (row?.kind === 'meeting') onOpen(row.meeting.meetingId)
    else if (row?.kind === 'command') void runCommand(row.command)
    else if (row?.kind === 'person') pickPerson(row)
    else if (q.trim()) void ask(q.trim())
  }
  const enter = () => {
    if (queryFailed && q.trim()) { void ask(q.trim()); return }
    if (settled) { activate(selected); return }
    // Enter before the debounce finishes must act on the new query.
    if (isSearchQuestion(q)) { void ask(q.trim()); return }
    const mine = ++seq.current
    void window.yogurt.search.query(q, scope?.id, selectedPeople).then(list => {
      if (mine !== seq.current) return
      setQueryFailed(false); setResults({ ...request, list }); setActive(null)
      const next = rank(request, list)
      activate(next.rows[next.active])
    }).catch(() => { if (mine === seq.current) setQueryFailed(true) })
  }

  const enterAsks = queryFailed ? !!q.trim() : !!typed && !selected
  const primaryHint = enterAsks || selected?.kind === 'ask' ? t('Ask')
    : selected?.kind === 'meeting' ? t('Open note')
    : selected?.kind === 'command' && selected.command.group === t('Go to') && selected.command.id !== 'sidebar' ? t('Go to')
    : selected ? t('Select') : undefined

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Portal keepMounted>
      <Dialog.Backdrop className="search-backdrop no-drag fixed inset-0 z-[100]" transition={{ ease: motion.out, duration: motion.micro / 1000 }} exitTransition={{ ease: motion.out, duration: motion.micro / 1000 }} />
      <MotionPopup ref={popupRef} initialFocus={input} finalFocus={false} data-testid="search" role="dialog" aria-modal="true" aria-label={t('Search and commands')} onKeyDown={onKeyDown}
        // a click anywhere in the panel keeps typing, arrows and Esc in the search box
        onMouseDown={(e) => { if (e.target !== input.current) { e.preventDefault(); input.current?.focus() } }}
        className="search-panel flex max-h-[74vh] w-full flex-col overflow-hidden rounded-2xl border border-line bg-float">
        <div className="search-header">
          <div className="search-field">
            <div ref={highlight} className="search-input-highlight" aria-hidden="true">
              <span>{searchFilterHighlights(q, personQuery.matches, parsed.dateSpan).map((part, i) => part.kind
                ? <mark key={i} data-testid={`search-${part.kind}-highlight`}>{part.text}</mark> : <Fragment key={i}>{part.text}</Fragment>)}</span>
            </div>
            <input
              data-testid="search-input" ref={input} autoFocus value={q} onChange={(e) => { scrollSelection.current = true; setQ(e.target.value); setError(false) }} onScroll={syncHighlight}
              placeholder={t('Ask, search, or open a meeting…')} aria-label={t('Search')} spellCheck={false}
              role="combobox" aria-expanded="true" aria-controls="search-results" aria-activedescendant={selected?.kind === 'meeting' ? `search-${selected.meeting.meetingId}` : selected?.kind === 'command' ? `command-${selected.command.id}` : selected?.kind === 'person' ? `search-person-${encodeURIComponent(searchPersonKey(selected.person))}` : selected ? 'search-ask' : undefined}
            />
          </div>
          {(shown.scope || filtered) && <div className="search-filters">
            {shown.scope && <span data-testid="search-scope" className="search-filter">
              <FolderGlyph appearance={shown.scope} size={14} /><span className="truncate">{shown.scope.name}</span>
              <button data-testid="search-scope-clear" onClick={() => { setScope(undefined); input.current?.focus() }} aria-label={t('Search all meetings')} title={t('Search all meetings')}><X size={13} aria-hidden="true" /></button>
            </span>}
            {shown.people.map(person => <span key={searchPersonKey(person)} data-testid="search-person-filter" className="search-filter">
              <UserRound size={14} aria-hidden="true" /><span className="truncate" title={person.email || person.name}>{person.name || person.email}</span>
              <button onClick={() => clearPerson(person)} aria-label={t('Remove {name}', { name: person.name || person.email || '' })}><X size={13} aria-hidden="true" /></button>
            </span>)}
            {dateLabel && <span data-testid="search-date" className="search-filter">
              <CalendarDays size={14} aria-hidden="true" /><span className="truncate" title={dateLabel}>{dateLabel}</span>
              <button data-testid="search-date-clear" onClick={clearDate} aria-label={t('Remove {name}', { name: dateLabel })}><X size={13} aria-hidden="true" /></button>
            </span>}
          </div>}
        </div>
        {queryFailed && <InlineError testId="search-read-error"><span>{t("Couldn't load this content.")}</span>
          <div className="inline-error-actions">
            <button type="button" data-testid="search-retry" className="workspace-button" onClick={() => retry.current()}>{t('Try again')}</button>
            {!!q.trim() && <button type="button" className="workspace-button" onClick={() => void ask(q.trim())}>{t('Ask')}</button>}
          </div>
        </InlineError>}
        {queryFailed && results && <p className="px-5 text-xs text-muted">{t('Previous results')}{typed && ' · ' + typed}</p>}
        <ul ref={list} id="search-results" role="listbox" aria-label={t('Results')} aria-busy={running || !settled && !queryFailed} className="min-h-0 overflow-y-auto [overflow-anchor:none] px-2 pb-2 scroll-pb-2">
          {rows.map((row, i) => {
            const previous = rows[i - 1]
            const returnKey = activeIndex === i && <kbd className="search-key search-return" aria-hidden="true">↵</kbd>
            if (row.kind === 'ask') return <Fragment key="ask">
              <li role="presentation" className="command-section">{t('Ask')}</li>
              <li id="search-ask" data-testid="search-ask" role="option" aria-selected={activeIndex === i} aria-disabled={running}
                onMouseMove={(e) => hover(e, i)} onClick={() => void ask(row.query)} className="search-row command-row search-ask">
                <MessageCircle size={16} aria-hidden="true" />
                <span className="shrink-0">{t('Ask Yogurt')}</span><span aria-hidden="true">·</span><span className="command-label">{row.query}</span>
                {returnKey}
              </li>
            </Fragment>
            if (row.kind === 'person') return <Fragment key={searchPersonKey(row.person)}>
              {previous?.kind !== 'person' && <li role="presentation" className="command-section">{t('People')}</li>}
              <li id={`search-person-${encodeURIComponent(searchPersonKey(row.person))}`} data-testid="search-person" role="option" aria-selected={activeIndex === i}
                onMouseMove={(e) => hover(e, i)} onClick={() => pickPerson(row)} className="search-row command-row">
                <UserRound size={16} aria-hidden="true" />
                <span className="command-label">{t('Meetings with {name}', { name: row.person.name || row.person.email || '' })}</span>
                {row.person.email && <span className="search-metadata truncate">{row.person.email}</span>}
                {returnKey}
              </li>
            </Fragment>
            if (row.kind === 'meeting') {
              const r = row.meeting
              return <Fragment key={r.meetingId}>
                {previous?.kind !== 'meeting' && <li role="presentation" className="command-section">{typed || filtered ? t('Meetings') : t('Recent meetings')}</li>}
                <li
                  id={`search-${r.meetingId}`} data-testid="search-result" role="option" aria-selected={i === activeIndex} aria-describedby={i === activeIndex && r.preview ? 'search-preview' : undefined}
                  onMouseMove={(e) => hover(e, i)} onClick={() => onOpen(r.meetingId)}
                  className="search-row search-meeting"
                >
                  <span className="search-meeting-dot" aria-hidden="true" data-folder-color={r.folder?.color} title={r.folder?.name} />
                  <span className="min-w-0 flex-1">
                    <span data-testid="search-result-title" className="search-meeting-title"><Marked parts={markWords(r.title, typed)} /></span>
                    {r.attendees.length > 0 && <span className="search-attendees">{r.attendees.map(p => p.name || p.email).filter(Boolean).join(', ')}</span>}
                    {typed && !r.confident && r.parts.length > 0 && <span className="search-snippet"><Marked parts={r.parts} /></span>}
                  </span>
                  {r.folder && <span className="sr-only">{r.folder.name}</span>}
                  <time className="search-metadata" dateTime={new Date(r.startedAt).toISOString()}>{dayLabel(r.startedAt)} · {timeOf(r.startedAt)}</time>
                  {returnKey}
                </li>
              </Fragment>
            }
            const c = row.command
            const current = c.id === `theme-${prefs?.theme}`
            return <li key={c.id} role="presentation">
              {(previous?.kind !== 'command' || previous.command.group !== c.group) && <p className="command-section">{c.group}</p>}
              <div id={`command-${c.id}`} data-testid={`command-${c.id}`} role="option" aria-selected={activeIndex === i} aria-current={current || undefined} aria-disabled={running}
                onMouseMove={(e) => hover(e, i)} onClick={() => void runCommand(c)} className="search-row command-row">
                {'folder' in c && c.folder ? <FolderGlyph appearance={c.folder} /> : <c.Icon size={16} aria-hidden="true" />}
                <span className="command-label">{c.label}{current && <span aria-hidden="true"> ✓</span>}</span>
                {activeIndex === i && ('shortcut' in c
                  ? <kbd className="search-key search-shortcut">{c.shortcut}</kbd> : returnKey)}
              </div>
            </li>
          })}
        {results && filtered && !results.list.length && <li role="presentation" data-testid="search-filter-empty" className="px-5 py-8 text-center text-sm text-muted">
          {searchFilterEmptyMessage(shown.people, dateLabel)}
        </li>}
        {!queryFailed && results && !count && !filtered && (
          <li role="presentation" data-testid="search-none" className="flex h-full items-center justify-center px-5 py-8 text-center text-sm text-muted">
            {typed ? t('No matches') : shown.scope ? t('No meetings in this folder yet.') : t('No notes yet.')}
          </li>
        )}
        </ul>
        {selected?.kind === 'meeting' && selected.meeting.preview && <div id="search-preview" data-testid="search-preview" className="search-preview">
          <p>{selected.meeting.preview}</p>
        </div>}
        {error && <p role="alert" className="px-5 pb-3 text-xs text-danger">{t("Yogurt couldn't make that change. Try again.")}</p>}
        <div className="search-footer">
          {enterAsks
            ? <button className="search-ask-hint" data-testid="search-primary-hint" onClick={() => void ask(q.trim())}><kbd>↵</kbd>{t('Ask')}</button>
            : primaryHint && <span data-testid="search-primary-hint"><kbd>{selected?.kind === 'person' ? '⇥' : '↵'}</kbd>{primaryHint}</span>}
          {!!typed && primaryHint !== t('Ask')
            ? <button className="search-ask-hint" data-testid="search-secondary-hint" onClick={() => void ask(q.trim())}><kbd>{keys('⌘↵')}</kbd>{t('Ask')}</button>
            : count > 1 && <span><kbd>↑↓</kbd>{t('Navigate')}</span>}
          <span><kbd>esc</kbd>{t('Close')}</span>
          <button className="ghost-btn workspace-icon" data-testid="search-shortcuts" onClick={onShortcuts} aria-label={t('Keyboard shortcuts')} title={`${t('Keyboard shortcuts')} ${keys('⌘/')}`}><Keyboard size={15} aria-hidden="true" /></button>
        </div>
      </MotionPopup>
    </Dialog.Portal>
    </Dialog.Root>
  )
}
