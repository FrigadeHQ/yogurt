import { useEffect, useRef, useState, type PointerEvent } from 'react'

const childPopupOpen = () => document.querySelector('dialog[open]:not([data-testid="chat-panel"]), [role="menu"]:not([inert]), [aria-modal="true"]')

type PeekMode = 'edge' | 'button' | 'keyboard'

/** A peek never changes the window's docked sidebar setting or the width of the page. */
export function useSidebarPeek(collapsed: boolean, route: string) {
  const [mode, setMode] = useState<PeekMode | null>(null)
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
  const reveal = (how: PeekMode) => {
    if (!open) previousFocus.current = document.activeElement as HTMLElement | null
    pointerMotion.current = how !== 'keyboard'
    setMode(how)
  }
  const schedulePeek = (event: PointerEvent, from: 'edge' | 'button') => {
    if (event.pointerType !== 'mouse' || event.buttons) return cancel()
    if (timer.current === undefined) timer.current = setTimeout(() => {
      timer.current = undefined
      if (!childPopupOpen()) reveal(from)
    }, from === 'edge' ? 100 : 180)
  }
  // Observe the page so the edge never takes a click or scrollbar drag from it.
  const trackEdge = (event: PointerEvent) => {
    const atEdge = document.documentElement.dir === 'rtl' ? event.clientX >= window.innerWidth - 16 : event.clientX < 16
    if (!atEdge || event.clientY < 52) return cancel()
    if ((event.target as Element).closest('button, a[href], input, select, textarea, [contenteditable=true], [role=button], [role=scrollbar]')) return cancel()
    schedulePeek(event, 'edge')
  }
  const closeAfter = (delay: number) => {
    if (timer.current === undefined) timer.current = setTimeout(() => {
      timer.current = undefined
      if (!childPopupOpen()) dismiss()
    }, delay)
  }
  const leave = () => {
    if (mode === 'button') return
    cancel()
    if (mode === 'edge') closeAfter(80)
  }
  const trackButtonPath = (event: PointerEvent) => {
    const sidebar = panel.current
    if (!sidebar) return
    // Layout offsets describe the entire destination even on the first frame of the slide.
    let left = sidebar.offsetLeft, right = left + sidebar.offsetWidth
    if (event.clientY < sidebar.offsetTop && toggle.current) {
      const button = toggle.current.getBoundingClientRect()
      left = Math.min(left, button.left)
      right = Math.max(right, button.right)
    }
    if (event.clientX >= left && event.clientX < right) cancel()
    else closeAfter(80)
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
    onPointerEnter: (event: PointerEvent) => schedulePeek(event, 'button'),
    onPointerLeave: cancel, onPointerDown: cancel, onPointerCancel: cancel,
  } : undefined
  const buttonPathHandlers = open && mode === 'button' ? {
    onPointerMoveCapture: trackButtonPath, onPointerEnter: cancel,
    // macOS can stop sending renderer events while the pointer crosses the draggable title bar.
    onPointerLeave: () => closeAfter(360),
  } : undefined
  return { open, buttonPathHandlers, pointerMotion: pointerMotion.current, panel, toggle, edgeHandlers, buttonHandlers, leave, cancel, dismiss, keyboard: () => { cancel(); reveal('keyboard') } }
}
