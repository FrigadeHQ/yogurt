import { Dialog } from '@base-ui/react/dialog'
import { forwardRef, type ComponentPropsWithoutRef } from 'react'

/** The dialog primitive owns focus and the interruptible entry/exit lifecycle. */
export const MotionPopup = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof Dialog.Popup>>(
  function MotionPopup({ className, ...props }, ref) {
    return <Dialog.Popup {...props} ref={ref}
      className={state => `${typeof className === 'function' ? className(state) : className ?? ''} dialog-motion`} />
  },
)
