/**
 * The language people speak in meetings, picked in the note's footer or Settings → Language. English only (the default)
 * tells whisper and Apple's speech it is English, so nothing is guessed; Multi-language leaves whisper to hear which it is.
 * Not the interface's language, and not the one the notes are written in.
 */
export type Spoken = 'en' | 'multi'
export const SPOKEN: readonly Spoken[] = ['en', 'multi']
export const spokenOf = (v: unknown): Spoken => (v === 'multi' ? 'multi' : 'en')
/** what whisper is told for each chunk: English, or nothing (it detects, then keeps each track's language) */
export const whisperLanguage = (s: Spoken): string | undefined => (s === 'en' ? 'en' : undefined)
/** how many languages whisper can hear (whisper.cpp's g_lang list less Cantonese, which large-v3 added) */
export const WHISPER_LANGUAGES = 99

/** Whisper codes for the languages available in the app’s language picker. */
export const SAVED_TRANSCRIPTION_LANGUAGES = [
  'ar', 'bn', 'cs', 'da', 'de', 'el', 'en', 'es', 'fi', 'fr', 'he', 'hi', 'hu', 'id', 'it', 'ja',
  'ko', 'ms', 'nl', 'no', 'pl', 'pt', 'ro', 'ru', 'sv', 'th', 'tl', 'tr', 'uk', 'vi', 'zh',
] as const
export type TranscriptionLanguage = 'auto' | typeof SAVED_TRANSCRIPTION_LANGUAGES[number]
export function isTranscriptionLanguage(value: unknown): value is TranscriptionLanguage {
  return value === 'auto' || SAVED_TRANSCRIPTION_LANGUAGES.some(code => code === value)
}

/** An explicit automatic job must take precedence over even an English-only app setting. */
export const recordedWhisperLanguage = (choice: string | undefined, spoken: Spoken): string | undefined =>
  choice === 'auto' ? undefined : choice ?? whisperLanguage(spoken)
