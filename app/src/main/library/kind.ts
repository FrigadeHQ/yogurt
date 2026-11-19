import type { Filters } from './filters'

/**
 * What a question across meetings wants, by simple rules (swappable for something smarter later):
 * - find: where or what someone said: the best chunks of transcript;
 * - across: something gathered over many meetings (to-dos, decisions, a recap): each matching meeting's notes,
 *   which already sum it up;
 * - overview: how a meeting went, or what to make of it: a judgement of the whole meeting, so its notes and its best
 *   moments, not loose pieces (retrieve treats it as find when nothing narrows the meetings).
 */
export type Kind = 'find' | 'across' | 'overview'

const GATHER = /\b(?:action items?|to-?dos?|tasks|next steps|follow[- ]?ups?|decisions?|takeaways?)\b/i
const ALL = /\b(?:all|every|each|across|any)\b/i
const MINE = /\b(?:my|our)\s+(?:open\s+)?(?:action items?|to-?dos?|tasks|next steps|follow[- ]?ups?)\b/i
const DECIDED = /\bwhat\s+(?:did|have|has)\s+(?:we|they|i|the team)\s+(?:decide|decided|agree|agreed)\b/i
const RECAP = /\b(?:summari[sz]e|sum up|recap|overview|catch me up|what happened)\b/i
const WENT = /\bhow\s+(?:did|do|does)\b.*\b(?:go|went)\b|\bhow\s+(?:was|were)\b|\bwhat\s+(?:did|do)\s+\p{L}+\s+(?:think|make)\s+of\b|\b(?:vibe|impression|gist)s?\b/iu

export function questionKind(question: string, f: Filters): Kind {
  const dated = f.from !== undefined
  if (MINE.test(question) || DECIDED.test(question)) return 'across'
  if (GATHER.test(question) && (ALL.test(question) || dated)) return 'across'
  if ((RECAP.test(question) || WENT.test(question)) && (dated || /\bmeetings\b/i.test(question))) return 'across'
  if (RECAP.test(question) || WENT.test(question)) return 'overview'
  return 'find'
}
