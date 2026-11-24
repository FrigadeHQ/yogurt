import { useEffect, useState, type MouseEvent, type KeyboardEvent } from 'react'
import { t } from '../../../shared/i18n'
import { micIsOff, micPendingAction, type MicState } from '../../../shared/types'
import { Mic, MicOff, TriangleAlert } from './Icons'
import { RecordingAction } from './RecordingAction'

export function MicToggle({ id, state, paused, pill }: { id: string; state?: MicState; paused?: boolean; pill?: boolean }) {
  const off = micIsOff(state)
  const pending = !!micPendingAction(state)
  const label = off ? t('Unmute my mic') : t('Mute my mic')
  const tooltip = off ? t('Unmute my mic in Yogurt') : t('Mute my mic in Yogurt')
  const Icon = state === 'unconfirmed' ? TriangleAlert : off ? MicOff : Mic
  const props = {
    'data-testid': pill ? 'widget-mic' : 'note-mic',
    'aria-pressed': state === 'unconfirmed' ? 'mixed' as const : off,
    'aria-busy': pending,
    disabled: paused || pending || state === 'unconfirmed',
    onClick: (event: MouseEvent<HTMLButtonElement>) => {
      if (!pending && event.detail <= 1) void window.yogurt.meetings.setMicMuted(id, !off)
    },
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.repeat && (event.key === 'Enter' || event.key === ' ')) event.preventDefault()
    },
    children: <Icon size={14} aria-hidden="true" />,
  }
  return pill
    ? <button {...props} type="button" className="widget-mic no-drag" aria-label={label} title={tooltip} />
    : <RecordingAction {...props} className="note-record-action note-mic-action" label={label} tooltip={tooltip} />
}

export function MicFeedback({ state, paused }: { state?: MicState; paused?: boolean }) {
  const pending = micPendingAction(state)
  const [slow, setSlow] = useState<typeof pending>()
  useEffect(() => {
    setSlow(undefined)
    if (!pending) return
    const timer = setTimeout(() => setSlow(pending), 700)
    return () => clearTimeout(timer)
  }, [pending])
  const off = micIsOff(state)
  const text = pending === 'muting' ? t('Muting mic…') : pending === 'unmuting' ? t('Unmuting mic…')
    : state === 'unconfirmed' ? t('Mic mute couldn’t be confirmed.') : state === 'still-off' ? t('Mic is still off. Try again.')
    : off && paused ? t('Mic will stay off on resume') : off ? t('Mic off in Yogurt') : t('Mic on in Yogurt')
  const quiet = !state || state === 'on' || (state === 'off' && !paused)
  if (pending) return <p role="status" className={slow === pending ? 'mic-pending-status' : 'sr-only'}>{slow === pending ? text : ''}</p>
  return <p role="status" className={quiet ? 'sr-only' : 'mic-feedback'}>{text}</p>
}
