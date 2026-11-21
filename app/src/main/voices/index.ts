import { utilityProcess } from 'electron'
import { join } from 'node:path'
import { ensureFile } from '../downloader'
import type { Store } from '../store'
import type { VoicesProgress } from '../../shared/types'
import { nameVoices, unnamed } from './assign'
import type { VoicesEvent, VoicesRequest } from './worker'

/**
 * Who said what on the other side, told apart by voice once a meeting is over: never while it records. Runs after
 * the transcript is final and the call app's names are in, before the summary is written (the summary uses the names,
 * and a summarised meeting may have its audio removed). Only lines still marked Them get a name (assign.ts), so the
 * call app's names and the person's own fixes always stand. Nothing about a voice is kept: the embeddings live only
 * in the utility process, for the length of one meeting.
 */

/** sherpa-onnx's export of NVIDIA TitaNet, as pinned and checked in November 2026: the file the method was measured with */
export const VOICE_MODELS = {
  embedding: { url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_large.onnx', fileName: 'nemo-titanet-large.onnx', sha256: 'd51abcf31717ef28162f26acb9d44dd4127c3d44c9b8624f699f3425daca8e77', bytes: 101_405_493 },
} as const

export function hookVoices(p: {
  store: Pick<Store, 'meeting' | 'segments' | 'setSegmentSpeakers' | 'speakerOrder'>
  /** where the voice models are kept */
  modelsDir: string
  /** the other side's recording, or null when there is none */
  trackFile: (id: string) => string | null
  /** the recorder, which decodes its own files */
  helper: () => string
  /** the worker's bundle (out/main/voices.js) */
  workerPath: string
  /** lines got their names: the window reads them again, and the summary may be due */
  changed: (id: string) => void
  /** how far it has got, for the note's progress bar; phase done when it is over (named or not) */
  progress?: (v: VoicesProgress) => void
  /** off: nothing runs (fake mode, unless a test asks for voices) */
  off?: boolean
  /** a test's stand-in for the model: no download, no worker; each line of the other side another voice, in turn,
   * with the same progress, naming and refresh as the real thing */
  fake?: boolean
  log?: (msg: string) => void
}) {
  const log = p.log ?? ((s: string) => console.info(s))
  const runs = new Map<string, Promise<void>>()
  let queue: Promise<unknown> = Promise.resolve()
  /** each meeting's latest progress, for a window opened partway through */
  const now = new Map<string, VoicesProgress>()
  const tell = (v: VoicesProgress) => {
    if (v.phase === 'done') now.delete(v.meetingId); else now.set(v.meetingId, v)
    p.progress?.(v)
  }
  const clamp = (x: number) => Math.max(0, Math.min(1, x))

  const model = (id: string) => {
    const m = VOICE_MODELS.embedding
    return ensureFile({ url: m.url, sha256: m.sha256, sizeGB: m.bytes / 1e9, dir: join(p.modelsDir, 'voices'), fileName: m.fileName,
      onProgress: ({ fraction }) => tell({ meetingId: id, phase: 'downloading', fraction: clamp(fraction) }) })
  }

  const tellApart = (request: VoicesRequest, onProgress: (e: Extract<VoicesEvent, { type: 'progress' | 'grouping' }>) => void) => new Promise<{ turns: Array<{ startMs: number; endMs: number; voice: number }>; voices: number }>((resolve, reject) => {
    const proc = utilityProcess.fork(p.workerPath, [], { serviceName: 'Yogurt Voices' })
    let done = false, logged = 0
    const end = (fn: () => void) => { if (done) return; done = true; proc.kill(); fn() }
    proc.on('message', (e: VoicesEvent) => {
      if (e.type === 'progress' || e.type === 'grouping') {
        onProgress(e)
        if (e.type === 'progress' && e.seconds - logged >= 600) { logged = e.seconds; log(`voices: ${Math.round(e.seconds / 60)} min read`) }
        return
      }
      if (e.type === 'result') end(() => resolve(e))
      else end(() => reject(new Error(e.message)))
    })
    proc.on('exit', code => end(() => reject(new Error(`the voices process ended (${code})`))))
    proc.postMessage(request)
  })

  const run = async (id: string) => {
    const m = p.store.meeting(id)
    if (!m || m.state === 'recording') return
    const them = () => p.store.segments(id).filter(s => s.track === 'them')
    if (!them().some(s => unnamed(s.speaker))) return
    const file = p.trackFile(id)
    if (!file) { log('voices: no recording of the other side'); return }
    const started = Date.now()
    tell({ meetingId: id, phase: 'listening', fraction: 0 })
    // every line of the other side, named or not: names already there carry over to the rest of their voice
    const spans = them().map(s => ({ startMs: s.startMs, endMs: s.endMs }))
    // the bar runs to the last line of the other side (the audio after it holds nothing to name)
    const total = Math.max(1, ...spans.map(s => s.endMs)) / 1000
    const onProgress = (e: Extract<VoicesEvent, { type: 'progress' | 'grouping' }>) =>
      tell(e.type === 'grouping' ? { meetingId: id, phase: 'grouping', fraction: 1 } : { meetingId: id, phase: 'listening', fraction: clamp(e.seconds / total) })
    const { turns, voices } = p.fake ? await fakeVoices(spans, total, onProgress) : await (async () => {
      const embedding = await model(id)
      tell({ meetingId: id, phase: 'listening', fraction: 0 })
      return tellApart({ file, helper: p.helper(), embedding, spans }, onProgress)
    })()
    // read again: the person may have named someone while this ran, and theirs stands
    const lines = them()
    if (p.store.meeting(id)?.state === 'recording') return
    const named = nameVoices(lines, turns, voices)
    if (named.length) {
      p.store.setSegmentSpeakers(named)
      for (const name of new Set(named.map(n => n.speaker))) p.store.speakerOrder(id, name)
      p.changed(id)
    }
    // counts only: main.log is pasted into public issues
    log(`voices: ${voices} told apart in ${Math.round((Date.now() - started) / 1000)} s, ${named.length} of ${lines.length} lines of the other side named`)
  }

  return {
    /** tells the voices of a finished meeting apart (once at a time); resolves when its lines have their names, or it gave up */
    run(id: string): Promise<void> {
      if (p.off) return Promise.resolve()
      const pending = runs.get(id)
      if (pending) return pending
      const job = queue.then(() => run(id)).catch(e => console.error('voices: telling the voices apart failed', e))
        .finally(() => { runs.delete(id); if (now.has(id)) tell({ meetingId: id, phase: 'done' }) })
      queue = job
      runs.set(id, job)
      return job
    },
    /** how far a meeting's voices have got, or null when nothing is running for it */
    progress: (id: string): VoicesProgress | null => now.get(id) ?? null,
  }
}
export type Voices = ReturnType<typeof hookVoices>

/** tests: the voices "heard" in a few steps, each line another voice in turn (two voices) */
async function fakeVoices(spans: Array<{ startMs: number; endMs: number }>, total: number, onProgress: (e: Extract<VoicesEvent, { type: 'progress' | 'grouping' }>) => void) {
  for (let i = 1; i <= 4; i++) { await new Promise(r => setTimeout(r, 400)); onProgress({ type: 'progress', seconds: (total * i) / 4 }) }
  onProgress({ type: 'grouping' })
  await new Promise(r => setTimeout(r, 300))
  return { turns: spans.map((s, i) => ({ ...s, voice: i % 2 })), voices: 2 }
}
