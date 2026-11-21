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
  const cancel = () => clearTimeout(timer.current)
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
  const enter = (event: PointerEvent) => {
    cancel()
    if (collapsed && !open && event.pointerType === 'mouse' && !event.buttons)
      timer.current = setTimeout(() => { if (!childPopupOpen()) reveal('pointer') }, 80)
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
  return { open, pointerMotion: pointerMotion.current, panel, toggle, enter, leave, cancel, dismiss, keyboard: () => { cancel(); reveal('keyboard') } }
}
