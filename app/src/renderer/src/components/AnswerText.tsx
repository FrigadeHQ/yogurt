import { visibleFocus } from '../focusNavigation'
import { Fragment, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Popover } from '@base-ui/react/popover'
import type { LibrarySource } from '../../../shared/types'
import type { PMNode } from '../../../shared/markdown'
import { citationDoc, type CitationMark } from '../../../shared/citations'
import { citationHighlights } from '../../../shared/citationHighlights'
import { t } from '../../../shared/i18n'
import { dayLabel } from '../dates'
import { clock } from '../../../shared/transcript'
import { SourceCitationCard } from './SourceCitation'
import { useCitationIntent } from '../useCitationIntent'
import { InlineText } from './InlineText'

/** The shared streamed/saved Markdown answer. Word and citation keys stay stable as the answer grows. */
export function AnswerText({ md, live, sources, onSource }: {
  md: string; live: boolean; sources: LibrarySource[]
  onSource: (s: LibrarySource, match?: string) => void
}) {
  const id = useId(), [open, setOpen] = useState(false), [triggerId, setTriggerId] = useState<string | null>(null)
  const [pinned, setPinned] = useState<string | null>(null)
  const suppressed = useRef<string | null>(null)
  const actions = useRef<Popover.Root.Actions>(null)
  const intent = useCitationIntent({ owner: id, enabled: sources.length > 0, open, pinned, triggerId, show: (next, pin) => { setTriggerId(next); setPinned(pin ? next : null); setOpen(true) }, close: () => { setPinned(null); setOpen(false) } })
  const doc = useMemo(() => {
    const doc = citationHighlights(citationDoc(md, sources, live, false))
    const prepare = (node: PMNode) => {
      // Base UI stores trigger payloads; their identity must survive popover state updates.
      if (node.type === 'citationPassageTrigger') {
        const cited = (node.attrs!.marks as CitationMark[]).map(mark => sources.find(s => s.n === mark.source)!)
        node.attrs!.payload = { source: cited[0], sources: cited, sentence: String(node.attrs!.sentence ?? '') }
      }
      node.content?.forEach(prepare)
    }
    prepare(doc)
    return doc
  }, [md, sources, live])
  useLayoutEffect(() => {
    // A later streamed citation can replace the highlight that owns the current preview.
    if (triggerId && !document.getElementById(triggerId)) {
      setPinned(null)
      if (open) actions.current?.close()
      else { actions.current?.unmount(); setTriggerId(null) }
    }
  }, [doc, open, triggerId])
  const ctx: Ctx = { intent, live, at: { n: 0 }, id, sources, pinned, focus: (element) => {
    if (!element.matches(visibleFocus)) return
    if (suppressed.current === element.id) { suppressed.current = null; return }
    intent.focus(element)
  }, blur: () => { suppressed.current = null },
  dismiss: element => {
    if (!open || triggerId !== element.id) return false
    intent.cancel(true); setPinned(null); setOpen(false)
    return true
  } }
  return <Popover.Root<{ source: LibrarySource; sources?: LibrarySource[]; sentence: string }> actionsRef={actions} open={open} triggerId={triggerId} onOpenChange={(next, details) => {
    if (!next) intent.cancel(details.reason === 'escape-key')
    const trigger = triggerId ? document.getElementById(triggerId) : null
    const popup = document.getElementById(trigger?.getAttribute('aria-controls') ?? '')
    const focused = open && (trigger === document.activeElement || !!popup?.contains(document.activeElement))
    if (details.reason === 'trigger-hover' && (pinned || focused && (!next || details.trigger?.id !== triggerId))) { details.cancel(); return }
    if (!next && details.reason === 'focus-out' && (pinned || trigger?.matches(':hover') || popup?.matches(':hover'))) { details.cancel(); return }
    if (details.reason === 'trigger-press') {
      // Base UI lets a patient click close a hover preview; our first click always pins it.
      const pin = pinned !== details.trigger?.id
      if (next !== pin) details.cancel()
      setPinned(pin ? details.trigger?.id ?? triggerId : null)
      next = pin
    } else if (!next) setPinned(null)
    if (details.reason === 'escape-key' && document.activeElement?.closest('.citation-card')) {
      suppressed.current = triggerId
      if (triggerId) document.getElementById(triggerId)?.focus({ preventScroll: true })
    }
    if (next) {
      setTriggerId(details.trigger?.id ?? triggerId)
    }
    setOpen(next)
  }}>{({ payload }) => { ctx.at.n = 0; return <>
    {(doc.content ?? []).map(n => render(n, ctx))}
    {payload && <SourceCitationCard key={triggerId} source={payload.source} additionalSources={payload.sources?.slice(1)} sentence={payload.sentence} triggerId={triggerId} open={open} animate onOpen={(match, source, atMs) => { setPinned(null); setOpen(false); onSource(atMs == null ? source : { ...source, atMs }, match) }} />}
  </> }}</Popover.Root>
}

