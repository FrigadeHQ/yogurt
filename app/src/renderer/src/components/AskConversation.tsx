import { InlineError } from './InlineError'
import { useContext, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Popover } from '@base-ui/react/popover'
import { ArrowDown, ArrowUp, Check, Ellipsis, Maximize2, Square, X } from 'lucide-react'
import { attachContext, mentionAt, type ContextTarget } from '../../../shared/askContext'
import type { AskStep, ConversationTurn, ConversationView, LibrarySource } from '../../../shared/types'
import { t } from '../../../shared/i18n'
import { stepText, STEP_EVERY_MS } from '../../../shared/askStep'
import { dayLabel } from '../dates'
import { useSmoothText } from '../useSmoothText'
import { AnswerText } from './AnswerText'
import { Copy } from './Icons'
import { Loading } from './Loading'
import { LoadingContent } from './LoadingContent'
import { NotesModelWait } from './NotesModelWait'
import { ThinkingDots } from './ThinkingDots'
import { ConversationActions } from './ConversationActions'
import { ScrollFade } from './ScrollFade'
import { rememberedScroll, useScrollMemory } from '../useScrollMemory'
import { AnswerScope, AskContext, chipTitle, ContextIcon } from './AskContext'
import { useFollowLatest } from '../useFollowLatest'
import { Swap, SwapText } from './Swap'
import { attachAskTracer } from '../askTracer'
import { AskRecordingWait } from '../askAvailability'
import { onMac } from '../keys'
import { Tooltip } from '@base-ui/react/tooltip'
import { mentionPosition, textareaMentionRect } from '../mentionPlacement'

const drafts = new Map<string, string>()
const starters = (chips: ContextTarget[], recording: boolean) => chips.length === 1 && chips[0].kind === 'meeting'
  ? recording ? [t('What did I just miss?'), t('Sum up the meeting so far'), t('What should I ask next?')]
    : [t('What was decided?'), t('What are my next steps?'), t('What questions are still open?')]
  : chips.length ? [t('What was decided?'), t('What are my next steps?'), t('What questions are still open?')]
    : [t('What are my next steps this week?'), t('What did we decide last week?'), t('Catch me up on yesterday')]

