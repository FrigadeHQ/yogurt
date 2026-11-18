// Hybrid: pyannote segmentation-3.0 (via sherpa's pipeline, run over-split) only for where voices change,
// then one embedding per turn and our own clustering with small voices folded in. Scored as frame DER.
//
//   node hybrid.mjs <wav> <turn-embedding.onnx> <ref.rttm> [--offline 0.4] [--min-voice 15] [--seconds S]
import { createRequire } from 'node:module'
import { cos, der, norm, readRttm } from './lib.mjs'
const sherpa = createRequire(import.meta.url)('sherpa-onnx-node')

const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? Number(args[i + 1]) : d }
const [wav, emb, rttm] = args
const OFFLINE = opt('--offline', 0.4), MIN_VOICE_S = opt('--min-voice', 15)
const models = new URL('./models/', import.meta.url).pathname

const wave = sherpa.readWave(wav), sr = wave.sampleRate
const seconds = opt('--seconds', 0)
const samples = seconds ? wave.samples.slice(0, seconds * sr) : wave.samples
const audioS = samples.length / sr

// 1. turns: segmentation + the small TitaNet embedding with a low threshold, so it over-splits rather than merges
let t0 = performance.now()
const sd = new sherpa.OfflineSpeakerDiarization({
  segmentation: { pyannote: { model: models + 'sherpa-onnx-pyannote-segmentation-3-0/model.onnx' }, numThreads: 1 },
  embedding: { model: models + 'nemo_en_titanet_small.onnx', numThreads: 1 },
  clustering: { numClusters: -1, threshold: 0.5 }, minDurationOn: 0.2, minDurationOff: 0.5,
})
const turns = sd.process(samples).map((s) => ({ start: s.start, end: s.end })).filter((t) => t.end - t.start >= 0.3)
const segS = (performance.now() - t0) / 1000

// 2. one embedding per turn
t0 = performance.now()
const ex = new sherpa.SpeakerEmbeddingExtractor({ model: emb, numThreads: 1 })
for (const t of turns) {
  const s = ex.createStream()
  s.acceptWaveform({ sampleRate: sr, samples: samples.slice(Math.floor(t.start * sr), Math.floor(t.end * sr)) })
  s.inputFinished()
  t.v = norm(ex.compute(s, false))
}
const embS = (performance.now() - t0) / 1000

// 3. average-linkage clustering on turns of 1 s or more, small voices folded in, short turns join the nearest
t0 = performance.now()
const dur = (t) => t.end - t.start
const S = turns.map((a) => turns.map((b) => cos(a.v, b.v)))
const sim = (a, b) => { let s = 0; for (const i of a) for (const j of b) s += S[i][j]; return s / (a.length * b.length) }
let clusters = turns.map((t, i) => i).filter((i) => dur(turns[i]) >= 1).map((i) => [i])
while (clusters.length > 1) {
  let best = -1, bi = 0, bj = 1
  for (let i = 0; i < clusters.length; i++) for (let j = i + 1; j < clusters.length; j++) { const s = sim(clusters[i], clusters[j]); if (s > best) { best = s; bi = i; bj = j } }
  if (best < OFFLINE) break
  clusters[bi] = clusters[bi].concat(clusters[bj]); clusters.splice(bj, 1)
}
const talk = (c) => c.reduce((s, i) => s + dur(turns[i]), 0)
const big = clusters.filter((c) => talk(c) >= MIN_VOICE_S)
const keep = big.length ? big : clusters
const label = new Array(turns.length).fill(-1)
keep.forEach((c, k) => c.forEach((i) => { label[i] = k }))
turns.forEach((t, i) => { if (label[i] < 0) { let b = -2, bk = 0; keep.forEach((c, k) => { const s = sim([i], c); if (s > b) { b = s; bk = k } }); label[i] = bk } })
const clusS = (performance.now() - t0) / 1000

const ref = readRttm(rttm).filter((r) => r.start < audioS).map((r) => ({ ...r, end: Math.min(r.end, audioS) }))
const hyp = turns.map((t, i) => ({ start: t.start, end: t.end, spk: `v${label[i]}` }))
console.log(JSON.stringify({
  file: wav.split('/').pop(), embedding: emb.split('/').pop(), turns: turns.length, voices: keep.length, audioSeconds: +audioS.toFixed(1),
  seconds: { segmentation: +segS.toFixed(1), embeddings: +embS.toFixed(1), clustering: +clusS.toFixed(1) },
  rtf: +((segS + embS + clusS) / audioS).toFixed(4), der: der(ref, hyp), derCollar025: der(ref, hyp, { collar: 0.25 }).der,
}))
