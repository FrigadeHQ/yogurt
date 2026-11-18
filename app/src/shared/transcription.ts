import { t } from './i18n'
export type TranscriptionState = 'preparing' | 'queued' | 'transcribing' | 'waiting-model' | 'waiting-recording' | 'stopped' | 'error' | 'done'
export const transcriptionBusy = (state?: TranscriptionState) => !!state && ['preparing','queued','transcribing','waiting-model','waiting-recording'].includes(state)
export function transcriptionLabel(state?: TranscriptionState) {
  return state === 'preparing' ? t('Preparing audio…') : state === 'waiting-model' ? t('Waiting for the speech model') : state === 'waiting-recording' ? t('Waiting for recording to finish') : state === 'stopped' ? t('Transcription stopped.') : state === 'error' ? t("Yogurt couldn't transcribe this file.") : state && state !== 'done' ? t('Transcribing…') : undefined
}
