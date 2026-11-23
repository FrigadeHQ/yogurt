import { AUDIO_SPEAKER } from '../../shared/audioUpload'
import type { VoiceTurn } from './run'

/**
 * From voices to names on the transcript's other side. Only lines that say nothing yet (Them, or Audio on an uploaded
 * recording) get one: a name from
 * the call app, a voice label from an earlier pass, or one the person set is never changed.
 *
 * A voice whose already-named lines are mostly one name is that person, so the call app's names (or the person's
 * fixes) carry over to that voice's unnamed lines. Any other voice is "Speaker N", numbered after those already used,
 * the one heard most first. A recording with one voice and nothing named stays Them: there is no one to tell apart.
 */

export type NamedLine = { id: number; startMs: number; endMs: number; speaker: string | null }

/** a name carries over to a voice's other lines when at least this many of its lines have it, and most of them */
const MIN_NAMED = 3
const MOST = 0.6
const LABEL = /^Speaker (\d+)$/
/** no one yet: Them on a call, Audio on an uploaded recording */
export const unnamed = (speaker: string | null) => speaker === null || speaker === AUDIO_SPEAKER

/** The voice heard most over each line, or null when no turn covers it */
export function voiceOfLines(lines: NamedLine[], turns: VoiceTurn[]): Map<number, number | null> {
  const sorted = [...turns].sort((a, b) => a.startMs - b.startMs)
  const out = new Map<number, number | null>()
  let from = 0
  for (const l of [...lines].sort((a, b) => a.startMs - b.startMs)) {
    while (from < sorted.length && sorted[from].endMs <= l.startMs) from++
    const time = new Map<number, number>()
    for (let i = from; i < sorted.length && sorted[i].startMs < l.endMs; i++) {
      const t = sorted[i], o = Math.min(l.endMs, t.endMs) - Math.max(l.startMs, t.startMs)
      if (o > 0) time.set(t.voice, (time.get(t.voice) ?? 0) + o)
    }
    out.set(l.id, time.size ? [...time].sort((a, b) => b[1] - a[1])[0][0] : null)
  }
  return out
}

/** The names to give the lines that have none: [{ id, speaker }] */
export function nameVoices(lines: NamedLine[], turns: VoiceTurn[], voices: number): Array<{ id: number; speaker: string }> {
  const voiceOf = voiceOfLines(lines, turns)
  const open = lines.filter(l => unnamed(l.speaker) && voiceOf.get(l.id) != null)
  if (!open.length) return []

  // what each voice's named lines say
  const said = new Map<number, Map<string, number>>()
  for (const l of lines) {
    const v = voiceOf.get(l.id)
    if (v == null || unnamed(l.speaker)) continue
    const m = said.get(v) ?? new Map<string, number>()
    m.set(l.speaker!, (m.get(l.speaker!) ?? 0) + 1)
    said.set(v, m)
  }
  const nameOf = new Map<number, string>()
  for (const [v, m] of said) {
    const total = [...m.values()].reduce((a, b) => a + b, 0)
    const [top, n] = [...m].sort((a, b) => b[1] - a[1])[0]
    if (n >= MIN_NAMED && n / total >= MOST) nameOf.set(v, top)
  }

  const heard = [...new Set(open.map(l => voiceOf.get(l.id)!))]
  const left = heard.filter(v => !nameOf.has(v))
  // one voice, nothing to carry over: telling it apart from no one adds nothing
  if (voices <= 1 && nameOf.size === 0) return []
  let next = Math.max(0, ...lines.map(l => Number(LABEL.exec(l.speaker ?? '')?.[1] ?? 0))) + 1
  // voices come numbered by how much they are heard (cluster.ts), so Speaker 1 is the one heard most
  for (const v of left.sort((a, b) => a - b)) nameOf.set(v, `Speaker ${next++}`)
  return open.map(l => ({ id: l.id, speaker: nameOf.get(voiceOf.get(l.id)!)! }))
}
