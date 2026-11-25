import { describe, expect, it } from 'vitest'
import { NEAR_MS, evidenceName, lineTurn, splitPlan, type SplitRow } from '../src/main/diarize/align'
import type { Turn } from '../src/main/diarize/rttm'

const identity = (t: string) => t
const w = (text: string, startMs: number, endMs: number) => ({ text: /^[^\p{L}\p{N}]/u.test(text) ? text : ' ' + text, startMs, endMs })
/** verbatim whisper pieces, spacing included (" geb"+"ür"+"t"+"iger" is " gebürtiger"); glue marks a piece the line
 *  keeps against the one before it without a space (what the transcript stores as `glue`) */
const word = (text: string, startMs: number, endMs: number, glue?: boolean) => ({ text, startMs, endMs, ...(glue ? { glue: true } : {}) })
const row = (id: number, text: string, startMs: number, endMs: number, speaker: string | null = null): SplitRow =>
  ({ id, text, startMs, endMs, speaker, words: text.split(' ').map((t, i, a) => w(t, startMs + i * Math.round((endMs - startMs) / a.length), startMs + (i + 1) * Math.round((endMs - startMs) / a.length))) })
const turns: Turn[] = [{ key: 'v1', startMs: 0, endMs: 1000 }, { key: 'v2', startMs: 2000, endMs: 4000 }]

