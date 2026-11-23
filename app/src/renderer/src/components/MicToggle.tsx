import { t } from '../../../shared/i18n'
import { micIsOff, type MicState } from '../../../shared/types'
import { LoaderCircle, Mic, MicOff, TriangleAlert } from './Icons'
import { RecordingAction } from './RecordingAction'

export function MicToggle({ id, state, paused, pill }: { id: string; state?: MicState; paused?: boolean; pill?: boolean }) {
  const off = micIsOff(state)
  const pending = state === 'muting' || state === 'unmuting'
  const unmute = off || state === 'unmuting'
  const label = unmute ? t('Unmute my mic') : t('Mute my mic')
  const tooltip = unmute ? t('Unmute my mic in Yogurt') : t('Mute my mic in Yogurt')
  const Icon = pending ? LoaderCircle : state === 'unconfirmed' ? TriangleAlert : off ? MicOff : Mic
  const props = {
    'data-testid': pill ? 'widget-mic' : 'note-mic',
    'aria-pressed': pending || state === 'unconfirmed' ? 'mixed' as const : off,
    'aria-busy': pending,
    disabled: paused || pending || state === 'unconfirmed',
    onClick: () => { void window.yogurt.meetings.setMicMuted(id, !off) },
    children: <Icon size={14} aria-hidden="true" />,
  }
  return pill
    ? <button {...props} type="button" className="widget-mic no-drag" aria-label={label} title={tooltip} />
    : <RecordingAction {...props} className="note-record-action note-mic-action" label={label} tooltip={tooltip} />
}

export function MicFeedback({ state, paused }: { state?: MicState; paused?: boolean }) {
  const off = micIsOff(state)
  const text = state === 'muting' ? t('Muting mic…') : state === 'unmuting' ? t('Unmuting mic…')
    : state === 'unconfirmed' ? t('Mic mute couldn’t be confirmed.') : state === 'still-off' ? t('Mic is still off. Try again.')
    : off && paused ? t('Mic will stay off on resume') : off ? t('Mic off in Yogurt') : t('Mic on in Yogurt')
  const quiet = !state || state === 'on' || (state === 'off' && !paused)
  return <p role="status" className={quiet ? 'sr-only' : 'mic-feedback'}>{text}</p>
}
