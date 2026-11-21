import { useEffect, useState } from 'react'
import { AudioLines } from 'lucide-react'
import type { VoicesProgress } from '../../../shared/types'
import { language, t } from '../../../shared/i18n'

/**
 * While a finished meeting's voices are told apart (main/voices): what it is doing and how far, as a bar. The summary
 * waits for it, so this says why. Gone once it is over.
 */
export function VoicesProgressBar({ meetingId }: { meetingId: string }) {
  const [v, setV] = useState<VoicesProgress | null>(null)
  useEffect(() => {
    let on = true
    setV(null)
    void window.yogurt.voices.progress(meetingId).then(x => { if (on) setV(x) }, () => {})
    const off = window.yogurt.voices.onProgress(x => { if (x.meetingId === meetingId) setV(x.phase === 'done' ? null : x) })
    return () => { on = false; off() }
  }, [meetingId])
  if (!v || v.phase === 'done') return null
  const label = v.phase === 'downloading' ? t('Getting the voice model…') : v.phase === 'grouping' ? t('Matching voices…') : t('Telling voices apart…')
  const percent = Math.floor(v.fraction * 100)
  return (
    <div data-testid="voices-progress" data-phase={v.phase} role="status"
      className="voices-progress pointer-events-auto mx-auto mt-3 flex w-fit max-w-[calc(100%-32px)] items-center gap-3 rounded-xl border border-line bg-float px-4 py-2 text-[13px] shadow-[var(--shadow)]">
      <AudioLines size={14} aria-hidden="true" className="shrink-0 text-muted" />
      <span>{label}</span>
      <div className="notes-download-progress voices-progress-bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <span style={{ width: `${percent}%` }} />
      </div>
      <span className="tabular-nums text-muted">{new Intl.NumberFormat(language(), { style: 'percent' }).format(percent / 100)}</span>
    </div>
  )
}
