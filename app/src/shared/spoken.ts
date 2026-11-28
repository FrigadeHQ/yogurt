/**
 * The language people speak in meetings, picked in the note's footer or Settings → Language. English only (the default)
 * or one other language tells whisper and Apple's speech which it is, so nothing is guessed (and whisper never
 * translates a line into a language it wrongly guessed); Multi-language leaves whisper to hear which it is.
 * Not the interface's language, and not the one the notes are written in.
 */
/** 'en', 'multi', or one of WHISPER_CODES */
export type Spoken = string

/** whisper's language codes (whisper.cpp's g_lang, less Cantonese, which large-v3 added), English first */
export const WHISPER_CODES: readonly string[] = [
  'en', 'zh', 'de', 'es', 'ru', 'ko', 'fr', 'ja', 'pt', 'tr', 'pl', 'ca', 'nl', 'ar', 'sv', 'it', 'id', 'hi', 'fi', 'vi',
  'he', 'uk', 'el', 'ms', 'cs', 'ro', 'da', 'hu', 'ta', 'no', 'th', 'ur', 'hr', 'bg', 'lt', 'la', 'mi', 'ml', 'cy', 'sk',
  'te', 'fa', 'lv', 'bn', 'sr', 'az', 'sl', 'kn', 'et', 'mk', 'br', 'eu', 'is', 'hy', 'ne', 'mn', 'bs', 'kk', 'sq', 'sw',
  'gl', 'mr', 'pa', 'si', 'km', 'sn', 'yo', 'so', 'af', 'oc', 'ka', 'be', 'tg', 'sd', 'gu', 'am', 'yi', 'lo', 'uz', 'fo',
  'ht', 'ps', 'tk', 'nn', 'mt', 'sa', 'lb', 'my', 'bo', 'tl', 'mg', 'as', 'tt', 'haw', 'ln', 'ha', 'ba', 'jw', 'su',
]
/** how many languages whisper can hear */
export const WHISPER_LANGUAGES = WHISPER_CODES.length

export const isSpoken = (v: unknown): v is Spoken => v === 'multi' || (typeof v === 'string' && WHISPER_CODES.includes(v))
export const spokenOf = (v: unknown): Spoken => (isSpoken(v) ? v : 'en')
/** what whisper is told for each chunk: the language picked, or nothing (it detects, then keeps each track's language) */
export const whisperLanguage = (s: Spoken): string | undefined => (s === 'multi' ? undefined : s)

/** the ISO 639-1 code a locale starts with, for whisper's codes that differ from it */
const ISO: Record<string, string> = { jw: 'jv', no: 'nb' }
export const isoOf = (code: string): string => ISO[code] ?? code

/** a language's name in the interface's language, capitalized ('es' in Spanish: 'Español') */
export function spokenLanguageName(code: string, ui: string): string {
  let name = code
  try { name = new Intl.DisplayNames([ui, 'en'], { type: 'language', fallback: 'code' }).of(isoOf(code)) ?? code } catch { /* an unknown locale */ }
  return name.charAt(0).toLocaleUpperCase(ui) + name.slice(1)
}

/** the languages one can pick besides English only and Multi-language, by name in the interface's language */
export const pickableLanguages = (ui: string): Array<{ code: string; name: string }> =>
  WHISPER_CODES.filter((c) => c !== 'en').map((code) => ({ code, name: spokenLanguageName(code, ui) })).sort((a, b) => a.name.localeCompare(b.name, ui))
