import { useLayoutEffect, useRef } from 'react'
import { daysAgo } from '../../shared/dates'
import { glide, scrollBehavior } from './motion'

type Card = { startedAt: number }
type Destination = { kind: 'top' | 'page' | 'empty' } | { kind: 'day' | 'bottom'; key: string }

export function resolveMeetingDate(at: number, cards: Card[], more: boolean, now = Date.now()): Destination {
  const start = new Date(at).setHours(0, 0, 0, 0)
  if (start > now) return { kind: 'top' }
  const end = new Date(at).setHours(24, 0, 0, 0)
  // Newest first. Page until we have the requested day, both neighbors, or the end of history.
  const i = cards.findIndex(card => card.startedAt < end)
  if (i < 0) {
    if (more) return { kind: 'page' }
    const oldest = cards.at(-1)
    return oldest ? { kind: 'bottom', key: new Date(oldest.startedAt).toDateString() } : { kind: 'empty' }
  }
  let closest = cards[i]
  const later = cards[i - 1]
  if (closest.startedAt < start && later && daysAgo(at, later.startedAt) < daysAgo(closest.startedAt, at)) {
    closest = later
  }
  return { kind: 'day', key: new Date(closest.startedAt).toDateString() }
}

export function landOnHeading(root: HTMLElement, heading: HTMLElement, top: number) {
  const distance = top - root.scrollTop
  if (Math.abs(distance) > root.clientHeight && scrollBehavior() === 'smooth') {
    root.scrollTop = top - Math.sign(distance) * root.clientHeight
  }
  heading.tabIndex = -1
  heading.focus({ preventScroll: true })
  const listeners = new AbortController()
  const stop = glide(root, top, () => listeners.abort(), 300)
  const interrupt = () => { listeners.abort(); stop() }
  for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
    root.addEventListener(event, interrupt, { passive: true, signal: listeners.signal })
  }
  return interrupt
}

export function useMeetingDateJump(request: { at: number } | undefined, past: {
  cards?: Card[]; root: HTMLElement | null; more: boolean; failed?: string; next: () => void
}, ready: boolean) {
  const { cards, root, more, failed, next } = past
  const handled = useRef<typeof request>(undefined)
  const cleanup = useRef<(() => void) | undefined>(undefined)
  const target = request && cards && resolveMeetingDate(request.at, cards, more)
  const key = target && 'key' in target ? target.key : undefined
  const kind = target?.kind
  // Paging and live refreshes can rerender Home during the glide. A new command replaces it.
  useLayoutEffect(() => () => { cleanup.current?.(); handled.current = undefined }, [request])
  useLayoutEffect(() => {
    if (!request || handled.current === request || !ready || !root || !kind || kind === 'empty' || (failed && kind !== 'top')) return
    if (kind === 'page') { next(); return }
    if (kind === 'top' && root.scrollTop === 0) { handled.current = request; return }
    const heading = root.querySelector<HTMLElement>(kind === 'top' ? 'h1' : `[data-row-heading="${key}"]`)
    if (!heading) return
    const max = root.scrollHeight - root.clientHeight
    let top = 0
    if (kind === 'bottom') top = max
    if (kind === 'day') {
      top = root.scrollTop + heading.getBoundingClientRect().top - root.getBoundingClientRect().top - parseFloat(getComputedStyle(root).paddingTop)
      // Load enough rows below the heading to align it with the top of the pane.
      if (more && top > max) { next(); return }
    }
    handled.current = request
    cleanup.current = landOnHeading(root, heading, Math.max(0, Math.min(max, top)))
  }, [request, ready, root, failed, kind, key, more, next])
}
