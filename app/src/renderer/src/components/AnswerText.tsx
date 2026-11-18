import { Fragment, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Popover } from '@base-ui/react/popover'
import type { LibrarySource } from '../../../shared/types'
import type { PMNode } from '../../../shared/markdown'
import { citationDoc, type CitationMark } from '../../../shared/citations'
import { t } from '../../../shared/i18n'
import { dayLabel } from '../dates'
import { SourceCitationCard } from './SourceCitation'
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
  const doc = useMemo(() => {
    const doc = citationDoc(md, sources, live)
    const prepare = (node: PMNode) => {
      // Base UI stores trigger payloads; their identity must survive popover state updates.
      if (node.type === 'citation') node.attrs!.payloads = (node.attrs!.marks as CitationMark[]).map(mark => ({ source: sources.find(s => s.n === mark.source)!, sentence: String(node.attrs!.sentence ?? '') }))
      node.content?.forEach(prepare)
    }
    prepare(doc)
    return doc
  }, [md, sources, live])
  useLayoutEffect(() => {
    // A later streamed citation can replace the pill that owns the current preview.
    if (triggerId && !document.getElementById(triggerId)) {
      setPinned(null)
      if (open) actions.current?.close()
      else { actions.current?.unmount(); setTriggerId(null) }
    }
  }, [doc, open, triggerId])
  const ctx: Ctx = { live, at: { n: 0 }, id, sources, pinned, focus: (element) => {
    if (!element.matches(':focus-visible')) return
    if (suppressed.current === element.id) { suppressed.current = null; return }
    setPinned(null); setTriggerId(element.id); setOpen(true)
  }, blur: () => { suppressed.current = null },
  dismiss: element => {
    if (!open || triggerId !== element.id) return false
    setPinned(null); setOpen(false)
    return true
  } }
  return <Popover.Root<{ source: LibrarySource; sentence: string }> actionsRef={actions} open={open} triggerId={triggerId} onOpenChange={(next, details) => {
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
    {payload && <SourceCitationCard key={triggerId} source={payload.source} sentence={payload.sentence} triggerId={triggerId} animate onOpen={(match, atMs) => { setPinned(null); setOpen(false); onSource(atMs == null ? payload.source : { ...payload.source, atMs }, match) }} />}
  </> }}</Popover.Root>
}

type Ctx = { live: boolean; at: { n: number }; id: string; sources: LibrarySource[]; pinned: string | null; focus: (element: HTMLElement) => void; blur: () => void; dismiss: (element: HTMLElement) => boolean }

function render(node: PMNode, c: Ctx): ReactNode {
  const key = `${node.type}-${c.at.n}`
  if (node.type === 'citation') {
    c.at.n += Number(node.attrs?.length ?? 0)
    if (!(node.attrs!.marks as CitationMark[]).length) return null
    return <span className="citation-group" data-gap={node.attrs!.gap || undefined} data-single={(node.attrs!.marks as CitationMark[]).length === 1 || undefined} key={key}>{(node.attrs!.marks as CitationMark[]).map((mark, i) => {
      const source = c.sources.find(s => s.n === mark.source)!
      const title = source.title || t('Untitled')
      const id = `${c.id}-${key}-${mark.source}`
      return <Popover.Trigger key={mark.source} id={id} payload={(node.attrs!.payloads as Array<{ source: LibrarySource; sentence: string }>)[i]} openOnHover delay={120} closeDelay={180} aria-pressed={c.pinned === id}
        className="source-citation" data-testid="source-citation" data-meeting={source.meetingId} data-at={source.atMs ?? undefined}
        aria-label={`${title} · ${dayLabel(source.startedAt)}`} onFocus={e => c.focus(e.currentTarget)} onBlur={c.blur} onKeyDown={e => {
          // Consume Escape before the containing note panel handles it.
          if (e.key === 'Escape' && c.dismiss(e.currentTarget)) { e.preventDefault(); e.stopPropagation() }
        }}>
        <span className="source-name">{title}</span>
      </Popover.Trigger>
    })}</span>
  }
  if (node.type === 'citationAnchor') return <span key={key} className="citation-anchor">{node.content!.map(n => render(n, c))}</span>
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
