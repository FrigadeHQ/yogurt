import type { ComponentPropsWithRef } from 'react'
import { TriangleAlert } from './Icons'
import { LevelBars } from './LevelBars'
import { Logo } from './Logo'

type Props = ComponentPropsWithRef<'div'> & { time: string; warning?: boolean; illustration?: boolean }

function StillMeter() {
  return <svg data-testid="widget-wave" width="27" height="16" aria-hidden="true" fill="var(--pill-accent)" opacity=".835">
    {[8, 10, 12, 10, 8].map((height, i) =>
      <rect key={i} x={i * 6} y={(16 - height) / 2} width="3" height={height} rx="1.5" />)}
  </svg>
}

export function RecordingPill({ time, warning, illustration, className = '', children, ...props }: Props) {
  return <div {...props} data-illustration={illustration || undefined} className={`widget-pill ${className}`}>
    <div className="widget-details" aria-hidden="true">
      <span className="text-[var(--pill-accent)]">{warning ? <TriangleAlert data-testid="widget-warning" size={18} /> : <Logo size={18} className="text-[var(--pill-accent)]" />}</span>
      {illustration ? <StillMeter /> : <LevelBars testId="widget-wave" height={16} className="text-[var(--pill-accent)]" />}
      <span data-testid="widget-time" className="widget-time">{time}</span>
    </div>
    {children}
  </div>
}
