// Transcript lab. Running the extra speech models over a meeting's stretches.
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { wavBytes } from '../asr/transcribe'
import type { LabConfig, LabModel } from './config'
import type { Window } from './windows'

/** a track's recording as 16 kHz mono samples, read by ffmpeg */
export function decodeTrack(ffmpeg: string, file: string): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ['-loglevel', 'error', '-i', file, '-f', 's16le', '-ac', '1', '-ar', '16000', '-'], { windowsHide: true })
    const parts: Buffer[] = []
    let err = ''
    p.stdout.on('data', (b: Buffer) => parts.push(b))
    p.stderr.on('data', (b: Buffer) => { err += b })
    p.on('error', reject)
    p.on('close', (code) => {
      if (code) return reject(new Error(`ffmpeg ${code}: ${err.slice(-500)}`))
      const b = Buffer.concat(parts), out = new Float32Array(b.length >> 1)
      for (let i = 0; i < out.length; i++) out[i] = b.readInt16LE(i * 2) / 32768
      resolve(out)
    })
  })
}

/** a little audio either side of a stretch, so its first and last words are whole */
export const PAD_MS = 250

/** Each stretch as a wav in dir: <key>.wav (':' made '_'). Returns the path of each, by key. */
export function writeWindows(dir: string, ws: Window[], audio: Record<Window['track'], Float32Array | undefined>): Map<string, string> {
  mkdirSync(dir, { recursive: true })
  const out = new Map<string, string>()
  for (const w of ws) {
    const a = audio[w.track]
    if (!a) continue
    const from = Math.max(0, Math.round(((w.startMs - PAD_MS) * 16000) / 1000)), to = Math.min(a.length, Math.round(((w.endMs + PAD_MS) * 16000) / 1000))
    if (to - from < 1600) continue
    const file = join(dir, `${w.key.replace(':', '_')}.wav`)
    writeFileSync(file, wavBytes(a.subarray(from, to)))
    out.set(w.key, file)
  }
  return out
}

/** what a model heard in one stretch; language: the one it reports hearing (models that detect it) */
export type Heard = { text: string; language?: string }

export type RunOpts = {
  /** the language of each file (path → ISO code); none: the model finds out */
  language?: (file: string) => string | undefined
  vocabulary?: string[]
  context?: string
  signal?: AbortSignal
  /** a line of the engine's own output, for the log */
  log?: (line: string) => void
}

function run(bin: string, args: string[], o: RunOpts): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true, signal: o.signal })
    let out = '', err = ''
    p.stdout.on('data', (b: Buffer) => { out += b.toString('utf8') })
    p.stderr.on('data', (b: Buffer) => { err += b.toString('utf8'); if (err.length > 20_000) err = err.slice(-10_000) })
    p.on('error', reject)
    p.on('close', (code) => (code ? reject(new Error(`${bin} exited ${code}: ${err.slice(-800)}`)) : resolve(out)))
  })
}

/** Qwen3-ASR's raw text starts "language French<asr_text>" */
/** language names as the models write them (Qwen3-ASR) and as Yogurt saves a meeting's (whisper) → ISO 639-1 */
export const LANGUAGE_CODES: Record<string, string> = { english: 'en', french: 'fr', german: 'de', spanish: 'es', italian: 'it', portuguese: 'pt', dutch: 'nl', chinese: 'zh', japanese: 'ja' }
export function heardLanguage(raw: string | undefined): string | undefined {
  const m = raw?.match(/^\s*language\s+([A-Za-z]+)\s*<asr_text>/)
  return m ? LANGUAGE_CODES[m[1].toLowerCase()] ?? m[1].toLowerCase() : undefined
}

/** transcribe.cpp: one process per language (the model loads once for all of that language's stretches) */
async function runTranscribe(bin: string, m: LabModel, files: string[], dir: string, o: RunOpts): Promise<Map<string, Heard>> {
  const groups = new Map<string, string[]>()
  for (const f of files) {
    const lang = m.takes.includes('language') ? o.language?.(f) ?? '' : ''
    groups.set(lang, [...(groups.get(lang) ?? []), f])
  }
  const out = new Map<string, Heard>()
  for (const [lang, group] of groups) {
    const list = join(dir, `${m.id}-${lang || 'auto'}.list`)
    writeFileSync(list, group.join('\n') + '\n')
    const args = ['-q', '-m', m.path, '--backend', 'vulkan', '--batch', list, '--batch-jsonl']
    if (lang) args.push('-l', lang)
    if (o.vocabulary?.length && m.takes.includes('vocabulary')) args.push('--vocabulary', o.vocabulary.join(','))
    if (o.context && m.takes.includes('context')) args.push('--prompt', o.context)
    const text = await run(bin, args, o)
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('{')) continue
      const j = JSON.parse(line) as { file?: string; text?: string; raw_text?: string; error?: string }
      if (!j.file) continue
      if (j.error) { o.log?.(`${m.id}: ${j.file}: ${j.error}`); continue }
      out.set(norm(j.file), { text: (j.text ?? '').trim(), ...(heardLanguage(j.raw_text) ? { language: heardLanguage(j.raw_text) } : {}) })
    }
  }
  return new Map(files.map((f) => [f, out.get(norm(f)) ?? { text: '' }]))
}

/** NeMo-Speech (Nemotron): a directory in, a json per file out; the language as a hint, one run per language */
async function runNemo(bin: string, m: LabModel, files: string[], dir: string, o: RunOpts): Promise<Map<string, Heard>> {
  const groups = new Map<string, string[]>()
  for (const f of files) { const lang = o.language?.(f) ?? ''; groups.set(lang, [...(groups.get(lang) ?? []), f]) }
  const out = new Map<string, Heard>()
  for (const [lang, group] of groups) {
    const src = join(dir, `${m.id}-${lang || 'auto'}-in`), dst = join(dir, `${m.id}-${lang || 'auto'}-out`)
    mkdirSync(src, { recursive: true })
    group.forEach((f, i) => copyFileSync(f, join(src, `${i}.wav`)))
    const args = ['transcribe', src, '-m', m.path, '--backend', 'vulkan', '-f', 'json', '--output-dir', dst, '-c', '4', '--force']
    if (lang) args.push('-l', lang)
    if (o.context && m.takes.includes('context')) args.push('--instruction', o.context)
    await run(bin, args, o)
    group.forEach((f, i) => {
      const j = join(dst, `${i}.json`)
      const r = existsSync(j) ? (JSON.parse(readFileSync(j, 'utf8')) as { text?: string; transcript?: string }) : {}
      out.set(f, { text: (r.text ?? r.transcript ?? '').trim() })
    })
  }
  return out
}

const norm = (p: string) => p.replace(/\//g, '\\').toLowerCase()

/** One model over the given stretch files: what it heard in each */
export function runModel(c: LabConfig, m: LabModel, files: string[], dir: string, o: RunOpts): Promise<Map<string, Heard>> {
  const bin = m.engine === 'nemo' ? c.engines.nemo : c.engines.transcribe
  if (!bin) throw new Error(`no ${m.engine} engine set in transcript-lab.json for ${m.id}`)
  return (m.engine === 'nemo' ? runNemo : runTranscribe)(bin, m, files, dir, o)
}
