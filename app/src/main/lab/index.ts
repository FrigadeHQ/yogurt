// Transcript lab. After a meeting (or when asked during one), extra speech models read
// the recording again, stretch by stretch; their readings are kept to compare, and combined into the transcript shown.
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { trackFile, type AudioExt } from '../audio'
import type { Store } from '../store'
import { meetingWords, respell, whisperPrompt, type MeetingWords } from '../vocab'
import { combine, pickBest, type Reading } from '../../shared/labCombine'
import { modeFor, type CombineMode, type LabConfig, type LabModel } from './config'
import { decodeTrack, LANGUAGE_CODES, runModel, writeWindows, type Heard } from './engines'
import { createLabStore, type LabStore } from './labStore'
import type { LabView } from '../../shared/lab'
import { windowsOf, type Window } from './windows'


/** the vocabulary a model is given: names first (most often misheard), then companies, then the person's jargon */
export const vocabularyOf = (w: MeetingWords): string[] => [...new Set([...w.names.flatMap((n) => [n, ...n.split(/\s+/).filter((x) => x.length > 2)]), ...w.companies, ...(w.jargon ?? [])])].slice(0, 40)


/**
 * Each stretch's language: the one a detecting model heard when it is one of the meeting languages, else the one most
 * heard in this meeting, else the meeting's saved language, else the first language set up.
 */
export function languagesOf(ws: Window[], heard: Map<string, Heard> | undefined, allowed: string[], saved: string | null): Map<string, string> {
  const counts = new Map<string, number>()
  for (const w of ws) { const l = heard?.get(w.key)?.language; if (l && allowed.includes(l)) counts.set(l, (counts.get(l) ?? 0) + (w.endMs - w.startMs)) }
  const main = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? (saved && LANGUAGE_CODES[saved] && allowed.includes(LANGUAGE_CODES[saved]) ? LANGUAGE_CODES[saved] : allowed[0] ?? 'en')
  return new Map(ws.map((w) => { const l = heard?.get(w.key)?.language; return [w.key, l && allowed.includes(l) ? l : main] }))
}

/** a model not measured in a language counts for less than any measured one (a measured one is 0.75 to 0.95) */
export const UNMEASURED = 0.5

/** languages written in the Latin alphabet: a reading of them that is mostly in another one was made up (Qwen writes "la la" sung as ला ला) */
const LATIN = new Set(['en', 'fr', 'de', 'es', 'it', 'pt', 'nl', 'da', 'sv', 'no', 'fi', 'pl', 'cs', 'ro', 'hu', 'tr', 'id', 'vi'])
export const inScript = (text: string, lang: string): boolean => {
  if (!LATIN.has(lang)) return true
  const letters = text.match(/\p{L}/gu) ?? []
  return letters.length === 0 || letters.filter((c) => /\p{Script=Latin}/u.test(c)).length / letters.length >= 0.5
}

/** the readings of one stretch that count, each with its weight for that language */
export function readingsFor(models: LabModel[], key: string, lang: string, got: Map<string, Map<string, Heard>>): Reading[] {
  return models.filter((m) => m.combine !== false && (!m.languages || m.languages.includes(lang)))
    .map((m) => ({ model: m.id, text: got.get(m.id)?.get(key)?.text ?? '', weight: m.weight?.[lang] ?? UNMEASURED }))
    .filter((r) => r.text.trim() && inScript(r.text, lang))
}

/** One stretch's combined text */
export function combineOne(rs: Reading[], mode: CombineMode, terms: string[] = []): { text: string; choices: ReturnType<typeof combine>['choices'] } {
  if (!rs.length) return { text: '', choices: [] }
  if (mode === 'best') { const r = [...rs].sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1))[0]; return { text: r.text, choices: [] } }
  if (mode === 'pick') return { text: rs[pickBest(rs)].text, choices: [] }
  const c = combine(rs, { terms })
  return { text: c.text, choices: c.choices }
}

type Deps = {
  store: Store
  config: () => LabConfig | null
  dirOf: (id: string) => string
  exts: readonly AudioExt[]
  /** a meeting is being recorded or its live transcript is still being made: an automatic run waits for the graphics card */
  busy: () => boolean
  /** this meeting is still being recorded or transcribed live: its lines are not final, the transcript is not replaced yet */
  live: (id: string) => boolean
  /** the lab's results or the transcript changed: the window reads them again */
  changed: (id: string, transcript: boolean) => void
  log?: (line: string) => void
}

