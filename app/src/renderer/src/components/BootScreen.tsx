import { useEffect, useId, useState } from 'react'
import { MARK, MARK_FIT } from '../../../shared/logo'
import { BOOT } from '../../../shared/onboarding'

/**
 * While Yogurt starts: the mark with a soft light passing over it. It fades in only after BOOT.showAfterMs from the
 * page's start (not from this mount), so a quick start never flashes it; App keeps it up for BOOT.minShownMs once seen.
 */
export function BootScreen() {
  const id = useId().replace(/:/g, '')
  const delay = Math.max(0, BOOT.showAfterMs - performance.now())
  return (
    <div data-testid="boot-screen" className="boot-screen" style={{ animationDelay: `${delay}ms` }} role="status" aria-label="Yogurt">
      <svg width={52} height={52} viewBox="0 0 100 100" aria-hidden="true" className="boot-mark">
        <defs>
          <clipPath id={`${id}-mark`}><path d={MARK} transform={MARK_FIT} clipRule="evenodd" /></clipPath>
          <linearGradient id={`${id}-band`} x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset=".5" stopColor="#fff" stopOpacity=".55" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
        </defs>
        <g clipPath={`url(#${id}-mark)`}>
          <rect width="100" height="100" fill="currentColor" />
          <rect className="boot-band" x="-70" y="-10" width="60" height="120" fill={`url(#${id}-band)`} />
        </g>
      </svg>
    </div>
  )
}

/** The existing native material sits behind the whole window. Only expose it during launch. */
export function MacLaunch({ active }: { active: boolean }) {
  const [showMark, setShowMark] = useState(() => performance.now() >= BOOT.showAfterMs)
  useEffect(() => {
    if (!active || showMark) return
    const timer = setTimeout(() => setShowMark(true), Math.max(0, BOOT.showAfterMs - performance.now()))
    return () => clearTimeout(timer)
  }, [active, showMark])
  return <div className="mac-launch" data-active={active || undefined} aria-hidden={!active || undefined}
    data-testid={active ? 'boot-screen' : undefined} role="status" aria-label="Yogurt">
    {showMark && <svg width={52} height={52} viewBox="0 0 100 100" aria-hidden="true" className="mac-launch-mark text-neutral-400 dark:text-white">
      <path d={MARK} fill="currentColor" transform={MARK_FIT} fillRule="evenodd" />
    </svg>}
  </div>
}
