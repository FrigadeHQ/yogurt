import { Tooltip } from '@base-ui/react/tooltip'
import type { ButtonHTMLAttributes } from 'react'

export function RecordingAction({ label, ...button }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <Tooltip.Root>
    <Tooltip.Trigger {...button} aria-label={label} delay={180} />
    <Tooltip.Portal>
      <Tooltip.Positioner side="top" sideOffset={6} className="z-[80]">
        <Tooltip.Popup role="tooltip" render={(props, { open }) => <div {...props} aria-hidden={!open} inert={!open} />}
          className="rounded-md border border-line bg-float px-2 py-1 text-xs whitespace-nowrap text-ink shadow-[var(--shadow)]">{label}</Tooltip.Popup>
      </Tooltip.Positioner>
    </Tooltip.Portal>
  </Tooltip.Root>
}