export function createTranscriptLab(d: Deps) {
  const lab: LabStore = createLabStore(d.store)
  const log = d.log ?? ((l: string) => console.log(`lab: ${l}`))
  const queue: string[] = []
  let running: string | null = null
  let abort: AbortController | null = null

  async function runOne(id: string) {
    const c = d.config()
    const m = d.store.meeting(id)
    if (!c || !m) { lab.setStatus(id, { state: 'failed', error: !c ? 'transcript-lab.json is missing or broken (see the log)' : 'the meeting is gone' }); d.changed(id, false); return }
    const step = (s: string) => { lab.setStatus(id, { state: 'running', step: s }); d.changed(id, false) }
    const work = join(tmpdir(), 'yogurt-lab', id)
    abort = new AbortController()
    const signal = abort.signal
    try {
      step('reading the recording')
      const audio: Record<'me' | 'them', Float32Array | undefined> = { me: undefined, them: undefined }
      for (const t of ['me', 'them'] as const) { const f = trackFile(d.dirOf(id), t, d.exts); if (f) audio[t] = await decodeTrack(c.ffmpeg, f) }
      if (!audio.me && !audio.them) throw new Error('the recording is gone')
      const ws = windowsOf(lab.liveSegments(id))
      rmSync(work, { recursive: true, force: true }); mkdirSync(work, { recursive: true })
      const files = writeWindows(work, ws, audio)
      const keyOf = new Map([...files].map(([k, f]) => [f, k]))
      const words = meetingWords(m)
      const vocabulary = vocabularyOf(words), context = whisperPrompt(words)
      const got = new Map<string, Map<string, Heard>>()
      const byKey = (heard: Map<string, Heard>) => new Map([...heard].map(([f, h]) => [keyOf.get(f)!, h]))

      // models that say which language they heard go first, the language left open
      const detectors = c.models.filter((x) => x.detects)
      for (const x of detectors) {
        step(`${x.label} (and the language)`)
        got.set(x.id, byKey(await runModel(c, x, [...files.values()], work, { vocabulary, context, signal, log })))
      }
      const langs = languagesOf(ws, detectors.length ? got.get(detectors[0].id) : undefined, c.languages, m.language)
      for (const x of detectors) lab.saveReadings(id, x.id, got.get(x.id)!)
      d.changed(id, false)

      for (const x of c.models.filter((y) => !y.detects)) {
        const mine = [...files].filter(([k]) => !x.languages || x.languages.includes(langs.get(k)!)).map(([, f]) => f)
        if (!mine.length) continue
        step(x.label)
        const heard = byKey(await runModel(c, x, mine, work, { language: (f) => langs.get(keyOf.get(f)!), vocabulary, context, signal, log }))
        got.set(x.id, heard)
        lab.saveReadings(id, x.id, heard)
        d.changed(id, false)
      }

      step('combining')
      // the stretches of this run replace the last run's only now: a run that fails or is stopped leaves those as they were
      lab.saveWindows(id, ws.map((w) => {
        const lang = langs.get(w.key)!
        const r = combineOne(readingsFor(c.models, w.key, lang, got), modeFor(c, lang), vocabulary)
        // a word one letter off a name or term of the meeting takes its spelling, as the live lines do
        return { ...w, language: lang, combined: respell(r.text, words) || w.texts.join(' '), choices: r.choices }
      }))
      lab.setStatus(id, { state: 'done' })
      // the combined transcript replaces the live one, unless the meeting is still going (a run after it does that) or the
      // person picked another version since
      if (!d.live(id) && ['live', 'combined'].includes(lab.status(id).using)) { lab.use(id, 'combined'); d.changed(id, true) }
      log(`${id}: ${ws.length} stretches, ${got.size} models, combined`)
    } catch (e) {
      const msg = signal.aborted ? 'stopped' : e instanceof Error ? e.message : String(e)
      lab.setStatus(id, { state: 'failed', error: msg })
      log(`${id}: ${msg}`)
    } finally {
      abort = null
      rmSync(work, { recursive: true, force: true })
      d.changed(id, false)
    }
  }

  async function drain() {
    if (running) return
    while (queue.length) {
      const id = queue.shift()!
      running = id
      try { await runOne(id) } finally { running = null }
    }
  }

  return {
    /** a run of every model on the meeting; once done, the combined transcript replaces the live one (after the meeting).
     * One already running is not enough when more of the meeting was said since: another is queued after it. */
    run(id: string) {
      if (!d.config()) return false
      if (queue.includes(id)) return true
      queue.push(id)
      lab.setStatus(id, { state: 'queued' })
      d.changed(id, false)
      void drain()
      return true
    },
    /** the meeting's transcript is done: an automatic run, once nothing else needs the graphics card */
    async finished(id: string) {
      const c = d.config()
      if (!c?.auto) return
      while (d.busy()) await new Promise((r) => setTimeout(r, 15_000))
      this.run(id)
    },
    /** stops the meeting's run, or takes it off the queue */
    stop(id: string) {
      const at = queue.indexOf(id)
      if (at >= 0) { queue.splice(at, 1); lab.setStatus(id, { state: 'failed', error: 'stopped' }); d.changed(id, false) }
      else if (running === id) abort?.abort()
    },
    view: (id: string): LabView => {
      const c = d.config()
      return { status: lab.status(id), windows: lab.windows(id), readings: lab.readings(id),
        models: (c?.models ?? []).map((m) => ({ id: m.id, label: m.label, combine: m.combine !== false })) }
    },
    scores: () => lab.scores(),
    use(id: string, version: string) { lab.use(id, version); d.changed(id, true) },
    /** the person's own text for a stretch: shown from now on, and the truth the models are measured by */
    fix(id: string, key: string, text: string | null) { lab.fix(id, key, text); lab.use(id, lab.status(id).using); d.changed(id, true) },
    enabled: () => { try { return !!d.config() } catch { return false } },
    store: lab,
  }
}
export type TranscriptLab = ReturnType<typeof createTranscriptLab>
