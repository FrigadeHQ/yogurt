import { useCallback, useEffect, useRef, useState } from 'react'
import { visibleFocus } from './focusNavigation'

type Opener = { target: HTMLElement; options: FocusOptions }
const dialogOpeners = new WeakMap<Element, () => Opener | undefined>()

export function useDialogFocus() {
  const popup = useRef<HTMLDivElement>(null)
  const [resolveOpener] = useState(() => {
    const target = document.activeElement
    if (!target || target === document.body || target === document.documentElement || !(target instanceof HTMLElement)) return () => undefined
    const saved = { target, options: { preventScroll: true, focusVisible: target.matches(visibleFocus) } }
    // Shortcut help can replace the palette while focus is still inside the outgoing dialog.
    const parent = target.closest('[aria-modal="true"]')
    const outer = parent && dialogOpeners.get(parent)
    return () => saved.target.isConnected ? saved : outer?.()
  })
  const popupRef = useCallback((node: HTMLDivElement | null) => {
    popup.current = node
    if (node) dialogOpeners.set(node, resolveOpener)
  }, [resolveOpener])
  useEffect(() => () => {
    queueMicrotask(() => {
      if (document.activeElement !== document.body) return
      const opener = resolveOpener()
      opener?.target.focus(opener.options)
    })
  }, [resolveOpener])
  return { popup, popupRef }
}