type Ctx = { intent: ReturnType<typeof useCitationIntent>; live: boolean; at: { n: number }; id: string; sources: LibrarySource[]; pinned: string | null; focus: (element: HTMLElement) => void; blur: () => void; dismiss: (element: HTMLElement) => boolean }

function render(node: PMNode, c: Ctx): ReactNode {
  const key = `${node.type}-${c.at.n}`
  if (node.type === 'citationPassageTrigger') {
    const payload = node.attrs!.payload as { source: LibrarySource; sources: LibrarySource[]; sentence: string }
    const id = `${c.id}-${key}-passage`
    const kids = (node.content ?? []).map(n => render(n, c))
    return <Popover.Trigger key={key} id={id} render={<span />} nativeButton={false} payload={payload}
      className="citation-passage" data-intent-owner={c.id} data-testid="source-citation" data-sources={payload.sources.map(s => s.meetingId).join(',')} aria-pressed={c.pinned === id}
      aria-label={`${payload.sentence} ${payload.sources.map(s => t('Open {source}', { source: `${s.title || t('Untitled')} · ${s.atMs !== null ? clock(s.atMs) + ' · ' : ''}${dayLabel(s.startedAt)}` })).join('; ')}`}
      onFocus={e => c.focus(e.currentTarget)} onBlur={c.blur}
      onClick={e => { e.preventBaseUIHandler(); c.intent.activate(e.currentTarget, e.detail === 0) }}
      onKeyDown={e => {
        if (e.key === 'Escape' && c.dismiss(e.currentTarget)) { e.preventBaseUIHandler(); e.preventDefault(); e.stopPropagation() }
        if (e.key === 'Enter' || e.key === ' ') { e.preventBaseUIHandler(); e.preventDefault(); if (!e.repeat) c.intent.activate(e.currentTarget, true) }
      }} onKeyUp={e => { if (e.key === ' ') { e.preventBaseUIHandler(); e.preventDefault() } }}>

      {kids}
    </Popover.Trigger>
  }
  if (node.type === 'text') {
    const text = node.text ?? ''
    const out = words(text, c.at.n, c.live)
    c.at.n += text.length
    return <InlineText key={key} marks={node.marks}>{out}</InlineText>
  }
  const kids = (node.content ?? []).map(n => render(n, c))
  c.at.n += 1
  switch (node.type) {
    case 'heading': return <h3 key={key}>{kids}</h3>
    case 'bulletList': return <ul key={key}>{kids}</ul>
    case 'orderedList': return <ol key={key} start={Number(node.attrs?.start ?? 1)}>{kids}</ol>
    case 'listItem': return <li key={key}>{kids}</li>
    case 'paragraph': return node.content ? <p key={key}>{kids}</p> : null
    default: return <Fragment key={key}>{kids}</Fragment>
  }
}

function words(text: string, from: number, live: boolean): ReactNode[] {
  if (!live) return text ? [text] : []
  const out: ReactNode[] = []
  let at = from
  for (const w of text.split(/(\s+)/)) {
    if (w) out.push(/^\s+$/.test(w) ? w : <span key={at} className="fw">{w}</span>)
    at += w.length
  }
  return out
}
