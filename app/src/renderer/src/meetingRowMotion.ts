import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'
import type { MeetingCard } from '../../shared/types'
import { motion, useReducedMotion } from './motion'

type Change = { kind: 'trash' | 'restore' | 'delete'; ids: string[] }
const listeners = new Set<(change: Change) => void>()
const changing = new Set<Promise<unknown>>()
let revision = 0

/** Mark only explicit mutations; ordinary reloads, paging and folder changes stay still. */
export async function changeMeetingRows<T>(kind: Change['kind'], ids: string[], change: () => Promise<T>, changed: (result: T) => string[] = () => ids): Promise<T> {
  revision++
  const result = Promise.resolve().then(change)
  changing.add(result)
  try {
    const value = await result
    const done = changed(value)
    if (done.length) for (const listen of listeners) listen({ kind, ids: done })
    return value
  } finally { changing.delete(result) }
}

/** A bulk action gets one list update, including any rows that failed to change. */
export async function readMeetingRows<T>(read: () => Promise<T>): Promise<T> {
  for (;;) {
    while (changing.size) await Promise.allSettled([...changing])
    const before = revision, result = await read()
    if (before === revision) return result
  }
}

type Row = { top: number }
type Snapshot = { scrollTop: number; rows: Map<string, Row>; removed: { element: HTMLElement; shift: number }[]; entering: Set<string> }
const rowKey = (el: HTMLElement) => el.dataset.rowId ?? `heading:${el.dataset.rowHeading}`
const rowsIn = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLElement>('[data-row-id], [data-row-heading]'))

export function captureMeetingRows(root: HTMLElement, next: MeetingCard[], pending: Map<string, boolean>): Snapshot | undefined {
  const elements = rowsIn(root), current = new Set(elements.map(rowKey)), incoming = new Set(next.map(c => c.id))
  const removed = new Set<string>(), entering = new Set<string>()
  for (const [id, present] of pending) {
    if (present && !current.has(id) && incoming.has(id)) entering.add(id)
    if (!present && current.has(id) && !incoming.has(id)) removed.add(id)
  }
  pending.clear()
  if (!removed.size && !entering.size) return
  const headings = new Set(next.map(c => new Date(c.startedAt).toDateString()))
  const box = root.getBoundingClientRect(), rows = new Map<string, Row>(), copies: Snapshot['removed'] = []
  let shift = 0
  for (const el of elements) {
    const rect = el.getBoundingClientRect()
    rows.set(rowKey(el), { top: rect.top })
    if (!removed.has(el.dataset.rowId!) && (!el.dataset.rowHeading || headings.has(el.dataset.rowHeading))) continue
    const copy = el.cloneNode(true) as HTMLElement
    // Exit copies are decoration, never a second focus target, drag source or test locator.
    for (const node of [copy, ...copy.querySelectorAll<HTMLElement>('*')]) {
      for (const attr of ['id', 'data-testid', 'data-meeting-id', 'data-row-id', 'data-row-heading', 'data-focus-ring', 'data-quiet-focus']) node.removeAttribute(attr)
      node.removeAttribute('draggable')
    }
    copy.inert = true
    copy.setAttribute('aria-hidden', 'true')
    copy.classList.add('meeting-row-exit')
    if (el.dataset.rowHeading) copy.classList.add('meeting-day-exit')
    Object.assign(copy.style, { position: 'absolute', margin: '0', pointerEvents: 'none', top: `${rect.top - box.top + root.scrollTop}px`, left: `${rect.left - box.left + root.scrollLeft}px`, width: `${rect.width}px`, height: `${rect.height}px` })
    copies.push({ element: copy, shift })
    shift -= rect.height
  }
  return { scrollTop: root.scrollTop, rows, removed: copies, entering }
}

export function playMeetingRows(root: HTMLElement, snapshot: Snapshot): () => void {
  const animations: Animation[] = []
  const duration = snapshot.entering.size ? motion.base : motion.micro
  const animate = (el: HTMLElement, frames: Keyframe[]) => {
    const animation = el.animate(frames, { duration, easing: motion.ease })
    animations.push(animation)
    return animation
  }
  for (const el of rowsIn(root)) {
    const old = snapshot.rows.get(rowKey(el)), rect = el.getBoundingClientRect()
    if (old) {
      const y = old.top - rect.top
      if (y) animate(el, [{ transform: `translateY(${y}px)` }, { transform: 'translateY(0)' }])
    } else if (snapshot.entering.has(el.dataset.rowId!) || (el.dataset.rowHeading && snapshot.entering.size)) {
      animate(el, [{ opacity: 0, clipPath: 'inset(0 0 100% 0)' }, { opacity: 1, clipPath: 'inset(0)' }])
    }
  }
  for (const { element: copy, shift } of snapshot.removed) {
    copy.style.top = `${parseFloat(copy.style.top) + root.scrollTop - snapshot.scrollTop}px`
    root.append(copy)
    const animation = animate(copy, [{ opacity: 1, clipPath: 'inset(0)', transform: 'translateY(0)' }, { opacity: 0, clipPath: 'inset(0 0 100% 0)', transform: `translateY(${shift}px)` }])
    animation.onfinish = () => copy.remove()
  }
  return () => { for (const animation of animations) animation.cancel(); for (const { element } of snapshot.removed) element.remove() }
}

/** Capture before React removes rows; move the live controls so hit targets follow their visible positions. */
export function useMeetingRowMotion(root: RefObject<HTMLElement | null>, scope: string) {
  const reduced = useReducedMotion(), pending = useRef(new Map<string, boolean>())
  const snapshot = useRef<Snapshot | undefined>(undefined), stop = useRef<(() => void) | undefined>(undefined)
  useLayoutEffect(() => {
    const listen = ({ kind, ids }: Change) => {
      const present = scope === 'trash' ? kind === 'trash' : kind === 'restore'
      for (const id of ids) pending.current.set(id, present)
    }
    listeners.add(listen)
    return () => { listeners.delete(listen); pending.current.clear(); snapshot.current = undefined; stop.current?.() }
  }, [scope])
  useLayoutEffect(() => {
    if (reduced) { stop.current?.(); snapshot.current = undefined; pending.current.clear() }
    if (snapshot.current && root.current) {
      stop.current = playMeetingRows(root.current, snapshot.current)
      snapshot.current = undefined
    }
  })
  return useCallback((cards: MeetingCard[]) => {
    const captured = !reduced && root.current ? captureMeetingRows(root.current, cards, pending.current) : undefined
    // Measure an interrupted transition before cancelling it, so the next one starts where it was visible.
    if (!captured && !reduced && root.current) {
      const current = rowsIn(root.current).filter(el => el.dataset.rowId).map(el => el.dataset.rowId)
      if (current.length === cards.length && current.every((id, i) => id === cards[i].id)) return
    }
    stop.current?.(); stop.current = undefined
    snapshot.current = captured
    pending.current.clear()
  }, [reduced, root])
}
