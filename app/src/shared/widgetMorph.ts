import type { WidgetView } from './types'

export type WidgetRect = { x: number; y: number; width: number; height: number }
export type WidgetSurface = WidgetRect & { radius: number }
export type WidgetLayout = { bounds: WidgetRect; pill: WidgetRect; open: WidgetRect; up: boolean }

const CARD_WIDTH = 340, MAX_CARD_HEIGHT = 446
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n))

/** Keep the pill's corner fixed; turn inward at the display edges. */
export function widgetLayout(pill: WidgetRect, area: WidgetRect): WidgetLayout {
  const width = Math.min(CARD_WIDTH, area.width), height = Math.min(MAX_CARD_HEIGHT, area.height)
  const x = clamp(pill.x + pill.width - width < area.x ? pill.x : pill.x + pill.width - width, area.x, area.x + area.width - width)
  const up = pill.y + height > area.y + area.height
  const y = clamp(up ? pill.y + pill.height - height : pill.y, area.y, area.y + area.height - height)
  // Keep a small transparent margin inside the display.
  const bounds = { x: Math.max(area.x, x - 8), y: Math.max(area.y, y - 8), width: 0, height: 0 }
  bounds.width = Math.min(area.x + area.width, x + width + 8) - bounds.x
  bounds.height = Math.min(area.y + area.height, y + height + 8) - bounds.y
  return { bounds, pill: { ...pill, x: pill.x - bounds.x, y: pill.y - bounds.y }, open: { x: x - bounds.x, y: y - bounds.y, width, height }, up }
}

/** Resize the pill inside the existing window, keeping the edge it shares with the card. */
export function widgetSizedPill({ pill, open, bounds }: WidgetLayout, measured: number): WidgetRect {
  const width = Math.min(Math.round(measured), bounds.width)
  const x = pill.x === open.x ? pill.x : pill.x + pill.width - width
  return { ...pill, x: clamp(x, 0, bounds.width - width), width }
}

/** Keep the dragged surface under the pointer and enough native space for the card to reopen. */
export function widgetDragLayout(frame: WidgetLayout, surface: WidgetRect, dx: number, dy: number, area: WidgetRect): WidgetLayout {
  const x = clamp(frame.bounds.x + Math.round(dx), area.x - surface.x, area.x + area.width - surface.x - surface.width)
  const y = clamp(frame.bounds.y + Math.round(dy), area.y - surface.y, area.y + area.height - surface.y - surface.height)
  const width = Math.min(area.width, Math.max(CARD_WIDTH, Math.ceil(x + frame.bounds.width) - Math.floor(x)))
  const height = Math.min(area.height, Math.max(MAX_CARD_HEIGHT, Math.ceil(y + frame.bounds.height) - Math.floor(y)))
  const bounds = {
    x: clamp(Math.floor(x), area.x, area.x + area.width - width),
    y: clamp(Math.floor(y), area.y, area.y + area.height - height), width, height,
  }
  const local = (r: WidgetRect) => ({ ...r, x: r.x - bounds.x, y: r.y - bounds.y })
  return {
    bounds, up: frame.up,
    pill: local({ ...frame.pill, x: x + frame.pill.x, y: y + frame.pill.y }),
    open: local({ ...frame.open, x: x + frame.open.x, y: y + frame.open.y }),
  }
}

/** Restore room for the normal card without moving the frozen surface on release. */
export function widgetRestLayout(frame: WidgetLayout, area: WidgetRect, height: number): WidgetLayout {
  const width = Math.min(CARD_WIDTH, area.width), fullHeight = Math.min(MAX_CARD_HEIGHT, area.height)
  height = Math.min(height, fullHeight)
  const x = clamp(frame.bounds.x + frame.open.x, area.x, area.x + area.width - width)
  const y = clamp(frame.bounds.y + frame.open.y + (frame.up ? frame.open.height - height : 0), area.y, area.y + area.height - height)
  const openY = y - (frame.up ? fullHeight - height : 0)
  const fullY = clamp(openY, area.y, area.y + area.height - fullHeight)
  const left = Math.max(area.x, Math.floor(Math.min(frame.bounds.x, x - 8)))
  const top = Math.max(area.y, Math.floor(Math.min(frame.bounds.y, fullY - 8)))
  const bounds = {
    x: left, y: top,
    width: Math.min(area.x + area.width, Math.ceil(Math.max(frame.bounds.x + frame.bounds.width, x + width + 8))) - left,
    height: Math.min(area.y + area.height, Math.ceil(Math.max(frame.bounds.y + frame.bounds.height, fullY + fullHeight + 8))) - top,
  }
  return {
    bounds, up: frame.up,
    pill: { ...frame.pill, x: frame.bounds.x + frame.pill.x - left, y: frame.bounds.y + frame.pill.y - top },
    open: { x: x - left, y: openY - top, width, height: fullHeight },
  }
}

export function widgetExpanded(layout: WidgetLayout, warning: boolean): WidgetRect {
  const width = Math.min(layout.open.width, layout.bounds.width)
  const height = Math.min(warning ? MAX_CARD_HEIGHT : 390, layout.open.height, layout.bounds.height)
  return {
    x: clamp(layout.open.x, 0, layout.bounds.width - width),
    y: clamp(layout.open.y + (layout.up ? layout.open.height - height : 0), 0, layout.bounds.height - height),
    width, height,
  }
}

export function widgetContains(rect: WidgetSurface, x: number, y: number): boolean {
  if (x < rect.x || y < rect.y || x > rect.x + rect.width || y > rect.y + rect.height) return false
  const radius = Math.min(rect.radius, rect.width / 2, rect.height / 2)
  const dx = x - clamp(x, rect.x + radius, rect.x + rect.width - radius)
  const dy = y - clamp(y, rect.y + radius, rect.y + rect.height - radius)
  return dx * dx + dy * dy <= radius * radius
}

export const widgetSettings = (note: WidgetView['note']) => note?.code === 'no-mic' ? 'mic' : note?.code === 'no-system-audio' ? 'systemAudio' : null

/** Hover deadlines stop during a press and wait for quiet after a drag. */
export class WidgetIntent {
  open = false
  over = false
  pressed = false
  warning = false
  quiet = 0
  due: { at: number; open: boolean } | null = null
  enter(now: number) { this.over = true; this.due = !this.pressed && !this.open ? { at: Math.max(now + 220, this.quiet), open: true } : null }
  move(now: number) { if (!this.open && !this.pressed) this.enter(now) }
  leave(now: number) { this.over = false; this.due = !this.pressed && this.open && !this.warning ? { at: Math.max(now + 480, this.quiet), open: false } : null }
  press() { this.pressed = true; this.due = null }
  release(now: number, dragged: boolean) { this.pressed = false; if (dragged) this.quiet = now + 650; this.over ? this.enter(now) : this.leave(now) }
  tick(now: number) {
    if (this.pressed) return null
    if (this.warning && !this.open) { this.open = true; this.due = null; return true }
    if (!this.due || now < this.due.at) return null
    const next = this.warning || this.due.open
    this.due = null
    if (next === this.open) return null
    this.open = next
    return next
  }
}