describe('splitPlan', () => {
  it('splits one line across a speaker change, one row per voice', () => {
    const { keep, runs } = splitPlan([row(1, 'hello there friend', 0, 3000)], turns, identity)
    expect(keep).toEqual([])
    expect(runs.map(r => [r.key, r.text])).toEqual([['v1', ' hello'], ['v2', ' there friend']])
    expect(runs[0].startMs).toBe(0)
    expect(runs[1].endMs).toBe(3000)
    expect(runs.every(r => r.lineIds.includes(1))).toBe(true)
    expect(runs[0].words.map(x => x.text)).toEqual([' hello'])
  })
  it('joins consecutive words of one voice across line boundaries', () => {
    const { runs } = splitPlan([row(1, 'hello there', 0, 2000), row(2, 'friend', 2400, 3000)], turns, identity)
    expect(runs.map(r => [r.key, r.text])).toEqual([['v1', ' hello'], ['v2', ' there friend']])
    expect(runs[1].lineIds).toEqual([1, 2])
  })
  it('words with no turn inside 2 s stay with their line: untouched rows keep their id', () => {
    const far: Turn[] = [{ key: 'v1', startMs: 0, endMs: 500 }]
    const { keep, runs } = splitPlan([row(1, 'hello', 0, 500), row(2, 'lost words here', 10000, 12000)], far, identity)
    expect(keep).toEqual([2])
    expect(runs.map(r => r.key)).toEqual(['v1'])
  })
  it('a line with both assigned and unassigned words keeps an unsplit remainder', () => {
    const mid: Turn[] = [{ key: 'v1', startMs: 0, endMs: 400 }]
    const { keep, runs } = splitPlan([row(1, 'hello lost words', 0, 1200)], mid, identity)
    expect(keep).toEqual([])
    expect(runs.map(r => [r.key, r.text])).toEqual([['v1', ' hello'], [null, ' lost words']])
    expect(runs[1].speaker).toBeNull()
  })
  it("a run's evidence name is the duration-weighted majority of its source lines' call names", () => {
    const ann = row(1, 'hello there friend', 0, 3000, 'Ann Lee')
    const { runs } = splitPlan([ann], turns, identity)
    expect(runs.map(r => r.speaker)).toEqual(['Ann Lee', 'Ann Lee'])
    const mixed = [{ ...row(1, 'a b', 0, 2000, 'Ann Lee') }, { ...row(2, 'c d', 2000, 4000, 'Bo Park') }]
    const cross: Turn[] = [{ key: 'v1', startMs: 0, endMs: 3000 }]
    expect(splitPlan(mixed, cross, identity).runs.map(r => r.speaker)).toEqual(['Ann Lee'])
  })
  it('a lone word no turn claims joins the voice before it when it is near', () => {
    const mixed = [{ ...row(1, 'a b', 0, 2000, 'Ann Lee') }, { ...row(2, 'c d', 2000, 4000, 'Bo Park') }]
    const cross: Turn[] = [{ key: 'v1', startMs: 0, endMs: 3000 }]
    const { runs } = splitPlan(mixed, cross, identity)
    expect(runs.map(r => [r.key, r.text, r.endMs])).toEqual([['v1', ' a b c d', 4000]])
    expect(runs[0].speaker).toBe('Ann Lee')
  })
  it('a lone word no turn claims far past the last voice stays Them instead of stretching it', () => {
    const stray: SplitRow = { id: 1, text: 'a b stray', startMs: 0, endMs: 6600, speaker: 'Ann Lee', words: [w('a', 0, 1000), w('b', 1000, 2000), w('stray', 6000, 6600)] }
    const { keep, runs } = splitPlan([stray], [{ key: 'v1', startMs: 0, endMs: 3000 }], identity)
    expect(keep).toEqual([])
    expect(runs.map(r => [r.key, r.text, r.endMs])).toEqual([['v1', ' a b', 2000], [null, ' stray', 6600]])
  })
  it('a voiceless sliver inside a turn joins that voice (whisper chunk splits)', () => {
    // whisper splits a word across chunks; the leftover words are zero-length, and a point in time overlaps no turn
    const rows: SplitRow[] = [
      { id: 1, text: 'mit einem Orang-', startMs: 2600, endMs: 3200, speaker: null, words: [w('mit', 2600, 2900), w('einem', 2900, 3050), w('Orang-', 3050, 3200)] },
      { id: 2, text: 'Also Or', startMs: 3300, endMs: 3300, speaker: null, words: [w('Also', 3300, 3300), w('Or', 3300, 3300)] },
      { id: 3, text: 'ang-Utans sind toll', startMs: 3340, endMs: 4000, speaker: null, words: [w('ang-Utans', 3340, 3600), w('sind', 3600, 3800), w('toll', 3800, 4000)] },
    ]
    const { keep, runs } = splitPlan(rows, [{ key: 'v1', startMs: 2000, endMs: 5000 }], identity)
    expect(keep).toEqual([])
    expect(runs.map(r => [r.key, r.text])).toEqual([['v1', ' mit einem Orang- Also Or ang-Utans sind toll']])
  })
  it('a zero-length word inside overlapping turns takes the innermost one', () => {
    const rows: SplitRow[] = [{ id: 1, text: 'Was', startMs: 3500, endMs: 3500, speaker: null, words: [w('Was', 3500, 3500)] }]
    const over: Turn[] = [{ key: 'v1', startMs: 0, endMs: 4000 }, { key: 'v2', startMs: 3000, endMs: 6000 }]
    expect(splitPlan(rows, over, identity).runs.map(r => r.key)).toEqual(['v2'])
  })
  it('a sentence takes the turn it overlaps most when the boundary wobbles into it (fast turn-taking)', () => {
    // real meeting: the answer's "Ich glaube" (7058–7528) straddles the question's turn (until 7429); its sentence
    // is the guest's, so it goes back, and the question's "Wie viel" goes back to the question's turn
    const fast: Turn[] = [{ key: 'guest', startMs: 2741, endMs: 4319 }, { key: 'host', startMs: 4621, endMs: 7429 }, { key: 'guest', startMs: 7791, endMs: 9479 }]
    const rows: SplitRow[] = [
      { id: 1, text: 'Deep Work ist vorbei. Wie viel', startMs: 2378, endMs: 4528, speaker: null, words: [w('Deep', 2378, 2658), w('Work', 2658, 2928), w('ist', 2978, 3168), w('vorbei', 3168, 3508), w('.', 3618, 3968), w('Wie', 3978, 4208), w('viel', 4228, 4528)] },
      { id: 2, text: 'deiner Zeit arbeitest du ohne KI? Ich glaube', startMs: 4578, endMs: 7528, speaker: null, words: [w('de', 4578, 4688), w('iner', 4708, 5038), w('Zeit', 5038, 5368), w('ar', 5368, 5528), w('beit', 5688, 5858), w('est', 5858, 6098), w('du', 6098, 6258), w('ohne', 6258, 6588), w('KI', 6588, 6748), w('?', 6748, 7048), w('Ich', 7058, 7198), w('glaube', 7228, 7528)] },
      { id: 3, text: 'weniger als fünf Prozent. Platz', startMs: 7528, endMs: 9728, speaker: null, words: [w('weniger', 7528, 7908), w('als', 7908, 8068), w('fünf', 8068, 8188), w('Prozent', 8268, 8688), w('.', 8688, 8718), w('Platz', 8738, 9728)] },
    ]
    const { runs } = splitPlan(rows, fast, identity)
    expect(runs.map(r => [r.key, r.text])).toEqual([
      ['guest', ' Deep Work ist vorbei.'],
      ['host', ' Wie viel de iner Zeit ar beit est du ohne KI?'],
      ['guest', ' Ich glaube weniger als fünf Prozent. Platz'],
    ])
  })
  it('a whole sentence no turn overlaps joins the voice that speaks next (diarizer missed the utterance)', () => {
    // real leftovers: whisper transcribed speech Nemotron gave no turn to; the next turn starts 2.03–2.29 s
    // later, a hair past the 2 s stray-word cutoff, so every word stayed Them and the row kept its old self
    const question: SplitRow = {
      id: 1, text: '. Du bist also auch gebürtiger Berliner', startMs: 99729, endMs: 102549, speaker: null,
      words: [word('.', 99729, 99729), word(' Du', 100729, 100729), word(' bist', 100729, 100729), word(' also', 100729, 100729),
        word(' auch', 100769, 100989), word(' geb', 100989, 101249), word('ür', 101259, 101439, true), word('t', 101439, 101529, true),
        word('iger', 101529, 101879, true), word(' Ber', 101999, 102159), word('liner', 102159, 102549, true)],
    }
    const turns: Turn[] = [{ key: 'v1', startMs: 96021, endMs: 98429 }, { key: 'v2', startMs: 104581, endMs: 106769 }]
    const { keep, runs } = splitPlan([question], turns, identity)
    expect(keep).toEqual([])
    // the stray '.' closes the sentence before it; in a meeting the one-word rule merges it into that line
    expect(runs.map(r => [r.key, r.text])).toEqual([[null, '.'], ['v2', ' Du bist also auch gebürtiger Berliner']])
    // 5 s past the sentence the guess would be a coin flip: the row stays as it is
    const far: Turn[] = [{ key: 'v1', startMs: 96021, endMs: 98429 }, { key: 'v2', startMs: 107549, endMs: 109749 }]
    expect(splitPlan([{ ...question, id: 2 }], far, identity).keep).toEqual([2])
  })

  it('a narrated sentence in a turn gap goes to the turn after it', () => {
    // the other real leftover: "Als Lead Engineer bei Wunderlist half" sits in a 4.5 s gap between two turns
    // of the same voice, 2.06 s before the next one starts
    const narration: SplitRow = {
      id: 3, text: ' Als Lead Engineer bei Wunderlist half', startMs: 15834, endMs: 17474, speaker: null,
      words: [word(' Als', 15834, 15934), word(' Lead', 16044, 16174), word(' Engineer', 16194, 16574), word(' bei', 16574, 16714),
        word(' W', 16714, 16774), word('under', 16774, 17014, true), word('list', 17014, 17194, true), word(' half', 17234, 17474)],
    }
    const gap: Turn[] = [{ key: 'v2', startMs: 12221, endMs: 14999 }, { key: 'v2', startMs: 19531, endMs: 31249 }]
    expect(splitPlan([narration], gap, identity).runs.map(r => [r.key, r.text])).toEqual([['v2', ' Als Lead Engineer bei Wunderlist half']])
  })
  it('a voiceless sliver in a gap no turn covers stays an untouched row', () => {
    const both: Turn[] = [{ key: 'v1', startMs: 0, endMs: 2000 }, { key: 'v2', startMs: 6000, endMs: 8000 }]
    const rows: SplitRow[] = [
      { id: 1, text: 'a', startMs: 1000, endMs: 1500, speaker: null, words: [w('a', 1000, 1500)] },
      { id: 2, text: 'b', startMs: 3000, endMs: 3000, speaker: null, words: [w('b', 3000, 3000)] },
      { id: 3, text: 'c', startMs: 6500, endMs: 7000, speaker: null, words: [w('c', 6500, 7000)] },
    ]
    const { keep, runs } = splitPlan(rows, both, identity)
    expect(keep).toEqual([2])
    expect(runs.map(r => r.key)).toEqual(['v1', 'v2'])
  })
  it('glues punctuation without a space, like the live view does', () => {
    const glued: SplitRow = { id: 1, text: 'Sure.', startMs: 0, endMs: 500, speaker: null, words: [w('Sure', 0, 400), w('.', 400, 500)] }
    expect(splitPlan([glued], [{ key: 'v1', startMs: 0, endMs: 500 }], identity).runs[0].text).toBe(' Sure.')
  })
  it('rebuilds a saved line from its trimmed words, which keep the spacing as glue', () => {
    // what the transcript stores (asr/pipeline.ts): the live reader trims each word and records whether the token
    // had a leading space. Joining the raw texts lost every space: "ShewillsendadraftbyFriday."
    const words = ['She', 'will', 'send', 'a', 'draft', 'by', 'Friday'].map((text, i) => ({ text, startMs: i * 300, endMs: (i + 1) * 300 }))
    const row: SplitRow = { id: 1, text: 'She will send a draft by Friday.', startMs: 0, endMs: 2400, speaker: null, words: [...words, { text: '.', startMs: 2100, endMs: 2400, glue: true }] }
    expect(splitPlan([row], [{ key: 'v1', startMs: 0, endMs: 2400 }], identity).runs[0].text).toBe('She will send a draft by Friday.')
  })
  it('a line saved before glue was kept still spaces its words, punctuation included', () => {
    const words = ['She', 'will', 'send', 'a', 'draft', '.'].map((text, i) => ({ text, startMs: i * 300, endMs: (i + 1) * 300 }))
    const row: SplitRow = { id: 1, text: 'She will send a draft.', startMs: 0, endMs: 1800, speaker: null, words }
    expect(splitPlan([row], [{ key: 'v1', startMs: 0, endMs: 1800 }], identity).runs[0].text).toBe('She will send a draft.')
  })
  it('passes the text through the spell normalizer', () => {
    expect(splitPlan([row(1, 'aple', 0, 400)], [{ key: 'v1', startMs: 0, endMs: 400 }], t => t.replace('aple', 'apple')).runs[0].text).toBe(' apple')
  })
  it('lines whisper gave no words for fall back to whole-line max overlap', () => {
    const noWords: SplitRow = { id: 1, text: 'old line', startMs: 1000, endMs: 3000, speaker: 'Ann Lee' }
    const { keep, runs } = splitPlan([noWords], turns, identity)
    expect(keep).toEqual([1])
    expect(lineTurn(noWords, turns)?.key).toBe('v2')
    expect(lineTurn({ startMs: 10000, endMs: 11000 }, turns)).toBeNull()
  })
})

describe('evidenceName', () => {
  it('picks the named claim with the most speech', () => {
    expect(evidenceName([{ name: null, ms: 900 }, { name: 'Ann', ms: 500 }, { name: 'Bo', ms: 400 }])).toBe('Ann')
  })
  it('ignores null (Them) claims entirely', () => {
    expect(evidenceName([{ name: null, ms: 900 }, { name: 'Ann', ms: 100 }])).toBe('Ann')
    expect(evidenceName([{ name: null, ms: 900 }])).toBeNull()
  })
  it('ties go to the earliest claim', () => {
    expect(evidenceName([{ name: 'Ann', ms: 400 }, { name: 'Bo', ms: 400 }])).toBe('Ann')
  })
})
