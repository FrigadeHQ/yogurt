import { useEffect, useLayoutEffect, useState } from 'react'
import { cubicBezier } from 'motion'
import { followMotion } from '../../shared/follow'

const REDUCED = '(prefers-reduced-motion: reduce)'
const OUT = [.23, 1, .32, 1] as const
const SOFT = [.23, 1.15, .32, 1] as const
const MOVE = [.77, 0, .175, 1] as const
const easeOut = cubicBezier(...OUT)

export const motion = {
  micro: 120, base: 180, surface: 240,
  askExit: 150, // The anchored panel closes just faster than it opens.
  ease: `cubic-bezier(${OUT.join(',')})`, move: `cubic-bezier(${MOVE.join(',')})`,
  // One gentle rebound (under 2%) for surfaces and controls that already had bounce.
  soft: `cubic-bezier(${SOFT.join(',')})`, out: OUT, softCurve: SOFT,
} as const

// Citation goo keeps its own timing, outside the UI motion tokens.
export const surfaceMotion = { settleMs: 280 } as const

/** Scripted scrolling respects the same system preference as CSS motion. Read it at use time. */
export const scrollBehavior = (): ScrollBehavior =>
  window.matchMedia(REDUCED).matches ? 'auto' : 'smooth'

/** The system's reduced-motion setting, followed live */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia(REDUCED).matches)
  useEffect(() => {
    const q = window.matchMedia(REDUCED)
    const on = () => setReduced(q.matches)
    q.addEventListener('change', on)
    on() // A preference may have changed between render and subscribing.
    return () => q.removeEventListener('change', on)
  }, [])
  return reduced
}

/**
 * Scrolls `el` to `top` over a moment, frame by frame, and returns a way to stop it. The browser's own smooth scroll
 * can't be stopped, and one that starts as a person turns the wheel swallows their scroll. Jumps with reduced motion.
 */
export function glide(el: HTMLElement, top: number, done: () => void, ms: number = motion.surface): () => void {
  if (scrollBehavior() === 'auto') { el.scrollTop = top; done(); return () => {} }
  const from = el.scrollTop, t0 = performance.now()
  let frame = 0
  const step = (now: number) => {
    const p = Math.min(1, (now - t0) / ms)
    el.scrollTop = from + (top - from) * easeOut(p)
    if (p < 1) frame = requestAnimationFrame(step)
    else done()
  }
  frame = requestAnimationFrame(step)
  return () => cancelAnimationFrame(frame)
}

/** One frame loop takes the latest seek; earlier motion keeps its momentum until the final target settles. */
export function followGlide(el: HTMLElement, done: () => void) {
  const scroll = followMotion(el.scrollTop, motion.surface, easeOut)
  let target = el.scrollTop, frame = 0
  const step = (now: number) => {
    frame = 0
    if (scrollBehavior() === 'auto') { el.scrollTop = target; done(); return }
    scroll.to(target, now)
    el.scrollTop = scroll.at(now)
    if (scroll.active) frame = requestAnimationFrame(step)
    else done()
  }
  return {
    to(top: number) { target = top; if (!frame) frame = requestAnimationFrame(step) },
    stop() { cancelAnimationFrame(frame); frame = 0 },
    get active() { return frame !== 0 },
  }
}

/** Keep custom popovers mounted for the shared exit, without retaining interactive controls. */
export function usePopoverPresence<T>(open: T, pointer: boolean) {
  const [last, setLast] = useState({ value: open, pointer })
  useLayoutEffect(() => {
    if (open) { setLast({ value: open, pointer }); return }
    if (!last.value) return
    const timer = setTimeout(() => setLast({ value: open, pointer: false }), motion.micro)
    return () => clearTimeout(timer)
  }, [open, pointer])
  return {
    value: open || (last.pointer ? last.value : undefined),
    props: {
      'data-pointer': open ? pointer : last.pointer,
      'data-ending-style': open ? undefined : '',
      inert: !open,
    },
  }
}
