import { useLayoutEffect, useRef, useState } from 'react'
import { language, t } from '../../shared/i18n'
import { glide, scrollBehavior } from './motion'

type Card = { startedAt: number }
type Destination = { kind: 'future' | 'page' | 'empty' } | { kind: 'day'; key: string; exact: boolean }

/** Cards are newest first. The first one before the next midnight is on the day or its nearest earlier neighbor. */
export function resolveMeetingDate(at: number, cards: Card[], more: boolean, now = Date.now()): Destination {
  const start = new Date(at).setHours(0, 0, 0, 0)
  if (start > now) return { kind: 'future' }
  const end = new Date(at).setHours(24, 0, 0, 0)
  const card = cards.find(c => c.startedAt < end)
  if (!card) return { kind: more ? 'page' : 'empty' }
  return { kind: 'day', key: new Date(card.startedAt).toDateString(), exact: card.startedAt >= start }
}

export function landOnHeading(root: HTMLElement, heading: HTMLElement, top: number, dismiss: () => void) {
  const distance = top - root.scrollTop
  if (Math.abs(distance) > root.clientHeight && scrollBehavior() === 'smooth') {
    root.scrollTop = top - Math.sign(distance) * root.clientHeight
  }
  heading.tabIndex = -1
  heading.focus({ preventScroll: true })
  let restingTop: number | undefined
  let highlight: Animation | undefined
  const stop = glide(root, top, () => {
    restingTop = root.scrollTop
    highlight = heading.animate([{ backgroundColor: 'var(--accent-soft)' }, { backgroundColor: 'transparent' }],
      { id: 'meeting-date-highlight', duration: 1000, easing: 'ease-out' })
  }, 300)
  const listeners = new AbortController()
  const interrupt = () => { stop(); restingTop ??= root.scrollTop }
  const scroll = () => {
    if (restingTop === undefined || root.scrollTop === restingTop) return
    listeners.abort()
    dismiss()
  }
  for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
    root.addEventListener(event, interrupt, { passive: true, signal: listeners.signal })
  }
  root.addEventListener('scroll', scroll, { passive: true, signal: listeners.signal })
  return () => { listeners.abort(); stop(); highlight?.cancel() }
}

export function useMeetingDateJump(request: { at: number } | undefined, past: {
  cards?: Card[]; root: HTMLElement | null; more: boolean; failed?: string; next: () => void
}, ready: boolean) {
  const { cards, root, more, failed, next } = past
  const [dismissed, setDismissed] = useState<typeof request>()
  const handled = useRef<typeof request>(undefined)
  const cleanup = useRef<(() => void) | undefined>(undefined)
  const target = request && cards && resolveMeetingDate(request.at, cards, more)
  const key = target?.kind === 'day' ? target.key : undefined
  const kind = target?.kind
  // Paging and live refreshes can rerender Home during the glide. A new command replaces it.
  useLayoutEffect(() => () => { cleanup.current?.(); handled.current = undefined }, [request])
  useLayoutEffect(() => {
    if (!request || handled.current === request || !ready || !root || failed || !kind || kind === 'future') return
    if (kind === 'page') { next(); return }
    const heading = root.querySelector<HTMLElement>(key ? `[data-row-heading="${key}"]` : '[data-empty-date]')
    if (!heading) return
    const top = root.scrollTop + heading.getBoundingClientRect().top - root.getBoundingClientRect().top - parseFloat(getComputedStyle(root).paddingTop)
    const max = root.scrollHeight - root.clientHeight
    // A heading at the bottom of a full page needs some rows below it before it can align at the top.
    if (more && top > max) { next(); return }
    handled.current = request
    cleanup.current = landOnHeading(root, heading, Math.max(0, Math.min(max, top)), () => setDismissed(request))
  }, [request, ready, root, failed, kind, key, more, next])
  if (!request || dismissed === request || !(kind === 'empty' || (target?.kind === 'day' && !target.exact))) return
  const date = new Date(request.at).toLocaleDateString(language(), { month: 'long', day: 'numeric', year: 'numeric' })
  return { key, text: t('No meetings on {date}', { date }) }
}
