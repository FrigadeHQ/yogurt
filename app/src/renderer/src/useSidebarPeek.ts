import { useEffect, useRef, useState, type PointerEvent } from 'react'

const childPopupOpen = () => document.querySelector('dialog[open]:not([data-testid="chat-panel"]), [role="menu"]:not([inert]), [aria-modal="true"]')

/** A peek never changes the window's docked sidebar setting or the width of the page. */
export function useSidebarPeek(collapsed: boolean, route: string) {
  const [mode, setMode] = useState<'pointer' | 'keyboard' | null>(null)
  const panel = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const pointerMotion = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const open = collapsed && mode !== null
  const cancel = () => {
    clearTimeout(timer.current)
    timer.current = undefined
  }
  const dismiss = (restore = false) => {
    cancel()
    if (restore || panel.current?.contains(document.activeElement)) {
      const target = previousFocus.current
      const to = target?.isConnected && target !== document.body ? target : toggle.current
      to?.focus({ preventScroll: true })
    }
    setMode(null)
  }
  const reveal = (how: 'pointer' | 'keyboard') => {
    if (!open) previousFocus.current = document.activeElement as HTMLElement | null
    pointerMotion.current = how === 'pointer'
    setMode(how)
  }
  const schedulePeek = (event: PointerEvent, dwell: number) => {
    if (event.pointerType !== 'mouse' || event.buttons) return cancel()
    if (timer.current === undefined) timer.current = setTimeout(() => {
      timer.current = undefined
      if (!childPopupOpen()) reveal('pointer')
    }, dwell)
  }
  // Observe the page so the edge never takes a click or scrollbar drag from it.
  const trackEdge = (event: PointerEvent) => {
    const atEdge = document.documentElement.dir === 'rtl' ? event.clientX >= window.innerWidth - 16 : event.clientX < 16
    if (!atEdge || event.clientY < 52) return cancel()
    if ((event.target as Element).closest('button, a[href], input, select, textarea, [contenteditable=true], [role=button], [role=scrollbar]')) return cancel()
    schedulePeek(event, 100)
  }
  const leave = () => {
    cancel()
    if (mode === 'pointer') timer.current = setTimeout(() => {
      if (!childPopupOpen()) dismiss()
    }, 80)
  }
  useEffect(() => {
    pointerMotion.current = false
    setMode(null)
    return cancel
  }, [collapsed, route])
  useEffect(() => {
    if (!open) return
    if (mode === 'keyboard') panel.current?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true })
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || childPopupOpen()) return
      e.preventDefault()
      e.stopPropagation()
      dismiss(true)
    }
    const outside = (e: Event) => {
      const target = e.target as HTMLElement
      if (!toggle.current?.contains(target) && !panel.current?.contains(target) &&
          !target.closest('dialog, [role="dialog"], [role="menu"], [data-base-ui-focus-guard]')) dismiss()
    }
    window.addEventListener('keydown', escape, true)
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    return () => {
      window.removeEventListener('keydown', escape, true)
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('focusin', outside)
    }
  }, [open, mode])
  const edgeHandlers = collapsed && !open ? {
    onPointerMoveCapture: trackEdge, onPointerLeave: cancel,
    onPointerDownCapture: cancel, onPointerCancel: cancel, onWheelCapture: cancel,
  } : undefined
  const buttonHandlers = collapsed && !open ? {
    onPointerEnter: (event: PointerEvent) => schedulePeek(event, 180),
    onPointerLeave: cancel, onPointerDown: cancel, onPointerCancel: cancel,
  } : undefined
  return { open, pointerMotion: pointerMotion.current, panel, toggle, edgeHandlers, buttonHandlers, leave, cancel, dismiss, keyboard: () => { cancel(); reveal('keyboard') } }
}
