import type { ComponentPropsWithRef } from 'react'
import { LevelBars } from './LevelBars'
import { Logo } from './Logo'
import { MicOff } from './Icons'

type Props = ComponentPropsWithRef<'div'> & { time: string; expanded?: boolean; muted?: boolean; illustration?: boolean }

function StillMeter() {
  return <svg data-testid="widget-wave" width="27" height="16" aria-hidden="true" fill="var(--pill-accent)" opacity=".835">
    {[8, 10, 12, 10, 8].map((height, i) =>
      <rect key={i} x={i * 6} y={(16 - height) / 2} width="3" height={height} rx="1.5" />)}
  </svg>
}

export function RecordingPill({ time, expanded, muted, illustration, className = '', children, ...props }: Props) {
  return <div {...props} data-open={expanded} data-illustration={illustration || undefined} className={`widget-pill ${className}`}>
    <div className="widget-details" aria-hidden="true">
      {expanded && <span className="widget-brand"><Logo size={18} className="text-white" /></span>}
      <div className="widget-readout">
        {illustration ? <StillMeter /> : <LevelBars testId="widget-wave" height={16} className="text-[var(--pill-accent)]" />}
        <span data-testid="widget-time" className="widget-time">{time}</span>
        {muted && !expanded && <span className="widget-mic-status">
          <span className="widget-mic-off" data-testid="widget-mic-off"><MicOff size={14} /></span>
        </span>}
      </div>
    </div>
    {children}
  </div>
}
