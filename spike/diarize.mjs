// Full offline diarization with sherpa-onnx (pyannote segmentation-3.0 + a speaker embedding + fast clustering).
// This is the "end of meeting" re-cluster pass: whole file in, who-spoke-when out.
//
//   node diarize.mjs <wav 16k mono> <embedding.onnx> [--threshold 0.5 | --speakers N] [--rttm ref.rttm] [--threads 1] [--int8] [--seconds S]
import { createRequire } from 'node:module'
import { der, readRttm } from './lib.mjs'
const require = createRequire(import.meta.url)
const sherpa = require('sherpa-onnx-node')

const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
const [wav, emb] = args
const threads = Number(opt('--threads', 1))
const seg = new URL(`./models/sherpa-onnx-pyannote-segmentation-3-0/${args.includes('--int8') ? 'model.int8.onnx' : 'model.onnx'}`, import.meta.url).pathname

const config = {
  segmentation: { pyannote: { model: seg }, numThreads: threads },
  embedding: { model: emb, numThreads: threads },
  clustering: opt('--speakers') ? { numClusters: Number(opt('--speakers')) } : { numClusters: -1, threshold: Number(opt('--threshold', 0.5)) },
  minDurationOn: 0.2,
  minDurationOff: 0.5,
}

let t0 = performance.now()
const sd = new sherpa.OfflineSpeakerDiarization(config)
const loadMs = performance.now() - t0
const wave = sherpa.readWave(wav)
if (wave.sampleRate !== sd.sampleRate) throw new Error(`need ${sd.sampleRate} Hz, got ${wave.sampleRate}`)
const seconds = Number(opt('--seconds', 0))
const samples = seconds ? wave.samples.slice(0, seconds * wave.sampleRate) : wave.samples
const audioS = samples.length / wave.sampleRate

t0 = performance.now()
const segments = sd.process(samples)
const runS = (performance.now() - t0) / 1000
const rss = process.memoryUsage().rss / 1e6

if (!args.includes('--quiet')) for (const s of segments.slice(0, 25)) console.log(`${s.start.toFixed(2).padStart(8)} -- ${s.end.toFixed(2).padStart(8)}  speaker_${String(s.speaker).padStart(2, '0')}`)
if (!args.includes('--quiet') && segments.length > 25) console.log(`  ... ${segments.length - 25} more segments`)

const result = {
  embedding: emb.split('/').pop(), segmentation: seg.split('/').pop(), threads, clustering: config.clustering,
  audioSeconds: +audioS.toFixed(1), loadSeconds: +(loadMs / 1000).toFixed(2), runSeconds: +runS.toFixed(2), rtf: +(runS / audioS).toFixed(4),
  speakersFound: new Set(segments.map((s) => s.speaker)).size, segments: segments.length, rssMB: Math.round(rss),
}
const rttm = opt('--rttm')
if (rttm) {
  const ref = readRttm(rttm).filter((r) => r.start < audioS).map((r) => ({ ...r, end: Math.min(r.end, audioS) }))
  const hyp = segments.map((s) => ({ start: s.start, end: s.end, spk: `s${s.speaker}` }))
  result.der = der(ref, hyp)
  result.der_collar025 = der(ref, hyp, { collar: 0.25 }).der
}
console.log(JSON.stringify(result))
