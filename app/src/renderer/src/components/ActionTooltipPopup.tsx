import { Tooltip } from '@base-ui/react/tooltip'

export function ActionTooltipPopup({ label, align = 'center' }: { label: string; align?: 'start' | 'center' }) {
  return <Tooltip.Portal>
    <Tooltip.Positioner side="top" align={align} sideOffset={6} className="z-[80]">
      <Tooltip.Popup role="tooltip" render={(props, { open }) => <div {...props} aria-hidden={!open} inert={!open} />}
        className="rounded-md border border-line bg-float px-2 py-1 text-xs whitespace-nowrap text-ink shadow-[var(--shadow)]">{label}</Tooltip.Popup>
    </Tooltip.Positioner>
  </Tooltip.Portal>
}
