import { SpeakerEmbeddingExtractor, type OnlineStream } from 'sherpa-onnx-node'
import { readWavSamples } from './wav'

/**
 * Speaker embeddings for one meeting's speech ranges, in a utility process so ONNX inference never
 * blocks recording, transcription or the interface. One CAM++ model, CPU, two threads; the process
 * lives until the client lets it go.
 * Request: { id, wav, model, ranges: [{ startMs, endMs }] }. Response: { id, vectors } (holes below 800 ms) or { id, error }.
 */
const MIN_RANGE_MS = 800
const SAMPLE_RATE = 16000

let extractor: SpeakerEmbeddingExtractor | undefined
const extractorFor = (model: string) => extractor ??= new SpeakerEmbeddingExtractor({ modelConfig: { model, numThreads: 2, provider: 'cpu', debug: 0 } })

const embedOne = (ex: SpeakerEmbeddingExtractor, samples: Float32Array, r: { startMs: number; endMs: number }): Float32Array | null => {
  if (r.endMs - r.startMs < MIN_RANGE_MS) return null
  const from = Math.max(0, Math.floor(r.startMs / 1000 * SAMPLE_RATE)), to = Math.min(samples.length, Math.ceil(r.endMs / 1000 * SAMPLE_RATE))
  if (to - from < MIN_RANGE_MS * SAMPLE_RATE) return null
  const stream: OnlineStream = ex.createStream()
  stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: samples.subarray(from, to) })
  const v = ex.compute(stream)
  let sum = 0
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i]
  const n = Math.sqrt(sum) || 1
  for (let i = 0; i < v.length; i++) v[i] /= n
  return v
}

process.parentPort.on('message', (e: { data: { id: number; wav: string; model: string; ranges: Array<{ startMs: number; endMs: number }> } }) => {
  const { id, wav, model, ranges } = e.data
  try {
    const { samples } = readWavSamples(wav)
    const ex = extractorFor(model)
    const vectors = ranges.map((r) => embedOne(ex, samples, r))
    process.parentPort.postMessage({ id, vectors })
  } catch (err) {
    process.parentPort.postMessage({ id, error: err instanceof Error ? err.message : String(err) })
  }
})
