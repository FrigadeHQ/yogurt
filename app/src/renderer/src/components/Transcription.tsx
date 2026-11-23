import { AudioLines, Loader } from './Icons'
import { InlineError } from './InlineError'
import { language, t } from '../../../shared/i18n'
import { transcriptionLabel, type TranscriptionState } from '../../../shared/transcription'
import { Swap, SwapText } from './Swap'

export function TranscriptionControl({state,onStop}:{state:TranscriptionState;onStop:()=>void}) {
  const title=state==='preparing'?t('Cancel'):t('Stop transcription')
  return <button className="workspace-button note-resume-action" data-processing="true" aria-busy="true" data-testid="transcription-stop" aria-label={title} title={title} onClick={onStop}>
    <Swap show="busy" options={{busy:<span className="summary-stop-icon"><Loader className="flex-none" size={14}/><span className="summary-stop-square"/></span>}}/>
    <SwapText text={state==='preparing'?t('Preparing audio…'):t('Transcribing…')}/>
  </button>
}

export type TranscriptNotice =
  | { kind: 'waiting'; state: 'waiting-model' | 'waiting-recording' }
  | { kind: 'transcribe'; state?: 'stopped' | 'error'; run: () => void; disabled: boolean }
  | { kind: 'upload'; run: () => void }
  /** a retention rule deleted the transcript, at this time */
  | { kind: 'deleted'; at: number }

export function transcriptionNotice(state: TranscriptionState | undefined, run: () => void, disabled: boolean): TranscriptNotice | undefined {
  if (state === 'waiting-model' || state === 'waiting-recording') return { kind: 'waiting', state }
  if (!state || state === 'stopped' || state === 'error') return { kind: 'transcribe', state, run, disabled }
}

export function TranscriptionNotice({ notice, centered, hasLines }: { notice: TranscriptNotice; centered: boolean; hasLines: boolean }) {
  if (notice.kind === 'waiting') return <p role="status" className={centered ? undefined : 'transcription-notice text-xs text-muted'}>{transcriptionLabel(notice.state)}</p>
  if (notice.kind === 'deleted') return <p data-testid="transcript-deleted" role="status" className={centered ? undefined : 'transcription-notice text-xs text-muted'}>
    {t('The transcript was deleted on {date}, as set in Settings.', { date: new Date(notice.at).toLocaleDateString(language(), { dateStyle: 'long' }) })}
  </p>

  const upload = notice.kind === 'upload'
  const message = upload ? t("Yogurt couldn't read this audio file.") : transcriptionLabel(notice.state)
  const label = upload ? t('Upload a file') : hasLines ? t('Continue transcription') : t('Transcribe')
  const button = <button type="button" data-testid={upload ? undefined : 'transcription-continue'} disabled={!upload && notice.disabled} onClick={notice.run}
    className={centered || upload ? 'workspace-button' : 'summary-generate flex items-center gap-2.5 rounded-xl px-3 py-2 text-start text-sm whitespace-nowrap text-ink hover:bg-[var(--line)] focus-visible:bg-[var(--line)] disabled:opacity-50'}>
    {!centered && !upload && <AudioLines size={15} className="text-muted" aria-hidden="true" />}{label}
  </button>

  if (upload && !centered) return <InlineError testId="upload-preparation-failed"><span>{message}</span>{button}</InlineError>
  return <div data-testid={upload ? 'upload-preparation-failed' : 'transcription-notice'} data-state={upload ? 'failed' : undefined} role={upload ? 'alert' : undefined}
    className={centered ? 'transcript-empty-notice' : 'summary-stopped transcription-notice'}>
    {message && <p role={upload ? undefined : 'status'}>{message}</p>}
    {button}
  </div>
}
