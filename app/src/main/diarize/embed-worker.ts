import sherpa from 'sherpa-onnx-node'
import type { OnlineStream, SpeakerEmbeddingExtractor as Extractor } from 'sherpa-onnx-node'
import { embedRange, readWavSamples } from './wav'

/**
 * Speaker embeddings for one meeting's speech ranges, in a utility process so ONNX inference never
 * blocks recording, transcription or the interface. One CAM++ model, CPU, two threads; the process
 * lives until the client lets it go.
 * Request: { id, wav, model, ranges: [{ startMs, endMs }] }. Response: { id, vectors } (holes below 800 ms) or { id, error }.
 */
const SAMPLE_RATE = 16000

// sherpa-onnx-node is CommonJS: only its default export is reliable from this ES module
const { SpeakerEmbeddingExtractor } = sherpa

let extractor: Extractor | undefined
const extractorFor = (model: string) => extractor ??= new SpeakerEmbeddingExtractor({ model, numThreads: 2, provider: 'cpu', debug: 0 })

const embedOne = (ex: Extractor, samples: Float32Array, r: { startMs: number; endMs: number }): Float32Array | null => {
  const range = embedRange(r, samples.length, SAMPLE_RATE)
  if (!range) return null
  const stream: OnlineStream = ex.createStream()
  stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: samples.subarray(range.from, range.to) })
  const v = ex.compute(stream, false)
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
