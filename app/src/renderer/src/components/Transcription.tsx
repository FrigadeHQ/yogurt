import { AudioLines } from 'lucide-react'
import { t } from '../../../shared/i18n'
import { transcriptionLabel, type TranscriptionState } from '../../../shared/transcription'
import { Loader } from './Icons'
import { Swap, SwapText } from './Swap'

export function TranscriptionControl({state,onStop}:{state:TranscriptionState;onStop:()=>void}) {
  const title=state==='preparing'?t('Cancel'):t('Stop transcription')
  return <button className="workspace-button note-resume-action" data-processing="true" aria-busy="true" data-testid="transcription-stop" aria-label={title} title={title} onClick={onStop}>
    <Swap show="busy" options={{busy:<span className="summary-stop-icon"><Loader size={14}/><span className="summary-stop-square"/></span>}}/>
    <SwapText text={state==='preparing'?t('Preparing audio…'):t('Transcribing…')}/>
  </button>
}
export function TranscriptionNotice({state,hasLines,onContinue,disabled}:{state?:TranscriptionState;hasLines:boolean;onContinue:()=>void;disabled?:boolean}) {
  if(state==='waiting-model'||state==='waiting-recording')return <p className="transcription-notice text-xs text-muted" role="status">{transcriptionLabel(state)}</p>
  if(state&& !['stopped','error'].includes(state))return null
  return <div className="summary-stopped transcription-notice" data-testid="transcription-notice">
    {state&&<p role="status">{transcriptionLabel(state)}</p>}
    <button className="summary-generate flex items-center gap-2.5 rounded-xl px-3 py-2 text-start text-sm whitespace-nowrap text-ink hover:bg-[var(--line)] focus-visible:bg-[var(--line)] disabled:opacity-50" data-testid="transcription-continue" disabled={disabled} onClick={onContinue}>
      <AudioLines size={15} className="text-muted" aria-hidden="true"/>{hasLines?t('Continue transcription'):t('Transcribe')}
    </button>
  </div>
}
