import { createReadStream } from 'node:fs'
import { createRequire } from 'node:module'
import { cpus } from 'node:os'
import { helperDecode } from '../asr/backfill'
import { RATE, voiceTurns, type Engine, type Span } from './run'

/**
 * The voices of one recording, told apart in a utility process of its own: the models take a few minutes of CPU on a
 * long meeting, and the app stays responsive meanwhile. Asked once per recording, after it is finished (index.ts).
 */
/** spans: the transcript's lines of the other side, on meeting time */
export type VoicesRequest = { file: string; helper: string; embedding: string; spans: Span[] }
export type VoicesEvent =
  | { type: 'progress'; seconds: number }
  | { type: 'grouping' }
  | { type: 'result'; turns: Array<{ startMs: number; endMs: number; voice: number }>; voices: number }
  | { type: 'error'; message: string }

// half the cores, at most 4: the notes model may be loading on the rest
const THREADS = Math.max(1, Math.min(4, Math.floor(cpus().length / 2)))

function engine(r: VoicesRequest): Engine {
  // loaded here, not at the top: a missing native library becomes an error message, not a crash before listening
  const sherpa = createRequire(import.meta.url)('sherpa-onnx-node')
  const extractor = new sherpa.SpeakerEmbeddingExtractor({ model: r.embedding, numThreads: THREADS, debug: 0 })
  return {
    embed: samples => {
      const stream = extractor.createStream()
      stream.acceptWaveform({ samples, sampleRate: RATE })
      stream.inputFinished()
      // copied, not handed over: Electron's processes refuse memory owned by a native addon ("External buffers are not allowed")
      return Float32Array.from(extractor.compute(stream, false))
    },
  }
}

/** an uploaded file, already 16 kHz mono 16-bit PCM after a 44-byte header (audioUpload.ts), read as it streams */
async function* wavStream(file: string): AsyncGenerator<Float32Array> {
  let rest: Buffer = Buffer.alloc(0)
  for await (const bytes of createReadStream(file, { start: 44, highWaterMark: 1 << 16 }) as AsyncIterable<Buffer>) {
    const b = rest.length ? Buffer.concat([rest, bytes]) : bytes, n = b.length - (b.length % 2), out = new Float32Array(n / 2)
    for (let i = 0; i < out.length; i++) out[i] = b.readInt16LE(i * 2) / 32768
    rest = b.subarray(n)
    if (out.length) yield out
  }
}

process.parentPort.on('message', ({ data }: { data: VoicesRequest }) => {
  const send = (e: VoicesEvent) => process.parentPort.postMessage(e)
  void (async () => {
    try {
      const audio = data.file.endsWith('.wav') ? wavStream(data.file) : helperDecode(data.helper, data.file)
      const { turns, voices } = await voiceTurns(audio, data.spans, engine(data), seconds => send({ type: 'progress', seconds }), () => send({ type: 'grouping' }))
      send({ type: 'result', turns, voices })
    } catch (e) {
      send({ type: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  })()
})
