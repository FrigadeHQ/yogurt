import type { Chunk } from './chunker'
import type { Line } from './transcribe'
import { fakePrompts } from '../fake'

/**
 * Fake mode: no whisper. What the e2e fixtures (meeting-me.wav, meeting-them.wav) say, picked by where in the meeting
 * the chunk starts (the chunker cuts them at 0.5 s and 10.5 s on me, 5.2 s and 13.3 s on them).
 * Word times match simulated Apple's settled readings; a pause can split a phrase into shorter chunks.
 */
const SAYS = {
  me: [
    { at: 500, end: 4000, text: 'Hi, thanks for joining. Can we go over the launch plan for next week?' },
    { at: 10_500, end: 12_400, text: 'Great. Who is writing the release notes?' },
  ],
  them: [
    { at: 5200, end: 8700, text: 'Sure. The site goes live on Tuesday, and the email goes out on Wednesday morning.' },
    { at: 13_300, end: 14_800, text: 'She will send a draft by Friday.' },
  ],
} as const

export async function fakeTranscribe(c: Chunk, o?: { partial?: boolean }, prompt = '', language?: string): Promise<Line[]> {
  fakePrompts.whisper.push(prompt)
  fakePrompts.languages.push(language ?? 'auto')
  const near = SAYS[c.track].reduce((a, b) => (Math.abs(b.at - c.startMs) < Math.abs(a.at - c.startMs) ? b : a))
  // a partial: the first words, about as many as have been said so far
  const words = near.text.split(' ')
  const endMs = c.startMs + Math.round((c.samples.length / 16000) * 1000)
  // Resumed fixture audio can have a meeting offset beyond the script; keep its existing nearest-phrase stand-in.
  const overlaps = c.startMs < near.end && endMs > near.at
  // word times as whisper gives them, spread over the phrase (the other side's saved lines carry them to diarization)
  const step = (near.end - near.at) / words.length
  const timed = words.map((text, i) => ({ text, startMs: Math.round(near.at + i * step), endMs: Math.round(near.at + (i + 1) * step) }))
  // YOGURT_FAKE_SPLIT: whisper gives a word as pieces, the first carrying its leading space, every later one glued to
  // the word before, all lowercase ("Tuesday," as " tues"+"day,"). The line's text keeps the casing whisper wrote, so
  // a rebuild has to put the pieces back together, not show "tues day" in the transcript.
  const raw = process.env.YOGURT_FAKE_SPLIT === '1' && c.track === 'them'
  const piece = (w: string, startMs: number, endMs: number, glue: boolean) => ({ text: w, startMs, endMs, ...(glue ? { glue: true } : {}) })
  const piecesOf = (w: string, startMs: number, endMs: number) => {
    const cut = raw && w.length > 5 ? Math.ceil(w.length / 2) : 0, mid = Math.round((startMs + endMs) / 2)
    const t = w.toLocaleLowerCase()
    return cut ? [piece(' ' + t.slice(0, cut), startMs, mid, false), piece(t.slice(cut), mid, endMs, true)] : [piece(raw ? ' ' + w : w, startMs, endMs, false)]
  }
  // a piece belongs to the chunk that covers its middle
  const keptWords = o?.partial ? timed.slice(0, Math.max(2, Math.min(words.length - 1, Math.round(words.length * (c.samples.length / 16000) / 5))))
    : !overlaps ? timed : timed.filter((w) => { const at = (w.startMs + w.endMs) / 2; return at >= c.startMs && at < endMs })
  const kept = keptWords.flatMap((w) => piecesOf(w.text, w.startMs, w.endMs))
  const text = keptWords.map((w) => w.text).join(' ')
  // whisper's row starts at its chunk, before the first word it says; YOGURT_FAKE_LEAD gives a test that shape, so the
  // row's start matches no line the diarizer saves. By default the chunker cuts at the speech, so the row starts at
  // its first word.
  const lead = Number(process.env.YOGURT_FAKE_LEAD ?? 0)
  // Partials are only shown and replaced: they stay wordless like before (their timing comes from the text), so the
  // live view is unchanged. Finals that overlap the script carry the times: the other side's saved line needs them for
  // diarization. A resumed stand-in beyond the script does not, so it keeps the old wordless line.
  return text ? [{ track: c.track, startMs: Math.max(0, c.startMs - lead), endMs, text, ...(o?.partial || !overlaps ? {} : { words: kept }) }] : []
}
