import { createTracerSchedule, TRACER_LAP_MS } from '../../shared/askTracer'

const GATHER_MS = 48
const SETTLE_MS = 60
const OUT_CUBIC = 'cubic-bezier(.29,.79,.62,1)'

/** Decorative SVG only: input, focus and submission stay with the composer. */
export function attachAskTracer(box: HTMLFormElement) {
  const field = box.querySelector('textarea')!
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'ask-tracer')
  svg.setAttribute('aria-hidden', 'true')
  const light = window.matchMedia('(prefers-color-scheme: light)')
  const segments = Array.from({ length: 20 }, () => {
    const segment = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    segment.setAttribute('pathLength', '100')
    svg.append(segment)
    return segment
  })
  box.append(svg)
  let fraction = 0.75, gather = 0
  const resize = () => {
    const { width, height } = box.getBoundingClientRect()
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
    const w = Math.max(0, width - 2), h = Math.max(0, height - 2)
    const r = Math.min(11, w / 2, h / 2)
    const right = 1 + w, bottom = 1 + h, middle = 1 + w / 2
    const perimeter = 2 * (w + h - 4 * r) + 2 * Math.PI * r
    const start = Math.max(r, h / 3)
    const path = `M 1 ${1 + start} V ${1 + r} A ${r} ${r} 0 0 1 ${1 + r} 1 H ${right - r} A ${r} ${r} 0 0 1 ${right} ${1 + r} V ${bottom - r} A ${r} ${r} 0 0 1 ${right - r} ${bottom} H ${middle}`
    // From the left midpoint to the bottom midpoint clockwise is three quarters of a lap.
    fraction = 0.75 + (perimeter ? (start - h / 2) / perimeter : 0)
    const distance = fraction * perimeter
    gather = distance ? 100 * Math.min(3, (start - r) / 2) / distance : 0
    for (const segment of segments) segment.setAttribute('d', path)
  }
  resize()
  const observer = new ResizeObserver(resize)
  observer.observe(box)
  let animations: Animation[] = []
  const stop = () => { animations.forEach(animation => animation.cancel()); animations = [] }
  const play = () => {
    stop()
    const smooth = light.matches
    const peak = smooth ? 0.2 : 0.4
    const duration = Math.round(TRACER_LAP_MS * fraction)
    const arrive = 1 - SETTLE_MS / duration
    const opacity = svg.animate([
      { opacity: 0, easing: 'cubic-bezier(.18,.67,.46,1)' },
      { opacity: peak, offset: 64 / duration },
      { opacity: peak, offset: 1 - 120 / duration, easing: 'cubic-bezier(.36,.02,.67,1)' },
      { opacity: 0 },
    ], duration)
    let previous = 0
    animations = [opacity, ...segments.map((segment, i) => {
      // The open path reveals the tail behind the head. Nested light strokes avoid seams on white.
      const behind = (segments.length - i) / fraction
      const length = smooth ? behind : Math.min(1.05 / fraction, behind)
      const alpha = Math.sin(Math.PI * (i + .5) / (2 * segments.length)) ** 2
      segment.style.opacity = String(smooth ? (alpha - previous) / (1 - previous) : alpha)
      previous = alpha
      const dash = `${length} ${200 - length}`
      const tip = length * .04
      return segment.animate([
        { strokeDashoffset: String(behind), strokeDasharray: dash, easing: 'cubic-bezier(.37,.12,.70,1)' },
        { strokeDashoffset: String(behind - gather), offset: GATHER_MS / duration, easing: OUT_CUBIC },
        { strokeDashoffset: String(behind - 100), strokeDasharray: dash, offset: arrive, easing: OUT_CUBIC },
        { strokeDashoffset: String(behind * .04 - 100), strokeDasharray: `${tip} ${200 - tip}` },
      ], duration)
    })]
    return duration
  }
  // A pointer resting where the panel opened isn't hovering; only movement inside the box counts.
  let moved = false
  const state = () => ({ focused: box.contains(document.activeElement), hovered: moved, hasText: !!field.value,
    reduced: reduced.matches, hidden: document.hidden })
  const schedule = createTracerSchedule(state(), play, stop)
  const update = () => schedule.update(state())
  const blur = () => queueMicrotask(update)
  const move = () => { if (!moved) { moved = true; update() } }
  const leave = () => { moved = false; update() }
  for (const event of ['input', 'focusin']) box.addEventListener(event, update)
  box.addEventListener('pointermove', move)
  box.addEventListener('pointerleave', leave)
  box.addEventListener('focusout', blur)
  document.addEventListener('visibilitychange', update)
  reduced.addEventListener('change', update)
  light.addEventListener('change', stop)
  return {
    update,
    dispose() {
      schedule.dispose(); observer.disconnect(); svg.remove()
      for (const event of ['input', 'focusin']) box.removeEventListener(event, update)
      box.removeEventListener('pointermove', move)
      box.removeEventListener('pointerleave', leave)
      box.removeEventListener('focusout', blur)
      document.removeEventListener('visibilitychange', update)
      reduced.removeEventListener('change', update)
      light.removeEventListener('change', stop)
    },
  }
}
