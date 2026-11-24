import { Tooltip } from '@base-ui/react/tooltip'
import { ActionTooltipPopup } from './ActionTooltipPopup'
import type { ButtonHTMLAttributes } from 'react'

export function RecordingAction({ label, tooltip = label, ...button }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; tooltip?: string }) {
  return <Tooltip.Root>
    <Tooltip.Trigger type="button" {...button} render={<button disabled={button.disabled} />} aria-label={label} delay={180} />
    <ActionTooltipPopup label={tooltip} />
  </Tooltip.Root>
}
