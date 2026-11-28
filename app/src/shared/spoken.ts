/** The language spoken in meetings, independent of the interface and summary languages. */
export const SPOKEN = ['en', 'multi', 'es', 'pt'] as const
export type Spoken = typeof SPOKEN[number]
export const isSpoken = (v: unknown): v is Spoken => SPOKEN.some(s => s === v)
export const spokenOf = (v: unknown): Spoken => isSpoken(v) ? v : 'en'
/** Multi-language lets Whisper detect each track. A pinned language applies to both. */
export const whisperLanguage = (s: Spoken): string | undefined => s === 'multi' ? undefined : s
/** how many languages whisper can hear (whisper.cpp's g_lang list less Cantonese, which large-v3 added) */
export const WHISPER_LANGUAGES = 99
