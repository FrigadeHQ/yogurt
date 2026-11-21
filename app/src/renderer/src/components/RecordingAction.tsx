import { Tooltip } from '@base-ui/react/tooltip'
import { ActionTooltipPopup } from './ActionTooltipPopup'
import type { ButtonHTMLAttributes } from 'react'

export function RecordingAction({ label, ...button }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <Tooltip.Root>
    <Tooltip.Trigger {...button} aria-label={label} delay={180} />
    <ActionTooltipPopup label={label} />
  </Tooltip.Root>
}