/** One composer and thread for both the page and the note panel. Draft writes never wait for the model. */
export function AskConversation({ id, pendingDraftKey, initial, loadError = false, home = false, panel = false, recording = false, onSelect, onSource, onDeleted, onClose, onExpand }: {
  id: string; pendingDraftKey?: string; initial?: ConversationView; loadError?: boolean; home?: boolean; panel?: boolean; recording?: boolean; onDeleted: () => void; onClose?: () => void; onExpand?: () => void; onSelect: (id: string) => void; onSource: (source: LibrarySource, match?: string) => void
}) {
  const [chat, setChat] = useState(initial)
  const recordingWait = useContext(AskRecordingWait) ?? (onMac() && !!chat?.waitsForMeeting)
  const waitReason = recordingWait ? t('Available after recording') : undefined
  const [text, setText] = useState((pendingDraftKey ? drafts.get(pendingDraftKey) : undefined) ?? drafts.get(id) ?? initial?.draft ?? '')
  const edited = useRef(false)
  const [error, setError] = useState(false)
  const [readFailed, setReadFailed] = useState(false)
  const retryRead = useRef<() => void>(() => {})
  const [sending, setSending] = useState(false)
  const pendingQuestion = useRef<string>(undefined)
  const [changing, setChanging] = useState(false)
  const [mention, setMention] = useState<{ start: number; end: number; query: string }>()
  const [selector, setSelector] = useState<{ query: string }>()
  const dismissedMention = useRef(false)
  const query = selector?.query ?? mention?.query
  const [targetResults, setTargetResults] = useState<{ query: string; items: ContextTarget[] }>()
  // The bare list, kept so the picker opens already filled instead of flashing Loading.
  const bare = useRef<ContextTarget[]>(undefined)
  const prefetch = () => { if (!bare.current) void window.yogurt.conversations.targets('').then(items => { bare.current = items }).catch(() => {}) }
  const [expanded, setExpanded] = useState(false)
  const [scopeExpanded, setScopeExpanded] = useState(false)
  const chips = chat ? attachContext(chat.chips, chat.draftChips) : []
  const inScope = (c: ContextTarget) => chips.some(x => x.kind === c.kind && x.id === c.id)
  const items = (targetResults?.items ?? []).filter(c => query ? true : !inScope(c))
  const meetings = items.filter(c => c.kind === 'meeting')
  const folders = items.filter(c => c.kind === 'folder')
  const shownFolders = folders.slice(0, targetResults?.query ? 4 : 2)
  const shownMeetings = meetings.slice(0, targetResults?.query ? 10 - shownFolders.length : folders.length ? 3 : 5)
  const allTargets = [...meetings, ...folders]
  const targets = expanded ? allTargets : [...shownMeetings, ...shownFolders]
  const more = allTargets.length - targets.length
  const scoped = selector && !query ? chips.slice(0, scopeExpanded ? undefined : 3) : []
  const scopeMore = selector && !query ? chips.length - scoped.length : 0
  const offset = selector && !query ? scoped.length + (scopeMore ? 1 : 0) : 0
  const rowCount = offset + targets.length + (more ? 1 : 0)
  const [selected, setSelected] = useState(0)
  const input = useRef<HTMLTextAreaElement>(null)
  const composer = useRef<HTMLFormElement>(null)
  const tracer = useRef<ReturnType<typeof attachAskTracer>>(undefined)
  // the page's composer mounts once the conversation loads; the panel's is there from the start
  const composerReady = panel || !!chat || !!error
  useEffect(() => {
    if (recordingWait || !composerReady || !composer.current) return
    tracer.current = attachAskTracer(composer.current)
    return () => { tracer.current?.dispose(); tracer.current = undefined }
  }, [composerReady, recordingWait])
  useEffect(() => { tracer.current?.update() }, [text])
  const search = useRef<HTMLInputElement>(null)
  const mentionMenu = useRef<HTMLDivElement>(null)
  const savedSelection = useRef({ start: 0, end: 0 })
  const scrollKey = `conversation/${id}`
  const scroll = useScrollMemory<HTMLDivElement>(scrollKey, !!chat)
  const content = useRef<HTMLDivElement>(null)
  const follow = useFollowLatest(scroll, content, !!chat, rememberedScroll(scrollKey) === undefined)
  const loadingChat = !chat && !error && !readFailed && !loadError
  const prefix = panel ? 'chat' : 'chat-page'
  useEffect(() => {
    if (!id) return
    let active = true, revision = 0
    setError(false)
    const pending = pendingDraftKey ? drafts.get(pendingDraftKey) : undefined
    if (pending !== undefined) {
      edited.current = true
      drafts.set(id, pending)
      drafts.delete(pendingDraftKey!)
      void window.yogurt.conversations.draft(id, pending).then(() => {
        if (drafts.get(id) === pending) drafts.delete(id)
      }).catch(() => { if (active) setError(true) })
    }
    const off = window.yogurt.conversations.onChange(v => { if (v.id === id) { revision++; setReadFailed(false); setChat(v) } })
    const load = (first = false) => {
      setReadFailed(false)
      const request = ++revision
      void window.yogurt.conversations.get(id).then(v => {
        if (!active) return
        if (!v) throw new Error('Conversation not found')
        if (request !== revision) return
        setChat(v)
        if (first) {
          if (!initial && !edited.current) setText(drafts.get(id) ?? v.draft)
        }
      }).catch(() => {
        if (active && request === revision) {
          setReadFailed(true)
          if (pendingQuestion.current !== undefined) { pendingQuestion.current = undefined; setSending(false) }
        }
      })
    }
    const offMeetings = window.yogurt.meetings.onChange(() => load())
    const offFolders = window.yogurt.folders.onChange(() => load())
    retryRead.current = () => load(true)
    load(true)
    return () => { active = false; off(); offMeetings(); offFolders() }
  }, [id])
  useEffect(() => {
    let active = true
    if (query === undefined) { setTargetResults(undefined); setSelected(0); setExpanded(false); return }
    // Keep the last completed search visible until the replacement is ready.
    void window.yogurt.conversations.targets(query).then(items => {
      if (!active) return
      if (!query) bare.current = items
      setTargetResults({ query, items }); setSelected(0); setExpanded(false)
    }).catch(() => { if (active) setError(true) })
    return () => { active = false }
  }, [query, !!selector, chat?.chips, chat?.draftChips])
  // about exactly one meeting: main reads it in now, so the first question only reads itself
  const single = chips.length === 1 && chips[0].kind === 'meeting' ? chips[0].id : undefined
  const warm = () => { if (single && !recordingWait) window.yogurt.conversations.warm(id) }
  useEffect(warm, [id, single, recordingWait])
  useEffect(() => { document.getElementById(`${prefix}-context-${selected}`)?.scrollIntoView({ block: 'nearest' }) }, [selected, targets])
  useLayoutEffect(() => {
    const field = input.current, menu = mentionMenu.current
    if (!mention || !field || !menu) return
    const position = () => {
      const line = textareaMentionRect(field, mention.start)
      const size = { width: menu.offsetWidth, height: Math.min(340, innerHeight / 2, menu.scrollHeight + menu.offsetHeight - menu.clientHeight) }
      const placed = mentionPosition(line, size, { width: innerWidth, height: innerHeight })
      Object.assign(menu.style, { left: `${placed.left}px`, top: `${placed.top}px`, maxHeight: `${placed.maxHeight}px` })
    }
    position()
    const observer = new ResizeObserver(position)
    observer.observe(field)
    observer.observe(menu)
    if (composer.current) observer.observe(composer.current)
    window.addEventListener('resize', position)
    document.addEventListener('scroll', position, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', position)
      document.removeEventListener('scroll', position, true)
    }
  }, [mention, text, targetResults, expanded, chat])
  const turns = chat?.turns ?? [], last = turns.at(-1)
  const answering = last?.status === 'waiting' || last?.status === 'answering'
  const busy = recordingWait || !chat || sending || changing || answering
  const unsent = (chat ? chat.firstChips === null : home || panel) && !turns.length
  const landing = home || (!panel && unsent)
  const saveText = (value: string) => {
    edited.current = true
    setText(value)
    if (id || pendingDraftKey) drafts.set(id || pendingDraftKey!, value)
    if (!id) return
    void window.yogurt.conversations.draft(id, value).then(() => { if (drafts.get(id) === value) drafts.delete(id) }).catch(() => setError(true))
  }
  const detectMention = (value: string, caret: number) => {
    if (recordingWait) return
    const typed = value.slice(0, caret) !== text.slice(0, caret)
    if (typed && value[caret - 1] === '@') dismissedMention.current = false
    if (typed && value[caret - 1] === ' ' && mention && targetResults?.query === mention.query && !targets.length) dismissedMention.current = true
    setMention(dismissedMention.current ? undefined : mentionAt(value, caret))
  }
  useEffect(() => {
    if (recordingWait) { setMention(undefined); setSelector(undefined) }
  }, [recordingWait])
  const context = async (chips: ContextTarget[]) => {
    setChanging(true); setError(false)
    try { await window.yogurt.conversations.context(id, chips) }
    catch { setError(true); throw new Error('Context was not saved') }
    finally { setChanging(false) }
  }
  const insert = (c: ContextTarget) => {
    if ((!mention && !selector) || busy || !chat) return
    void (inScope(c) ? Promise.resolve() : context(attachContext(chat.firstChips === null ? chips : chat.draftChips, [c]))).then(() => {
      if (mention) saveText(text.slice(0, mention.start) + text.slice(mention.end))
      if (!mention) return
      setMention(undefined)
      requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(mention.start, mention.start) })
    }).catch(() => {})
  }
  const remove = async (targets: ContextTarget[]) => {
    if (busy) return
    setChanging(true); setError(false)
    try { for (const chip of targets) await window.yogurt.conversations.removeContext(id, chip) }
    catch { setError(true) }
    finally { setChanging(false) }
  }
  const toggle = (c: ContextTarget) => { if (selector && inScope(c)) void remove([c]); else insert(c) }
  const restoreSelection = () => {
    input.current?.focus({ preventScroll: true })
    input.current?.setSelectionRange(savedSelection.current.start, savedSelection.current.end)
    return false
  }
  // Sending from the box (Enter, the send button or a starter) keeps the person in it; the button turns into Stop and starters go. A disabled field would drop focus, so it is read-only while saving.
  const keepTyping = () => { const from = document.activeElement; if (from === document.body || from?.closest('.ask-box, .ask-starters')) input.current?.focus({ preventScroll: true }) }
  const submit = (q: string) => {
    void window.yogurt.conversations.ask(id, q).then(made => {
      if (!made) throw new Error('Question was not saved')
      if (typeof made !== 'string') return
      setText(''); drafts.delete(id)
      if (home) onSelect(made)
    }).catch(() => { saveText(q); setError(true) }).finally(() => setSending(false))
  }
  const send = (q: string) => {
    if (recordingWait || !q.trim() || sending || changing || answering || loadError || readFailed || (!chat && (!panel || error))) return
    keepTyping()
    follow.resume(); setSending(true); setError(false); setMention(undefined); setSelector(undefined)
    // Typing is available before the conversation loads; Enter must survive that handoff too.
    if (!chat) { pendingQuestion.current = q; return }
    submit(q)
  }
  useEffect(() => {
    if (pendingQuestion.current === undefined) return
    if (loadError || recordingWait) { pendingQuestion.current = undefined; setSending(false); return }
    if (!chat) return
    const question = pendingQuestion.current
    pendingQuestion.current = undefined
    submit(question)
  }, [chat, loadError, recordingWait])
  const expand = () => {
    setSelected(offset + allTargets.findIndex(c => !targets.includes(c)))
    setExpanded(true)
  }
  const key = (e: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return
    if ((mention || selector) && ['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(e.key)) {
      e.preventDefault(); e.stopPropagation()
      if (e.key === 'Escape') { dismissedMention.current = true; setMention(undefined); setSelector(undefined) }
      else if (e.key === 'Enter') {
        const row = selected < scoped.length ? scoped[selected] : scopeMore && selected === offset - 1 ? 'scope-more' : more && selected === offset + targets.length ? 'more' : targets[selected - offset]
        if (row === 'scope-more') setScopeExpanded(true)
        else if (row === 'more') expand()
        // Enter picks and goes back to the question; a click keeps the picker open to pick several
        else if (row) { toggle(row); if (selector) setSelector(undefined) }
      }
      else setSelected(i => (i + (e.key === 'ArrowDown' ? 1 : -1) + rowCount) % (rowCount || 1))
    } else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(text) }
  }
  const fresh = () => {
    if (!chat || changing) return
    void window.yogurt.conversations.current(attachContext(chat.chips, chat.draftChips), true).then(onSelect).catch(() => setError(true))
  }
  const startersHidden = !panel && (!!text || !!selector)
  const suggestions = unsent && (landing || panel) && (!panel || !text) && <div data-testid={panel ? 'chat-suggestions' : 'chat-starters'} aria-hidden={startersHidden || undefined} data-instant={!!selector || undefined} inert={startersHidden} className={`ask-starters${panel ? '' : ' ask-home-starters'}`}>
    {starters(chips, recording).map(q => <button type="button" key={q} title={q} data-testid={panel ? 'chat-suggestion' : 'chat-starter'} disabled={busy || startersHidden} onClick={() => send(q)}>{q}</button>)}
  </div>
  const targetRow = (c: ContextTarget, i: number) => <button type="button" role="option" tabIndex={-1} disabled={busy}
    aria-selected={selector ? inScope(c) : selected === i} data-active={selected === i || undefined} id={`${prefix}-context-${i}`} key={`${c.kind}:${c.id}`}
    onMouseDown={e => e.preventDefault()} onClick={() => toggle(c)}>
    <ContextIcon target={c} /><span>{chipTitle(c)}</span>
    {inScope(c) ? <Check size={14} aria-hidden="true" /> : c.startedAt && <small>{dayLabel(c.startedAt)}</small>}
  </button>
  const results = <>
    {!!offset && <>
      {!!scoped.length && <div role="group" aria-label={t('In this chat')}><h3>{t('In this chat')}<button type="button" className="text-action ask-picker-clear" disabled={busy}
        onMouseDown={e => e.preventDefault()} onClick={() => void remove(chips)}>{t('Clear')}</button></h3>
        {scoped.map((c, i) => targetRow(c, i))}
        {!!scopeMore && <button type="button" role="option" tabIndex={-1} aria-selected={false} data-active={selected === offset - 1 || undefined} id={`${prefix}-context-${offset - 1}`}
          onMouseDown={e => e.preventDefault()} onClick={() => setScopeExpanded(true)}><Ellipsis size={14} aria-hidden="true" /><span>{t('{count} more', { count: scopeMore })}</span></button>}
      </div>}
    </>}
    {(['meeting', 'folder'] as const).map(kind => targets.some(c => c.kind === kind) && <div key={kind} role="group" aria-label={kind === 'meeting' ? t('Meetings') : t('Folders')}>
      <h3>{kind === 'meeting' ? t('Meetings') : t('Folders')}</h3>
      {targets.map((c, i) => c.kind === kind && targetRow(c, offset + i))}
    </div>)}
    {!!more && <button type="button" role="option" tabIndex={-1} disabled={busy} className="text-muted" aria-selected={selector ? false : selected === offset + targets.length} data-active={selected === offset + targets.length || undefined} id={`${prefix}-context-${offset + targets.length}`}
      onMouseDown={e => e.preventDefault()} onClick={expand}>
      <Ellipsis size={14} aria-hidden="true" /><span>{t('{count} more results', { count: more })}</span>
    </button>}
    {!targetResults && !error && <p role="status">{t('Loading…')}</p>}
    {targetResults && !targets.length && !offset && <p>{t('Nothing found for “{query}”.', { query: targetResults.query })}</p>}
  </>
  return <div data-testid={landing ? "chat-empty" : undefined} aria-busy={last?.status === 'answering'} className={`ask-conversation${landing ? ' ask-landing' : ''}`}>
    {landing ? <h1 className="ask-home-title">{t('Ask about your meetings')}</h1> : <header className="ask-conversation-head">
      <h2 id={panel ? 'meeting-chat-title' : undefined} title={[chat?.title || t('New chat'), ...(chat?.chips.map(chipTitle) ?? [])].join('\n')}>{chat?.title || t('New chat')}</h2>
      <div className="ask-header-actions">
        {chat && <ConversationActions id={id} title={chat.title} onNew={fresh} onDeleted={onDeleted} />}
        {onExpand && <button type="button" data-testid="chat-expand" className="ghost-btn workspace-icon" onClick={onExpand} aria-label={t('Open in Ask')} title={t('Open in Ask')}><Maximize2 size={15} aria-hidden="true" /></button>}
        {onClose && <button type="button" data-testid="chat-close" className="ghost-btn workspace-icon" onClick={onClose} aria-label={t('Close')} title={t('Close')}><X size={16} aria-hidden="true" /></button>}
      </div>
    </header>}
    <div className="ask-thread-wrap">
      <ScrollFade><div className={`ask-thread${panel ? " chat-history" : ""}${unsent ? ' ask-thread-empty' : ''}`} ref={scroll}>
        <div ref={content} className="ask-thread-content">
        <LoadingContent pending={loadingChat} skeleton={<Loading layout="chat" testId="chat-thread-loading" />}>
        {!landing && turns.map(turn => <Turn key={turn.id} showCopy={turn === last} turn={turn} chat={chat!} panel={panel} onSource={onSource} retryDisabled={recordingWait} onRetry={() => send(turn.question)} />)}
        {panel && suggestions}</LoadingContent>
        </div>
      </div></ScrollFade>
      {follow.behind && <button className="workspace-button workspace-icon chat-latest" data-testid="chat-latest" aria-label={t('Back to latest')} onClick={follow.latest}><ArrowDown size={15} /></button>}
    </div>
    <div className={`ask-composer${panel ? ' chat-composer' : ''}`}>
      {readFailed && <InlineError testId="conversation-read-error"><span>{t("Couldn't load this conversation.")}</span>
        <button className="workspace-button" data-testid="conversation-load-retry" onClick={() => retryRead.current()}>{t('Try again')}</button>
      </InlineError>}
      {error && <p data-testid={panel ? "chat-send-error" : "chat-page-error"} role="alert" className="chat-error">{t("Couldn't save your changes")}</p>}
      <LoadingContent pending={!panel && loadingChat} onReady={() => { if (chat) input.current?.focus({ preventScroll: true }) }} testId={landing ? "chat-loading" : undefined}><form ref={composer} className="ask-box" data-busy={busy || undefined} data-testid={`${prefix}-box`} onSubmit={e => { e.preventDefault(); send(text) }} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setMention(undefined) }}>
        <div className="ask-field">
        <Tooltip.Root disabled={!recordingWait}>
          <Tooltip.Trigger render={<div />} delay={180} closeOnClick={false}>
            <textarea autoFocus={panel} ref={input} id={panel ? 'meeting-question' : 'library-question'} data-testid={`${prefix}-input`} rows={1} maxLength={4000}
              placeholder={landing ? undefined : panel ? t('Ask anything') : t('Ask about your meetings')} aria-label={panel ? t('Ask anything') : t('Ask about your meetings')} value={text} disabled={!panel && !chat} readOnly={recordingWait || sending || changing}
              aria-disabled={recordingWait || undefined} aria-description={waitReason}
              role="combobox" aria-autocomplete="list" aria-expanded={!!mention} aria-controls={mention ? `${prefix}-contexts` : undefined}
              aria-activedescendant={mention && selected < rowCount ? `${prefix}-context-${selected}` : undefined}
              onChange={e => { if (recordingWait) return; saveText(e.target.value); detectMention(e.target.value, e.target.selectionStart) }}
              onClick={e => detectMention(e.currentTarget.value, e.currentTarget.selectionStart)}
              onSelect={e => detectMention(e.currentTarget.value, e.currentTarget.selectionStart)} onFocus={warm} onKeyDown={key} />
          </Tooltip.Trigger>
          {recordingWait && <Tooltip.Portal container={panel ? composer : undefined}>
            <Tooltip.Positioner positionMethod="fixed" side="top" sideOffset={6} collisionPadding={12} className="z-[80]">
              <Tooltip.Popup role="tooltip" className="rounded-md border border-line bg-float px-2 py-1 text-xs text-ink shadow-[var(--shadow)]">{waitReason}</Tooltip.Popup>
            </Tooltip.Positioner>
          </Tooltip.Portal>}
        </Tooltip.Root>
        <div className="ask-box-actions">
          <Popover.Root open={!!selector} onOpenChange={open => {
            setMention(undefined)
            setTargetResults(open && bare.current ? { query: '', items: bare.current } : undefined); setSelected(0); setExpanded(false); setScopeExpanded(false)
            // Closing from the pill leaves focus on it; hand it back to the text unless the click went somewhere else.
            if (!open) requestAnimationFrame(() => { const at = document.activeElement; if (!at || at === document.body || at.closest('.ask-scope, .ask-selector')) input.current?.focus({ preventScroll: true }) })
            if (open) savedSelection.current = { start: input.current?.selectionStart ?? text.length, end: input.current?.selectionEnd ?? text.length }
            setSelector(open ? { query: '' } : undefined)
          }}>
            <span className="ask-scope-group">
              <Popover.Trigger type="button" className="ask-scope" data-testid="ask-scope" onPointerEnter={prefetch} onFocus={prefetch} disabled={busy} aria-label={t('Choose meetings or folders')} title={t('Choose meetings or folders')}><AskContext chips={chips} /></Popover.Trigger>
              {!!chips.length && <button type="button" className="ask-scope-clear" data-testid="ask-scope-clear" disabled={busy} aria-label={t('Clear')} title={t('Clear')}
                onClick={() => { void remove(chips); input.current?.focus({ preventScroll: true }) }}><X size={12} aria-hidden="true" /></button>}
            </span>
            <Popover.Portal container={input.current?.closest('dialog') ?? undefined}>
              <Popover.Positioner anchor={composer} side={landing ? 'bottom' : 'top'} align="start" collisionAvoidance={{ fallbackAxisSide: 'none' }} sideOffset={6} collisionPadding={16} positionMethod="fixed" className="ask-selector-positioner">
                <Popover.Popup className="ask-picker ask-selector" aria-label={t('Choose meetings or folders')} initialFocus={search} finalFocus={restoreSelection}>
                  <input ref={search} className="ask-picker-search" placeholder={t('Search…')} aria-label={t('Search meetings and folders')}
                    role="combobox" aria-autocomplete="list" aria-expanded={!!selector} aria-controls={`${prefix}-contexts`}
                    aria-activedescendant={selected < rowCount ? `${prefix}-context-${selected}` : undefined}
                    value={selector?.query ?? ''} maxLength={200} readOnly={changing} onChange={e => setSelector(current => current && { ...current, query: e.target.value })} onKeyDown={key} />
                  <div className="ask-picker-results" id={`${prefix}-contexts`} role="listbox" aria-multiselectable="true" aria-label={t('Add context')}>{results}</div>
                </Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          </Popover.Root>
          {answering ? <button type="button" data-testid={`${prefix}-stop`} className="ask-toolbar-button ask-stop" aria-label={chat?.waitsForModel ? t('Cancel question') : t('Stop')} title={chat?.waitsForModel ? t('Cancel question') : t('Stop')} onClick={() => { keepTyping(); window.yogurt.conversations.stop(id) }}><Square size={10} fill="currentColor" /></button>
            : <button type="submit" data-testid={`${prefix}-send`} className="ask-toolbar-button ask-send" disabled={busy || !text.trim()} aria-label={t('Ask')}><span className="orb-material" aria-hidden="true" /><ArrowUp size={16} /></button>}
        </div>
        </div>
        {mention && createPortal(<div ref={mentionMenu} className="ask-picker ask-mention" id={`${prefix}-contexts`} role="listbox" aria-label={t('Add context')}>{results}</div>, input.current?.closest('dialog') ?? document.body)}
      </form></LoadingContent>
    </div>
    {!panel && suggestions}
    <p data-testid={`${prefix}-announce`} className="sr-only" aria-live="polite">{last?.status === 'done' ? last.answer : ''}</p>
  </div>
}
function Turn({ turn, chat, panel, showCopy, onSource, onRetry, retryDisabled }: { showCopy: boolean; turn: ConversationTurn; chat: ConversationView; panel: boolean; onSource: (s: LibrarySource, match?: string) => void; onRetry: () => void; retryDisabled: boolean }) {
  const live = turn.status === 'answering', answer = useSmoothText(turn.answer, live)
  const [copied, setCopied] = useState(false), [failed, setFailed] = useState(false)
  const prefix = panel ? 'chat' : 'chat-page'
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1800); return () => clearTimeout(timer) }, [copied])
  return <div data-testid={`${prefix}-turn`} data-status={turn.status} data-show-copy={showCopy || undefined} className="ask-turn">
    <p className="ask-question" data-testid={`${prefix}-question`}>{turn.question}</p>
    {(turn.status === 'waiting' || live && !answer) && (chat.waitsForModel && turn.status === 'waiting'
      ? <NotesModelWait downloading={percent => <p role="status" className="text-sm text-muted">{t("Your question is waiting for Yogurt's AI to download.")} <span className="whitespace-nowrap">{percent}</span></p>}><p role="status" className="text-sm text-muted">{t('Getting ready to answer. Yogurt is still setting up.')}</p></NotesModelWait>
      : <p className="chat-progress" role="status">{chat.waitsForMeeting && turn.status === 'waiting' ? t('Yogurt will answer once the meeting ends.') : <><ThinkingDots /><StepText step={turn.status === 'waiting' ? undefined : turn.step} /></>}</p>)}
    {answer && <div data-testid={`${prefix}-answer`} dir="auto" data-streaming={live || undefined} className={`note-prose chat-answer${live ? ' stream-caret' : ''}`}><AnswerText md={answer} live={live} sources={turn.sources} onSource={onSource} /></div>}
    {answer && !live && <div className="chat-answer-actions"><button className="ghost-btn chat-copy-action" data-testid="chat-copy-answer" aria-label={copied ? t('Copied') : t('Copy answer')} onClick={() => {
      void navigator.clipboard.writeText(turn.answer).then(() => { setCopied(true); setFailed(false) }).catch(() => setFailed(true))
    }}><Swap show={copied ? 'done' : 'copy'} options={{ copy: <Copy size={13} />, done: <Check size={13} /> }} /><SwapText text={copied ? t('Copied') : t('Copy')} widest={t('Copied')} /></button>{turn.scope && <AnswerScope chips={turn.scope} />}<span role="status" className={failed ? 'text-danger' : 'sr-only'}>{failed ? t("Yogurt couldn't copy.") : copied ? t('Copied') : ''}</span></div>}
    {turn.status === 'stopped' && <p className="text-xs text-muted">{answer ? t('Stopped') : t('Stopped before answering')}</p>}
    {turn.status === 'failed' && <InlineError testId="chat-answer-error"><span>{t("Yogurt couldn't answer that.")}</span><button type="button" className="workspace-button" disabled={retryDisabled} onClick={onRetry}>{t('Try again')}</button></InlineError>}
  </div>
}

/** The step an answer is on; one that runs long says it is still on it every few seconds */
function StepText({ step }: { step?: AskStep }) {
  const [tick, setTick] = useState(0)
  const key = JSON.stringify(step ?? null)
  useEffect(() => {
    setTick(0)
    const timer = setInterval(() => setTick(n => n + 1), STEP_EVERY_MS)
    return () => clearInterval(timer)
  }, [key])
  const text = stepText(step, tick)
  return <span key={text} data-testid="chat-step" className="chat-step">{text}</span>
}
