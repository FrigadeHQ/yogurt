import { tokens } from './echo'

/**
 * Lines whisper makes up when there is no speech to read. It can repeat its prompt or produce stock lines from the subtitles it learned from.
 */

/** a run of this many prompt words, and nothing else, is the prompt read back; a single name can be said for real */
const MIN_ECHO_TOKENS = 2
/** a read-back this long may carry one stray word of its own */
const LONG_ECHO_TOKENS = 4
/** whisper cuts a read-back off mid-word: the line's last word may be the start of the prompt's */
const MIN_CUT_CHARS = 3
/** a loose read-back: at least this many words, nearly all of them the prompt's */
const LOOSE_ECHO_TOKENS = 4
const LOOSE_ECHO_SHARE = 0.75
/** a word and the prompt's are one when one starts the other and the shorter is at least this long ("Fundacion", "Fundacionalba") */
const MIN_STEM_CHARS = 4

/** without accents: whisper writes the prompt's "Fundación" as "Fundacion" */
const folded = (w: string) => w.normalize('NFD').replace(/\p{M}/gu, '')
const sameWord = (a: string, b: string) => {
  const x = folded(a), y = folded(b)
  if (x === y) return true
  const [short, long] = x.length <= y.length ? [x, y] : [y, x]
  return short.length >= MIN_STEM_CHARS && long.startsWith(short)
}

/** The line is the prompt, or a stretch of two or more of its words in order, with no words of its own (one, in a long stretch) */
export function isPromptEcho(text: string, prompt: string): boolean {
  const t = tokens(text)
  const p = tokens(prompt)
  if (t.length < MIN_ECHO_TOKENS || t.length > 2 * p.length + 1) return false
  const same = (k: number, w: string) => w === t[k] || (k === t.length - 1 && t[k].length >= MIN_CUT_CHARS && w.startsWith(t[k]))
  // the longest stretch of the line that reads the prompt word for word
  let run = 0
  for (let a = 0; a < t.length; a++) for (let i = 0; i < p.length; i++) {
    let n = 0
    while (a + n < t.length && i + n < p.length && same(a + n, p[i + n])) n++
    run = Math.max(run, n)
  }
  if (run === t.length || (run >= LONG_ECHO_TOKENS && t.length - run <= 1)) return true
  // a loose read-back, seen on Spanish meetings: the prompt's words mangled ("Fundacionalba" as "Fundacion", "Fund"),
  // a made-up word or two among them, or read twice ("With Marta of Fundacion files. With Marta of Fundacion files.")
  if (t.length < LOOSE_ECHO_TOKENS) return false
  const theirs = t.filter((w) => p.some((q) => sameWord(w, q))).length
  return theirs / t.length >= LOOSE_ECHO_SHARE
}

/** whisper's stock lines on quiet audio, from video subtitles; whole lines only */
const GUESSES = new Set([
  'you', 'thank you', 'thank you very much', 'thanks', 'thanks for watching', 'thank you for watching', 'thanks for watching bye',
  'thank you bye', 'bye', 'bye bye', 'please subscribe', 'like and subscribe', 'for more information visit www fema org',
  'subtitles by the amara org community', 'untertitel der amara org community', 'sous titres réalisés para la communauté d amara org',
  'sous titres réalisés par la communauté d amara org', 'ご視聴ありがとうございました', 'продолжение следует',
].map((x) => tokens(x).join(' ')))

/** One of whisper's stock lines for silence. Only dropped where the audio was not clearly speech: people do say thank you. */
export const isSilenceGuess = (text: string): boolean => GUESSES.has(tokens(text).join(' '))

/**
 * The credit line at the end of a subtitled video, which whisper writes over quiet audio with a different name each time
 * ("Редактор субтитров А.Семкин Корректор А.Егорова", #138). Never something said in a meeting, so it goes whatever the
 * audio was: the line must start with the credit and stay short, so a sentence about subtitles stays.
 */
const CREDITS = [
  /^редактор субтитров(?!\p{L})/iu, /^субтитры (?:сделал|создавал|подготовил|делал|выполнил|создал)\p{L}*/iu, /^[Кк]орректор\s+\p{Lu}\.\s?\p{Lu}/u,
  /^(?:subtitles|subtitled|captions|captioned|captioning) by(?!\p{L})/iu, /^untertitel(?:ung)?\s+(?:im auftrag|des|der|von)(?!\p{L})/iu,
  /^sous[- ]titr(?:age|es?)(?!\p{L})(?!\s+(?:sont|est|en|du|de la|pour)(?!\p{L}))/iu, /^sottotitoli (?:creati|a cura|di|e revisione)(?!\p{L})/iu,
  /^subtítulos (?:realizados|por|hechos|creados)(?!\p{L})/iu, /^legendas (?:pela|por|feitas)(?!\p{L})/iu, /^napisy (?:wykonane|stworzone|przygotowa)/iu,
  /^ondertiteling (?:door|van)(?!\p{L})/iu, /^字幕(?:由|提供|制作|製作)/u,
]
/** short: a credit is a name or two after its words (in characters, since Chinese has no spaces) */
const CREDIT_MAX_CHARS = 80
export const isSubtitleCredit = (text: string): boolean => {
  const t = text.normalize('NFKC').trim()
  return t.length <= CREDIT_MAX_CHARS && CREDITS.some((re) => re.test(t))
}

/**
 * Whisper sometimes reads names from its prompt back as a speaker label before real speech ("Eric and Sam Lee: so let
 * me just get"). The label goes when it is the prompt word for word; a colon after words of its own stays.
 */
export function withoutPromptLabel(text: string, prompt: string): string {
  const m = /^([^:\n]{1,120}):\s+(\S[\s\S]*)$/.exec(text)
  if (!m) return text
  const label = tokens(m[1]), p = tokens(prompt)
  if (!label.length || !p.length) return text
  // in order, or shuffled with its little words dropped ("GmbH, Corinna Weber Jonas Braun:" from "With Corinna Weber and
  // Jonas Braun of Acme GmbH", #30): every word of the label is the prompt's, none of its own
  const words = new Set(p)
  const inPrompt = p.some((_, i) => label.every((w, k) => p[i + k] === w)) || label.every((w) => words.has(w))
  return inPrompt ? m[2] : text
}
