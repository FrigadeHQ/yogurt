// Sanity check: same-speaker vs other-speaker cosine for long lines, and a line split in two halves.
import { createRequire } from 'node:module'
import { cos, norm, readRttm } from './lib.mjs'
const sherpa = createRequire(import.meta.url)('sherpa-onnx-node')
const [wav, emb, rttm] = process.argv.slice(2)
const ex = new sherpa.SpeakerEmbeddingExtractor({ model: emb, numThreads: 1 })
const w = sherpa.readWave(wav), sr = w.sampleRate
const e = (a, b) => { const s = ex.createStream(); s.acceptWaveform({ sampleRate: sr, samples: w.samples.slice(Math.floor(a * sr), Math.floor(b * sr)) }); s.inputFinished(); return norm(ex.compute(s, false)) }
const ref = readRttm(rttm).filter((r) => r.end - r.start >= 4)
// skip lines that overlap any other speaker
const all = readRttm(rttm)
const clean = ref.filter((r) => !all.some((o) => o.spk !== r.spk && o.start < r.end && o.end > r.start))
const vs = clean.map((r) => ({ ...r, v: e(r.start, r.end) }))
let same = [], diff = []
for (let i = 0; i < vs.length; i++) for (let j = i + 1; j < vs.length; j++) (vs[i].spk === vs[j].spk ? same : diff).push(cos(vs[i].v, vs[j].v))
const st = (a) => ({ n: a.length, mean: +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(3), min: +Math.min(...a).toFixed(3), max: +Math.max(...a).toFixed(3) })
const r0 = clean[0]; const mid = (r0.start + r0.end) / 2
console.log(JSON.stringify({ model: emb.split('/').pop(), cleanLongLines: vs.length, perSpeaker: Object.fromEntries([...new Set(vs.map((v) => v.spk))].map((s) => [s, vs.filter((v) => v.spk === s).length])), same: st(same), different: st(diff), halves: +cos(e(r0.start, mid), e(mid, r0.end)).toFixed(3), sameTwice: +cos(e(r0.start, r0.end), e(r0.start, r0.end)).toFixed(3) }))
