import { AUDIO_SPEAKER } from '../shared/audioUpload'

const ABBREVIATION = /^(?:(?:\p{L}\.)+|(?:Dr|Prof|Mr|Mrs|Ms|Jr|Sr|St)\.),?$/iu

/** Call apps expose captions alongside names. Keep initials, suffixes and dotted usernames. */
export function speakerName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim()
  if (name.length > 60 || !/\p{L}/u.test(name) || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(name)) return null
  const words = name.normalize('NFKC').split(/\s+/)
  if (words.length > 6) return null
  for (const word of words) {
    if (ABBREVIATION.test(word)) continue
    const withoutInnerDots = word.replace(/(?<=[\p{L}\p{N}])\.(?=[\p{L}\p{N}])/gu, '')
    if (/[\p{Sentence_Terminal}:;؛]/u.test(withoutInnerDots)) return null
  }
  return name
}

export const segmentSpeaker = (value: unknown) => value === AUDIO_SPEAKER ? AUDIO_SPEAKER : speakerName(value)
