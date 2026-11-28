// Transcript lab. Which extra speech models this computer has, from a file of its own.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** what a model can be told besides the audio: the language, a list of terms, context text */
export type Takes = 'language' | 'vocabulary' | 'context'

export type LabModel = {
  id: string
  label: string
  engine: 'transcribe' | 'nemo'
  path: string
  takes: Takes[]
  /** the languages it may be used for (ISO 639-1); none: any */
  languages?: string[]
  /** how much its words count in the vote, per language, from measurements: 1 - word error rate */
  weight?: Record<string, number>
  /** in the combined transcript (else run and shown only) */
  combine?: boolean
  /** reports the language it heard (Qwen3-ASR): read first, with the language open, so the others are told it */
  detects?: boolean
}

export type LabConfig = {
  ffmpeg: string
  engines: { transcribe?: string; nemo?: string }
  /** languages a meeting can be in; a stretch heard in another one is read in the meeting's main language */
  languages: string[]
  /** run on every meeting once its transcript is done */
  auto: boolean
  /** how each language's stretches are combined: one mode for all, or one per language; vote where none is said */
  mode: CombineMode | Record<string, CombineMode>
  models: LabModel[]
}

/** a vote word by word, the one reading closest to the rest, or the best weighted model's alone */
export type CombineMode = 'vote' | 'pick' | 'best'
export const modeFor = (c: LabConfig, language: string): CombineMode => (typeof c.mode === 'string' ? c.mode : c.mode[language]) ?? 'vote'
const MODES = ['vote', 'pick', 'best']
const TAKES = ['language', 'vocabulary', 'context']

export const labFile = (userData: string): string => join(userData, 'transcript-lab.json')

/** The lab's setup, or null when this computer has none (no file: Yogurt works as before). A broken file is an error. */
export function readLab(file: string): LabConfig | null {
  if (!existsSync(file)) return null
  const c = JSON.parse(readFileSync(file, 'utf8')) as Partial<LabConfig>
  const bad = (why: string) => new Error(`transcript-lab.json: ${why}`)
  if (!c.ffmpeg || !Array.isArray(c.models) || !c.models.length) throw bad('needs ffmpeg and at least one model')
  const models = c.models.map((m, i): LabModel => {
    if (!m || typeof m.id !== 'string' || !m.id || typeof m.path !== 'string') throw bad(`model ${i + 1} needs an id and a path`)
    if (m.engine !== 'transcribe' && m.engine !== 'nemo') throw bad(`${m.id}: engine is transcribe or nemo`)
    const takes = (m.takes ?? []).filter((t) => TAKES.includes(t))
    return { ...m, label: m.label || m.id, takes }
  })
  const ids = new Set(models.map((m) => m.id))
  if (ids.size !== models.length) throw bad('two models have the same id')
  if (['live', 'combined'].some((x) => ids.has(x))) throw bad('"live" and "combined" are not model ids')
  const mode = c.mode ?? 'vote'
  if (![...(typeof mode === 'string' ? [mode] : Object.values(mode))].every((x) => MODES.includes(x))) throw bad('mode is vote, pick or best')
  const missing = [c.ffmpeg, c.engines?.transcribe, c.engines?.nemo, ...models.map((m) => m.path)].filter((p): p is string => !!p && !existsSync(p))
  if (missing.length) throw bad(`names files that are not there: ${missing.join(', ')}`)
  return { ffmpeg: c.ffmpeg, engines: c.engines ?? {}, languages: c.languages?.length ? c.languages : ['en'], auto: c.auto ?? true, mode, models }
}
