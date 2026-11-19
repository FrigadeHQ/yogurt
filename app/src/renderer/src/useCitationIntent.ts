import { useEffect, useRef } from 'react'
import { citationHover } from './citationHover'

export function selectionIn(element: HTMLElement) {
  const selection = element.ownerDocument.getSelection()
  if (!selection || selection.isCollapsed) return false
  for (let i = 0; i < selection.rangeCount; i++) if (selection.getRangeAt(i).intersectsNode(element)) return true
  return false
}

type Options = { owner: string; enabled: boolean; open: boolean; pinned: string | null; triggerId: string | null; show: (id: string, pin: boolean) => void; close: () => void }
/** Hover intent never takes precedence over selection, a press, scrolling or a pinned card. */
export function useCitationIntent(options: Options) {
  const current = useRef(options); current.current = options
  const state = useRef({ popup: null as HTMLElement | null, candidate: null as HTMLElement | null, buttons: 0, scrollUntil: 0, suppressed: '', press: null as { x: number; y: number; moved: boolean } | null })
  const hover = useRef<ReturnType<typeof citationHover> | null>(null)
  const cancel = (suppress = false) => {
    const s = state.current
    hover.current?.cancel(suppress)
    if (suppress) s.suppressed = current.current.triggerId ?? ''
  }
  const reveal = (element: HTMLElement, pin: boolean) => {
    cancel()
    current.current.show(element.id, pin)
  }
  const activate = (element: HTMLElement, keyboard = false) => {
    const s = state.current
    if (selectionIn(element) || !keyboard && s.press?.moved) { cancel(); return }
    s.press = null
    if (current.current.open && current.current.pinned === element.id) { cancel(true); current.current.close() }
    else reveal(element, true)
  }
  const focus = (element: HTMLElement) => {
    if (selectionIn(element) || state.current.buttons) return
    cancel(); current.current.show(element.id, false)
  }
  useEffect(() => {
    if (!options.enabled) return
    const s = state.current
    const passage = (target: EventTarget | null) => {
      const e = target instanceof Element ? target.closest<HTMLElement>('.citation-passage') : null
      return e?.dataset.intentOwner === options.owner ? e : null
    }
    const popup = () => {
      const trigger = document.getElementById(current.current.triggerId ?? '')
      const element = document.getElementById(trigger?.getAttribute('aria-controls') ?? '')
      if (element) s.popup = element
      return s.popup?.isConnected ? s.popup : null
    }
    const focused = () => {
      const active = document.activeElement
      return !!active && (popup()?.contains(active) || active.id === current.current.triggerId && active.matches(':focus-visible'))
    }
    const closeHover = () => { if (current.current.open && !current.current.pinned) { popup(); current.current.close() } }
    const valid = (element: HTMLElement) => !s.buttons && performance.now() >= s.scrollUntil && !selectionIn(element) && s.suppressed !== element.id
    hover.current = citationHover({
      state: () => current.current,
      show: id => current.current.show(id, false),
      close: closeHover,
      valid: id => { const e = document.getElementById(id); return !!e && valid(e) && e.matches(':hover') && !current.current.pinned },
      resuming: id => current.current.triggerId === id && !!popup() && !current.current.open,
    })
    const leave = () => { s.candidate = null; if (!focused()) hover.current?.move(null) }
    const move = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return
      if (s.press && event.buttons && Math.hypot(event.clientX - s.press.x, event.clientY - s.press.y) > 3) s.press.moved = true
      s.buttons = event.buttons
      if (event.buttons) { cancel(); return }
      if (event.target instanceof Node && popup()?.contains(event.target)) {
        cancel()
        const trigger = document.getElementById(current.current.triggerId ?? '')
        if (!current.current.open && trigger && valid(trigger)) current.current.show(trigger.id, false)
        return
      }
      const element = passage(event.target)
      if (!element) { s.suppressed = ''; leave(); return }
      if (s.candidate !== element) { s.suppressed = s.suppressed === element.id ? s.suppressed : ''; s.candidate = element }
      cancel()
      if (current.current.pinned || focused() || !valid(element)) return
      const peers = [...document.querySelectorAll<HTMLElement>('.citation-passage')].filter(e => e.dataset.intentOwner === options.owner)
      const previous = peers.findIndex(e => e.id === current.current.triggerId), next = peers.indexOf(element)
      hover.current?.move(element.id, previous >= 0 && Math.abs(previous - next) === 1)
    }
    const down = (event: PointerEvent) => {
      s.buttons = event.buttons; s.press = passage(event.target) ? { x: event.clientX, y: event.clientY, moved: false } : null
      cancel(); if (!(event.target instanceof Node && popup()?.contains(event.target))) closeHover()
    }
    const up = () => { s.buttons = 0 }
    const pointerCancel = () => { s.buttons = 0; if (s.press) s.press.moved = true; cancel() }
    const scroll = (event: Event) => {
      s.scrollUntil = performance.now() + 250; hover.current?.cancel(true)
      if (!(event.target instanceof Node && popup()?.contains(event.target))) closeHover()
    }
    const selection = () => {
      const active = document.getElementById(current.current.triggerId ?? '')
      if (s.candidate && selectionIn(s.candidate) || active && selectionIn(active)) { hover.current?.cancel(true); if (current.current.open) current.current.close() }
    }
    const outside = (event: PointerEvent) => { if (!event.relatedTarget) { s.suppressed = ''; leave() } }
    document.addEventListener('pointermove', move, true); document.addEventListener('pointerdown', down, true)
    document.addEventListener('pointerup', up, true); document.addEventListener('pointercancel', pointerCancel, true)
    document.addEventListener('pointerout', outside, true); document.addEventListener('scroll', scroll, true)
    document.addEventListener('wheel', scroll, { capture: true, passive: true }); document.addEventListener('selectionchange', selection)
    return () => {
      cancel(); document.removeEventListener('pointermove', move, true); document.removeEventListener('pointerdown', down, true)
      document.removeEventListener('pointerup', up, true); document.removeEventListener('pointercancel', pointerCancel, true)
      document.removeEventListener('pointerout', outside, true); document.removeEventListener('scroll', scroll, true)
      document.removeEventListener('wheel', scroll, true); document.removeEventListener('selectionchange', selection)
    }
  }, [options.owner, options.enabled])
  return { activate, focus, cancel }
}
