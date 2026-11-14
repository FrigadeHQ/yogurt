import { Dialog } from '@animate-ui/react/primitives/base-ui/dialog'
import { MotionPopup } from './MotionPopup'
import { motion } from '../motion'
import { FolderGlyph } from './FolderAppearance'
import { Fragment, useEffect, useRef, useState } from 'react'
import { AudioLines, CalendarDays, FileText, FolderIcon, Keyboard, LogIn, MessageCircle, Monitor, Moon, PanelLeft, Search as SearchIcon, Settings, Sun, Trash2, UserRound, X } from 'lucide-react'
import type { SearchResult, SnippetPart, Folder, Person } from '../../../shared/types'
import { t, language } from '../../../shared/i18n'
import { command, keys, osWords } from '../keys'
import { markWords } from '../../../shared/highlight'
import { dayLabel, timeOf } from '../dates'
import { parseSearchQuery } from '../../../shared/searchQuery'
import { completeSearchPerson, matchSearchPeople, removeSearchSpan, searchPersonKey, uniqueSearchPeople, type SearchPersonMatch } from '../../../shared/searchPeople'
import { searchPalette, searchSelectionKey } from '../searchRanking'
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
export function Search({ folder, folders, onOpen, onNavigate, onSettingsChange, onShortcuts, onClose, sidebarCollapsed, onToggleSidebar }: {
  folder?: Folder; folders?: Folder[]; onOpen: (id: string) => void; onNavigate: (route: string, agendaDate?: number) => void; onSettingsChange: () => void; onShortcuts: () => void; onClose: () => void
  sidebarCollapsed: boolean; onToggleSidebar: () => void
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
  const filtered = !!parsed.date || selectedPeople.length > 0
  const [results, setResults] = useState<{ q: string; scopeId?: string; peopleKey: string; list: SearchResult[] }>()
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
    const mine = ++seq.current
    const run = () => void window.yogurt.search.query(q, scope?.id, selectedPeople).then((list) => {
      // an answer to an older question never replaces a newer one
      if (mine !== seq.current) return
      setResults({ q, scopeId: scope?.id, peopleKey, list }); setActive(null)
    })
    if (!q.trim()) { run(); return }
    const timer = setTimeout(run, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [q, scope, peopleKey, people, searchOptions.language, searchOptions.locale])

  // focus goes back where it was when search closes: read during the first render, before the input takes it
  const [before] = useState(() => document.activeElement as HTMLElement | null)
  useEffect(() => () => { seq.current++; if (before?.isConnected) before.focus({ preventScroll: true }) }, [before])
  const input = useRef<HTMLInputElement>(null)
  const highlight = useRef<HTMLDivElement>(null)
  const syncHighlight = () => { if (highlight.current && input.current) highlight.current.scrollLeft = input.current.scrollLeft }
  useEffect(syncHighlight, [q])

  // Keep one coherent result set on screen until the next search is ready.
  const typed = (results?.q ?? '').trim()
  const settled = results?.q === q && results?.scopeId === scope?.id && results?.peopleKey === peopleKey
  const items = results?.list ?? []
  const navigate = (route: string) => { onNavigate(route) }
  const settingsAction = async (run: () => Promise<void>) => { await run(); onSettingsChange() }
  const dateCommand = window.yogurt.capabilities.calendar ? searchDateCommand(parsed.date, q) : undefined
  const allCommands = [
    ...(dateCommand ? [{ ...dateCommand, Icon: CalendarDays, run: () => onNavigate('', dateCommand.at) }] : []),
    { id: 'meetings', label: t('Meetings'), group: t('Go to'), Icon: FileText, run: () => navigate(''), shortcut: keys('⌘1') },
    { id: 'chat', synonyms: ['chat'], label: t('Ask'), group: t('Go to'), Icon: MessageCircle, run: () => navigate('/chat'), shortcut: keys('⌘2') },
    { id: 'trash', label: t('Trash'), group: t('Go to'), Icon: Trash2, run: () => navigate('/trash'), shortcut: keys('⌘3') },
    { id: 'settings', synonyms: ['preferences', 'prefs'], label: t('Settings'), group: t('Go to'), Icon: Settings, run: () => navigate('/settings'), shortcut: keys('⌘,') },
    { id: 'shortcuts', label: t('Keyboard shortcuts'), group: t('Go to'), Icon: Keyboard, run: onShortcuts, shortcut: keys('⌘/') },
    { id: 'sidebar', label: sidebarCollapsed ? t('Show Sidebar') : t('Hide Sidebar'), group: t('View'), Icon: PanelLeft, run: onToggleSidebar, shortcut: keys('⌃⌘S') },
    ...(folders ?? []).map((f) => ({ id: `folder-${f.id}`, label: f.name, group: t('Folders'), Icon: FolderIcon, folder: f, run: () => navigate(`/folder/${f.id}`) })),
    { id: 'theme-light', synonyms: ['theme', 'appearance', 'mode', 'light'], label: t('Light theme'), group: t('Appearance'), Icon: Sun, run: () => settingsAction(() => window.yogurt.settings.setTheme('light')) },
    { id: 'theme-dark', synonyms: ['theme', 'appearance', 'mode', 'dark'], label: t('Dark theme'), group: t('Appearance'), Icon: Moon, run: () => settingsAction(() => window.yogurt.settings.setTheme('dark')) },
    { id: 'theme-system', synonyms: ['theme', 'appearance', 'mode', 'system'], label: osWords({ mac: t('Match my Mac'), windows: t('Match Windows'), linux: t('Match my system') }), group: t('Appearance'), Icon: Monitor, run: () => settingsAction(() => window.yogurt.settings.setTheme('system')) },
    ...(prefs ? [
      { id: 'login', label: prefs.openAtLogin ? t('Turn off open at login') : t('Open Yogurt at login'), group: t('Settings'), Icon: LogIn, run: () => settingsAction(() => window.yogurt.settings.setOpenAtLogin(!prefs.openAtLogin)) },
      { id: 'auto-stop', label: prefs.stopWhenCallEnds ? t('Keep recording when the call ends') : t('Finish recording when the call ends'), group: t('Settings'), Icon: AudioLines, run: () => settingsAction(() => window.yogurt.settings.setStopWhenCallEnds(!prefs.stopWhenCallEnds)) },
    ] : []),
  ].filter((c) => !c.id.startsWith('theme-') || !!prefs)
  const suggestions = matchSearchPeople(typed, people, chosenPeople, searchOptions).suggestions.slice(0, 5)
  const defaultSelection = useRef<string | undefined>(undefined)
  const palette = searchPalette(allCommands, items, typed, q, suggestions, defaultSelection.current, filtered)
  const rows = palette.rows
  const count = rows.length
  const activeIndex = active ?? palette.active
  const selected = rows[activeIndex]
  useEffect(() => {
    defaultSelection.current = q.trim() && rows[palette.active] ? searchSelectionKey(rows[palette.active]) : undefined
  })
  const intent = !q.trim() && active === null ? 'search' : selected?.kind === 'command' ? `command:${selected.command.id}` : selected?.kind === 'ask' ? 'ask' : selected?.kind === 'person' ? 'person' : 'search'
  const dateLabel = parsed.date && searchDateLabel(parsed.date)
  const clearDate = () => { if (parsed.dateSpan) setQ(removeSearchSpan(q, parsed.dateSpan)); setActive(null); input.current?.focus() }
  const clearPerson = (person: Person) => {
    const key = searchPersonKey(person)
    setChosenPeople(current => current.filter(p => searchPersonKey(p) !== key))
    const match = personQuery.matches.find(m => searchPersonKey(m.person) === key)
    if (match) setQ(removeSearchSpan(q, match))
    setActive(null); input.current?.focus()
  }
  const pickPerson = (choice: SearchPersonMatch) => {
    const match = personQuery.suggestions.find(m => searchPersonKey(m.person) === searchPersonKey(choice.person))
    if (!match) return
    setChosenPeople(current => uniqueSearchPeople([...current.filter(p => p.name !== match.person.name), match.person]))
    setQ(completeSearchPerson(q, match)); setActive(null); input.current?.focus()
  }
  useEffect(() => {
    if (!scrollSelection.current) return
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, results])
  const runCommand = async (command: typeof allCommands[number]) => {
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
      onNavigate(`/chat/${sent}`); setOpen(false)
    } catch { setError(true); setRunning(false) }
  }
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return
    if ((e.key === 'Enter' || e.key === ' ') && e.target instanceof HTMLButtonElement) return
    if (e.key === 'ArrowDown') { e.preventDefault(); scrollSelection.current = true; setActive(Math.min(Math.max(0, count - 1), activeIndex + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); scrollSelection.current = true; setActive(Math.max(0, activeIndex - 1)) }
    else if (e.key === 'Backspace' && (parsed.date || selectedPeople.length) && e.target === input.current && input.current?.selectionStart === 0 && input.current.selectionEnd === 0) { e.preventDefault(); if (parsed.date) clearDate(); else clearPerson(selectedPeople[selectedPeople.length - 1]) }
    else if (e.key === 'Enter') { e.preventDefault(); if (command(e)) { if (q.trim()) void ask(q.trim()) } else enter() }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false) }
    else if (e.key === 'Tab') {
      e.preventDefault()
      if (!e.shiftKey && e.target === input.current && selected?.kind === 'person') { pickPerson(selected); return }
      const controls = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('input, button'))
      const at = controls.indexOf(document.activeElement as HTMLElement)
      controls[(at + (e.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus()
    }
  }
  /** what is shown answers what is typed: open the one picked; typed faster than the search: ask now and open its first */
  const enter = () => {
    if (selected?.kind === 'person') { pickPerson(selected); return }
    if (selected?.kind === 'ask' && active !== null) { void ask(selected.query); return }
    if (settled) {
      if (selected?.kind === 'ask') void ask(selected.query)
      else if (selected?.kind === 'meeting') onOpen(selected.meeting.meetingId)
      else if (selected?.kind === 'command') void runCommand(selected.command)
      return
    }
    const mine = ++seq.current
    void window.yogurt.search.query(q, scope?.id, selectedPeople).then((list) => {
      if (mine !== seq.current) return
      const next = searchPalette(allCommands, list, q, q, personQuery.suggestions, defaultSelection.current, filtered)
      const first = next.rows[next.active]
      if (first?.kind === 'ask') void ask(first.query)
      else if (first?.kind === 'meeting') onOpen(first.meeting.meetingId)
      else if (first?.kind === 'command') void runCommand(first.command)
      else { setResults({ q, scopeId: scope?.id, peopleKey, list }); setActive(null) }
    })
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Portal keepMounted>
      <Dialog.Backdrop className="search-backdrop no-drag fixed inset-0 z-[100]" transition={{ ease: motion.out, duration: motion.micro / 1000 }} exitTransition={{ ease: motion.out, duration: motion.micro / 1000 }} />
      <MotionPopup initialFocus={input} finalFocus={() => before} data-testid="search" role="dialog" aria-modal="true" aria-label={t('Search and commands')} onKeyDown={onKeyDown}
        // a click anywhere in the panel keeps typing, arrows and Esc in the search box
        onMouseDown={(e) => { if (e.target !== input.current) { e.preventDefault(); input.current?.focus() } }}
        className="search-panel flex max-h-[74vh] w-full max-w-[640px] flex-col overflow-hidden rounded-2xl border border-line bg-float">
        <div className="search-header">
          <div className="search-input-row">
            <span data-testid="search-intent-icon" data-icon={intent} className="flex shrink-0 text-muted" aria-hidden="true">
              {{
                search: <SearchIcon size={24} strokeWidth={1.6} />,
                ask: <MessageCircle size={24} strokeWidth={1.6} />,
                person: <UserRound size={24} strokeWidth={1.6} />,
                ...Object.fromEntries(allCommands.map(c => [`command:${c.id}`, 'folder' in c
                  ? <FolderGlyph appearance={c.folder} size={24} /> : <c.Icon size={24} strokeWidth={1.6} />])),
              }[intent]}
            </span>
            <div className="search-field">
              <div ref={highlight} className="search-input-highlight" aria-hidden="true">
                <span>{searchFilterHighlights(q, personQuery.matches, parsed.dateSpan).map((part, i) => part.kind
                  ? <mark key={i} data-testid={`search-${part.kind}-highlight`}>{part.text}</mark> : <Fragment key={i}>{part.text}</Fragment>)}</span>
              </div>
              <input
                data-testid="search-input" ref={input} autoFocus value={q} onChange={(e) => { scrollSelection.current = true; setQ(e.target.value); setActive(null); setError(false) }} onScroll={syncHighlight}
                placeholder={t('Search meetings or run a command…')} aria-label={t('Search')} spellCheck={false}
                role="combobox" aria-expanded="true" aria-controls="search-results" aria-activedescendant={selected?.kind === 'meeting' ? `search-${selected.meeting.meetingId}` : selected?.kind === 'command' ? `command-${selected.command.id}` : selected?.kind === 'person' ? `search-person-${encodeURIComponent(searchPersonKey(selected.person))}` : selected ? 'search-ask' : undefined}
              />
            </div>
          </div>
          {(scope || dateLabel || selectedPeople.length > 0) && <div className="search-filters">
            {scope && <span data-testid="search-scope" className="search-filter">
              <FolderGlyph appearance={scope} size={14} /><span className="truncate">{scope.name}</span>
              <button data-testid="search-scope-clear" onClick={() => { setScope(undefined); input.current?.focus() }} aria-label={t('Search all meetings')} title={t('Search all meetings')}><X size={13} aria-hidden="true" /></button>
            </span>}
            {selectedPeople.map(person => <span key={searchPersonKey(person)} data-testid="search-person-filter" className="search-filter">
              <UserRound size={14} aria-hidden="true" /><span className="truncate" title={person.email || person.name}>{person.name || person.email}</span>
              <button onClick={() => clearPerson(person)} aria-label={t('Remove {name}', { name: person.name || person.email || '' })}><X size={13} aria-hidden="true" /></button>
            </span>)}
            {dateLabel && <span data-testid="search-date" className="search-filter">
              <CalendarDays size={14} aria-hidden="true" /><span className="truncate" title={dateLabel}>{dateLabel}</span>
              <button data-testid="search-date-clear" onClick={clearDate} aria-label={t('Remove {name}', { name: dateLabel })}><X size={13} aria-hidden="true" /></button>
            </span>}
          </div>}
        </div>
        <ul ref={list} id="search-results" role="listbox" aria-label={t('Results')} aria-busy={running || !settled} className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none] px-2.5 pb-3">
          {rows.map((row, i) => {
            const previous = rows[i - 1]
            if (row.kind === 'ask') return <Fragment key="ask">
              <li role="presentation" className="command-section">{t('Ask')}</li>
              <li id="search-ask" data-testid="search-ask" role="option" aria-selected={activeIndex === i} aria-disabled={running}
                onMouseMove={(e) => hover(e, i)} onClick={() => void ask(row.query)} className="search-row command-row">
                <MessageCircle size={16} strokeWidth={1.75} aria-hidden="true" />
                <span className="shrink-0 text-accent">{t('Ask Yogurt')}</span><span className="command-label truncate">{row.query}</span>
                <kbd className="search-key search-return" aria-hidden="true">↵</kbd>
              </li>
            </Fragment>
            if (row.kind === 'person') return <Fragment key={searchPersonKey(row.person)}>
              {previous?.kind !== 'person' && <li role="presentation" className="command-section">{t('People')}</li>}
              <li id={`search-person-${encodeURIComponent(searchPersonKey(row.person))}`} data-testid="search-person" role="option" aria-selected={activeIndex === i}
                onMouseMove={(e) => hover(e, i)} onClick={() => pickPerson(row)} className="search-row command-row">
                <UserRound size={16} strokeWidth={1.75} aria-hidden="true" />
                <span className="command-label">{t('Meetings with {name}', { name: row.person.name || row.person.email || '' })}</span>
                {row.person.email && <span className="search-metadata truncate">{row.person.email}</span>}
                <kbd className="search-key search-return" aria-hidden="true">↵</kbd>
              </li>
            </Fragment>
            if (row.kind === 'meeting') {
              const r = row.meeting
              return <Fragment key={r.meetingId}>
                {previous?.kind !== 'meeting' && <li role="presentation" className="command-section">{typed || filtered ? t('Meetings') : t('Recent meetings')}</li>}
                <li
                  id={`search-${r.meetingId}`} data-testid="search-result" role="option" aria-selected={i === activeIndex}
                  onMouseMove={(e) => hover(e, i)} onClick={() => onOpen(r.meetingId)}
                  className="search-row search-meeting"
                >
                  <span className="search-result-icon"><FileText size={17} strokeWidth={1.6} aria-hidden="true" /></span>
                  <span className="min-w-0 flex-1">
                    <span data-testid="search-result-title" className="block truncate text-sm font-medium leading-5"><Marked parts={markWords(r.title, typed)} /></span>
                    {typed && r.parts.length > 0 && <span className="mt-0.5 line-clamp-1 text-[13px] leading-relaxed text-muted"><Marked parts={r.parts} /></span>}
                  </span>
                  <time className="search-metadata" dateTime={new Date(r.startedAt).toISOString()}>{dayLabel(r.startedAt)}<span>{timeOf(r.startedAt)}</span></time>
                  <kbd className="search-key search-return" aria-hidden="true">↵</kbd>
                </li>
              </Fragment>
            }
            const c = row.command
            const current = c.id === `theme-${prefs?.theme}`
            return <li key={c.id} role="presentation">
              {(previous?.kind !== 'command' || previous.command.group !== c.group) && <p className="command-section">{c.group}</p>}
              <div id={`command-${c.id}`} data-testid={`command-${c.id}`} role="option" aria-selected={activeIndex === i} aria-current={current || undefined} aria-disabled={running}
                onMouseMove={(e) => hover(e, i)} onClick={() => void runCommand(c)} className="search-row command-row">
                {'folder' in c ? <FolderGlyph appearance={c.folder} /> : <c.Icon size={16} strokeWidth={1.75} aria-hidden="true" />}
                <span className="command-label">{c.label}{current && <span aria-hidden="true"> ✓</span>}</span>{'shortcut' in c && <kbd className="search-key search-shortcut">{c.shortcut}</kbd>}
                <kbd className="search-key search-return" aria-hidden="true">↵</kbd>
              </div>
            </li>
          })}
        {settled && filtered && !items.length && <li role="presentation" data-testid="search-filter-empty" className="px-5 py-8 text-center text-sm text-muted">
          {searchFilterEmptyMessage(selectedPeople, dateLabel)}
        </li>}
        {results && !count && !filtered && (
          <li role="presentation" data-testid="search-none" className="flex h-full items-center justify-center px-5 py-8 text-center text-sm text-muted">
            {scope ? t('No meetings in this folder yet.') : t('No notes yet.')}
          </li>
        )}
        </ul>
        {error && <p role="alert" className="px-5 pb-3 text-xs text-danger">{t("Yogurt couldn't make that change. Try again.")}</p>}
        <div className="search-footer">
          <span><kbd className="search-key">↑↓</kbd>{t('Navigate')}</span>
          <span data-testid="search-primary-hint"><kbd className="search-key">↵</kbd>{t('Select')}</span>
          <span data-testid="search-secondary-hint"><kbd className="search-key">{keys('⌘↵')}</kbd>{t('Ask')}</span>
          <span><kbd className="search-key">esc</kbd>{t('Close')}</span>
          <button data-testid="search-shortcuts" onClick={onShortcuts} aria-label={t('Keyboard shortcuts')} title={`${t('Keyboard shortcuts')} ${keys('⌘/')}`}><Keyboard size={15} aria-hidden="true" /></button>
        </div>
      </MotionPopup>
    </Dialog.Portal>
    </Dialog.Root>
  )
}
