import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronUp, Search, X } from './Icons'
import { t } from '../../../shared/i18n'
import { stepTranscriptMatch, transcriptMatchIndex, transcriptFindScrollTop, type TranscriptMatch } from '../../../shared/transcriptFind'
import { useLanguage } from '../i18n'
import { command, keys, onMac } from '../keys'
import { scrollBehavior } from '../motion'
import { transcriptFindRanges } from '../transcriptFindRanges'

type Props = {
  lines: ReadonlyArray<{ track: string; startMs: number; text: string }>
  list: RefObject<HTMLOListElement | null>
  active: boolean
  playbackInset: number
  /** called before find scrolls the list itself, so the player can tell it from the person's own scroll */
  beforeScroll?: () => void
  extra?: React.ReactNode
  onFinding: (finding: boolean) => void
  toolbar?: HTMLElement | null
  onClose?: () => void
}

/** Search owns its state and paints native text ranges; keystrokes never redraw the transcript. */
export function TranscriptFind({ extra, lines, list, active, playbackInset, beforeScroll, onFinding, toolbar, onClose }: Props) {
  useLanguage()
  const countId = useId(), fieldId = useId()
  const [open, setOpen] = useState(false), [query, setQuery] = useState('')
  const [navigation, setNavigation] = useState(0)
  const [selected, setSelected] = useState<TranscriptMatch | null>(null)
  const input = useRef<HTMLInputElement>(null), trigger = useRef<HTMLButtonElement>(null)
  const [found, setFound] = useState<ReturnType<typeof transcriptFindRanges>>({ query: '', matches: [], ranges: [] })
  const { matches, ranges } = found
  const index = transcriptMatchIndex(matches, selected), current = matches[index]
  const controlRef = useRef<HTMLDivElement>(null)
  const reveal = useRef(false)
  const searching = !!query.trim()
  const show = () => {
    setOpen(true); onFinding(true)
    if (open) { input.current?.focus({ preventScroll: true }); input.current?.select() }
  }
  const close = () => { setQuery(''); setSelected(null); setOpen(false); onFinding(false); trigger.current?.focus({ preventScroll: true }) }
  const move = (step: number) => {
    if (!matches.length) return
    reveal.current = true
    setSelected(matches[stepTranscriptMatch(index, step, matches.length)])
    setNavigation(n => n + 1)
  }
  // Focus only after React removes inert; focusing the closed field can blur the trigger.
  useLayoutEffect(() => { if (open) { input.current?.focus({ preventScroll: true }); input.current?.select() } }, [open])
  useLayoutEffect(() => {
    const control = controlRef.current, controls = control?.querySelector('.transcript-find-controls')
    if (!active || !toolbar || !control || !controls) return
    const fit = () => {
      // Leave 32px for typing after the fixed controls and 44px of field chrome.
      const minimum = Math.max(240, controls.getBoundingClientRect().width + 76)
      control.dataset.findBelow = String(toolbar.getBoundingClientRect().width < minimum)
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(toolbar); observer.observe(controls)
    return () => observer.disconnect()
  }, [active, toolbar])

  useLayoutEffect(() => {
    if (found.query === query && current && (current.key !== selected?.key || current.start !== selected.start)) setSelected(current)
  }, [current, selected, found.query, query])

  useLayoutEffect(() => {
    const el = list.current
    if (!active || !open || !query.trim() || !el) { setFound({ query, matches: [], ranges: [] }); return }
    const refresh = () => setFound(transcriptFindRanges(el, lines, query))
    refresh()
    const observer = new MutationObserver(refresh)
    observer.observe(el, { childList: true, characterData: true, subtree: true })
    return () => observer.disconnect()
  }, [lines, query, open, active, list])

  useLayoutEffect(() => {
    if (!active) return
    const all = new Highlight()
    for (const range of ranges) all.add(range)
    CSS.highlights.set('transcript-find', all)
    return () => { if (CSS.highlights.get('transcript-find') === all) CSS.highlights.delete('transcript-find') }
  }, [ranges, active])

  useLayoutEffect(() => {
    if (!active) return
    if (found.query !== query) return
    const range = ranges[index]
    const highlight = new Highlight(...(range ? [range] : []))
    highlight.priority = 1
    CSS.highlights.set('transcript-find-current', highlight)
    const el = list.current
    if (reveal.current && range && el) {
      const r = range.getBoundingClientRect(), box = el.getBoundingClientRect()
      const field = input.current?.getBoundingClientRect()
      const top = field && field.bottom > box.top && r.right > field.left && r.left < field.right ? field.bottom + 8 : box.top
      const target = transcriptFindScrollTop(r, { top, bottom: box.bottom - playbackInset, scrollTop: el.scrollTop })
      if (r.height && target !== null) { beforeScroll?.(); el.scrollTo({ top: target, behavior: scrollBehavior() }) }
    }
    reveal.current = false
    return () => { if (CSS.highlights.get('transcript-find-current') === highlight) CSS.highlights.delete('transcript-find-current') }
  }, [ranges, index, selected, navigation, active, playbackInset, list, found.query, query])

  useEffect(() => {
    if (!active) return
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || document.querySelector('dialog:modal, [aria-modal="true"]')) return
      if (command(event) && (event.code === 'KeyF' || event.code === 'KeyG')) {
        event.preventDefault(); event.stopPropagation()
        if (event.code === 'KeyF') show()
        else if (searching) move(event.shiftKey ? -1 : 1)
      } else if (event.key === 'Escape' && open && (controlRef.current?.contains(event.target as Node) || list.current?.contains(event.target as Node))) {
        event.preventDefault(); event.stopPropagation(); close()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  const control = <div ref={controlRef} className="transcript-toolbar">{!open && extra}<div className="transcript-find" data-open={open} onBlur={event => {
    if (open && !event.currentTarget.contains(event.relatedTarget) && !searching) { setOpen(false); onFinding(false) }
  }}>
    <button ref={trigger} type="button" data-testid="transcript-find-open" className="ghost-btn transcript-find-trigger" aria-label={t('Search the transcript')} title={`${t('Search the transcript')} (${keys('⌘F')})`} aria-expanded={open} aria-hidden={open} aria-controls={fieldId} tabIndex={open ? -1 : 0} onClick={show}><Search size={14} aria-hidden="true" /></button>
    <div id={fieldId} className="transcript-find-clip" inert={!open} aria-hidden={!open}>
      <div className="transcript-search-field">
        <Search size={14} aria-hidden="true" className="shrink-0 text-muted" />
        <input ref={input} data-testid="transcript-search" value={query} onChange={event => { reveal.current = true; setSelected(null); setQuery(event.target.value) }} onKeyDown={event => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Enter') { event.preventDefault(); move(event.shiftKey ? -1 : 1) }
        }} placeholder={t('Search')} aria-label={t('Search the transcript')} aria-describedby={countId} spellCheck={false} />
        <span className="transcript-find-controls">
        <span className="transcript-find-results" data-visible={searching} inert={!searching} aria-hidden={!searching}>
        <span className="transcript-find-count">
          <span aria-hidden="true" className="transcript-find-reserve">{t('{current} of {count}', { current: 99999, count: 99999 })}</span>
          <span aria-hidden="true" className="transcript-find-reserve">{t('No matches')}</span>
          <span id={countId} data-testid="transcript-find-count" role="status" aria-live="polite" aria-atomic="true">{searching ? matches.length ? t('{current} of {count}', { current: index + 1, count: matches.length }) : t('No matches') : ''}</span>
        </span>
        <span className="transcript-find-arrows">
          <button type="button" data-testid="transcript-find-previous" className="ghost-btn workspace-icon" disabled={!matches.length} aria-label={t('Previous match')} title={`${t('Previous match')} (⇧Enter · ${keys('⇧⌘G')})`} aria-keyshortcuts={`Shift+Enter ${onMac() ? 'Meta' : 'Control'}+Shift+G`} onClick={() => move(-1)}><ChevronUp size={14} aria-hidden="true" /></button>
          <button type="button" data-testid="transcript-find-next" className="ghost-btn workspace-icon" disabled={!matches.length} aria-label={t('Next match')} title={`${t('Next match')} (Enter · ${keys('⌘G')})`} aria-keyshortcuts={`Enter ${onMac() ? 'Meta' : 'Control'}+G`} onClick={() => move(1)}><ChevronDown size={14} aria-hidden="true" /></button>
        </span>
        </span>
        <button type="button" data-testid="transcript-find-close" className="ghost-btn workspace-icon transcript-find-close" aria-label={t('Close')} title={`${t('Close')} (Esc)`} aria-keyshortcuts="Escape" onClick={close}><X size={14} aria-hidden="true" /></button>
        </span>
      </div>
    </div>
  </div>
    {onClose && <div className="transcript-actions"><button data-testid="transcript-close" onClick={onClose} aria-label={t('Hide transcript')} title={t('Hide transcript')} className="ghost-btn workspace-icon"><ChevronDown size={15} aria-hidden="true" /></button></div>}
  </div>
  return active ? toolbar ? createPortal(control, toolbar) : control : null
}
