import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Dialog } from '@animate-ui/react/primitives/base-ui/dialog'
import { MotionPopup } from './MotionPopup'
import { motion, useReducedMotion } from '../motion'

export const ModalClose = Dialog.Close

/** Shared accessible dialog with restrained motion and safe initial focus. */
export function Modal({ title, description, children, onCancel, busy = false, role = 'dialog', testId, container }: {
  title: string; description?: string; children: ReactNode
  onCancel: () => void; busy?: boolean; role?: 'dialog' | 'alertdialog'; testId?: string
  container?: HTMLElement | null
}) {
  const [open, setOpen] = useState(true)
  const reduce = useReducedMotion()
  const dialog = useRef<HTMLDivElement>(null)
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null)
  const cancel = useRef(onCancel)
  cancel.current = onCancel
  useEffect(() => {
    if (open) return
    // Keep conditionally mounted callers alive until the primitive's exit finishes.
    const timer = setTimeout(() => cancel.current(), reduce ? motion.micro : motion.base)
    return () => clearTimeout(timer)
  }, [open, reduce])
  return <Dialog.Root open={open} onOpenChange={(next, event) => {
    if (!next && busy) { event.cancel(); return }
    setOpen(next)
  }}>
    <Dialog.Portal keepMounted container={container}>
      <Dialog.Backdrop className="app-modal-backdrop no-drag" transition={{ ease: motion.out, duration: (reduce ? motion.micro : motion.surface) / 1000 }} exitTransition={{ ease: motion.out, duration: (reduce ? motion.micro : motion.base) / 1000 }} />
      <MotionPopup ref={dialog} data-testid={testId} role={role} aria-modal="true" aria-busy={busy || undefined}
        className="app-modal no-drag" finalFocus={opener} initialFocus={() => {
          const first = dialog.current?.querySelector<HTMLElement>('[data-dialog-focus], [data-dialog-cancel]')
          if (first instanceof HTMLInputElement) first.select()
          return first ?? dialog.current
        }}>
        <div className="modal-copy">
          <Dialog.Title>{title}</Dialog.Title>
          {description && <Dialog.Description>{description}</Dialog.Description>}
        </div>
        {children}
      </MotionPopup>
    </Dialog.Portal>
  </Dialog.Root>
}
