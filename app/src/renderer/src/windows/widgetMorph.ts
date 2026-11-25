import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { WidgetIntent, widgetContains, widgetExpanded, widgetSizedPill, type WidgetLayout, type WidgetSurface } from '../../../shared/widgetMorph'

export function useWidgetMorph(card: React.RefObject<HTMLDivElement | null>, warning: boolean, time: string, muted: boolean) {
  const intent = useRef(new WidgetIntent()).current
  const [open, setOpen] = useState(false)
  const [layout, setLayout] = useState<WidgetLayout | null>(null)
  const pointer = useRef({ x: -1, y: -1 })
  const keyboardFocus = useRef(false)
  const surface = useRef<WidgetSurface | null>(null)
  const collapsedWidth = useRef(0)
  const wake = useRef(() => {})

  useEffect(() => {
    let initial = true
    const off = window.yogurt.widget.onLayout(next => { initial = false; setLayout(next) })
    void window.yogurt.widget.layout().then(next => { if (initial) setLayout(next) })
    const offPointer = window.yogurt.widget.onPointer(p => { pointer.current = p; wake.current() })
    const offReset = window.yogurt.widget.onReset(() => {
      keyboardFocus.current = false
      intent.open = false; intent.over = false; intent.pressed = false; intent.due = null
      setOpen(false); wake.current()
    })
    return () => { initial = false; off(); offPointer(); offReset() }
  }, [])
  useLayoutEffect(() => {
    const was = intent.warning
    intent.warning = warning
    if (was && !warning && !intent.over) intent.leave(performance.now())
    wake.current()
  }, [warning])

  useLayoutEffect(() => {
    const el = card.current
    if (!el || !layout) return
    // Measure the mounted row, including its badge, before the same React commit paints.
    const box = open ? widgetExpanded(layout, warning)
      : widgetSizedPill(layout, 26 + el.querySelector<HTMLElement>('.widget-readout')!.getBoundingClientRect().width)
    Object.assign(el.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px`, visibility: 'visible' })
    if (!open) {
      collapsedWidth.current = box.width
      if (!intent.pressed && box.width !== layout.pill.width) window.yogurt.widget.size(box.width, 42)
    }
    surface.current = { ...box, radius: open ? 16 : 10 }
    window.yogurt.widget.surface(surface.current)
    wake.current()
  }, [layout, open, warning, muted, time.length]) // Tabular digits only change width when the clock gains a character.

  useEffect(() => {
    let frame = 0, lastPoint = { x: -1, y: -1 }
    const tick = (now: number) => {
      frame = 0
      if (surface.current) {
        const p = pointer.current, inside = keyboardFocus.current || widgetContains(surface.current, p.x, p.y)
        if (inside !== intent.over) inside ? intent.enter(now) : intent.leave(now)
        else if (inside && (p.x !== lastPoint.x || p.y !== lastPoint.y)) intent.move(now)
        lastPoint = p
        const next = intent.tick(now)
        if (next !== null) setOpen(next)
      }
      if (intent.due) frame = requestAnimationFrame(tick)
    }
    wake.current = () => { if (!frame) frame = requestAnimationFrame(tick) }
    wake.current()
    return () => { wake.current = () => {}; cancelAnimationFrame(frame) }
  }, [])
  return {
    open,
    focus: (focused: boolean) => { keyboardFocus.current = focused; wake.current() },
    pointer: (x: number, y: number) => {
      pointer.current = { x, y }
      wake.current()
      if (surface.current) window.yogurt.widget.surface(surface.current)
    },
    press: () => { intent.press(); window.yogurt.widget.pressed(true); wake.current() },
    release: (dragged: boolean) => {
      if (!intent.pressed) return
      intent.release(performance.now(), dragged)
      window.yogurt.widget.pressed(false)
      if (!intent.open && collapsedWidth.current) window.yogurt.widget.size(collapsedWidth.current, 42)
      wake.current()
    },
  }
}
