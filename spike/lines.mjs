// The approach proposed for Yogurt: one speaker embedding per transcript line, then
//   (a) live: online clustering, each line joins the closest voice or starts a new one;
//   (b) after the meeting: agglomerative re-cluster of all lines;
//   (c) naming: voices enrolled earlier (here: each person's first ~20 s) are matched to lines.
// Lines are stood in for by the reference RTTM turns (same-speaker turns joined across gaps < 0.5 s),
// which is roughly what whisper's segments look like. Overlapped speech is left in, as it would be.
//
//   node lines.mjs <wav> <embedding.onnx> <ref.rttm> [--online 0.5] [--offline 0.5] [--enrol 20] [--id 0.4] [--min-voice 15] [--threads 1]
import { createRequire } from 'node:module'
import { addTo, cos, norm, readRttm } from './lib.mjs'
const require = createRequire(import.meta.url)
const sherpa = require('sherpa-onnx-node')

const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? Number(args[i + 1]) : d }
const [wav, emb, rttm] = args
const ONLINE = opt('--online', 0.5), OFFLINE = opt('--offline', 0.5), ENROL_S = opt('--enrol', 20), ID = opt('--id', 0.4), MIN_VOICE_S = opt('--min-voice', 15)

// stand-in transcript lines. Default: each person's turns (oracle boundaries, flatters the method).
// --chunks: like Yogurt's chunker, all speech joined across pauses under 1 s (up to 30 s) whoever spoke,
// so a line can hold several voices; it is "right" only for the time its majority voice speaks.
const ref = readRttm(rttm).sort((a, b) => a.start - b.start)
const lines = []
if (args.includes('--chunks')) {
  for (const r of ref) {
    const last = lines.at(-1)
    if (last && r.start - last.end < 1 && Math.max(last.end, r.end) - last.start <= 30) last.end = Math.max(last.end, r.end)
    else lines.push({ start: r.start, end: r.end })
  }
  for (const l of lines) {
    l.talk = {}
    for (const r of ref) { const o = Math.min(r.end, l.end) - Math.max(r.start, l.start); if (o > 0) l.talk[r.spk] = (l.talk[r.spk] ?? 0) + o }
    l.spk = Object.entries(l.talk).sort((a, b) => b[1] - a[1])[0][0]
  }
} else {
  for (const r of ref) {
    const last = lines.findLast((l) => l.spk === r.spk)
    if (last && r.start - last.end < 0.5 && lines.at(-1) === last) last.end = Math.max(last.end, r.end)
    else lines.push({ ...r })
  }
  for (const l of lines) l.talk = { [l.spk]: l.end - l.start }
}
const usable = lines.filter((l) => l.end - l.start >= 0.5)

const ex = new sherpa.SpeakerEmbeddingExtractor({ model: emb, numThreads: opt('--threads', 1) })
const wave = sherpa.readWave(wav)
const sr = wave.sampleRate
let embedMs = 0, embedAudioS = 0
for (const l of usable) {
  const s = ex.createStream()
  // slice, not subarray: the addon reads the buffer from its start and ignores a view's offset
  const chunk = wave.samples.slice(Math.floor(l.start * sr), Math.floor(l.end * sr))
  const t0 = performance.now()
  s.acceptWaveform({ sampleRate: sr, samples: chunk })
  s.inputFinished()
  l.v = norm(ex.compute(s, false))
  embedMs += performance.now() - t0
  embedAudioS += l.end - l.start
}

const dur = (l) => l.end - l.start
/** share of the reference talk time whose line's voice maps (greedy, one-to-one) to the person actually talking */
function score(labels) {
  const pairs = new Map()
  usable.forEach((l, i) => { for (const [spk, t] of Object.entries(l.talk)) { const k = `${labels[i]}|${spk}`; pairs.set(k, (pairs.get(k) ?? 0) + t) } })
  const sorted = [...pairs].sort((a, b) => b[1] - a[1])
  const map = new Map(), used = new Set()
  for (const [k] of sorted) { const [c, s] = k.split('|'); if (!map.has(c) && !used.has(s)) { map.set(c, s); used.add(s) } }
  const total = usable.reduce((s, l) => s + Object.values(l.talk).reduce((a, b) => a + b, 0), 0)
  const ok = usable.reduce((s, l, i) => s + (l.talk[map.get(String(labels[i]))] ?? 0), 0)
  return { correctTimePct: +(100 * ok / total).toFixed(1), voices: new Set(labels).size }
}

// (a) online: closest centroid above ONLINE similarity, else a new voice
function online(th) {
  const cents = [], counts = [], labels = []
  for (const l of usable) {
    let best = -1, bi = -1
    cents.forEach((c, i) => { const s = cos(c, l.v); if (s > best) { best = s; bi = i } })
    if (bi >= 0 && best >= th) { cents[bi] = addTo(cents[bi], counts[bi]++, l.v); labels.push(bi) }
    else { cents.push(l.v); counts.push(1); labels.push(cents.length - 1) }
  }
  return labels
}

// (b) offline: average-linkage agglomerative clustering on cosine similarity, lines under 1 s join afterwards
function offline(th) {
  const long = usable.map((l, i) => i).filter((i) => dur(usable[i]) >= 1)
  let clusters = long.map((i) => [i])
  const S = usable.map((a) => usable.map((b) => cos(a.v, b.v)))
  const sim = (a, b) => { let s = 0; for (const i of a) for (const j of b) s += S[i][j]; return s / (a.length * b.length) }
  while (clusters.length > 1) {
    let best = -1, bi = 0, bj = 1
    for (let i = 0; i < clusters.length; i++) for (let j = i + 1; j < clusters.length; j++) { const s = sim(clusters[i], clusters[j]); if (s > best) { best = s; bi = i; bj = j } }
    if (best < th) break
    clusters[bi] = clusters[bi].concat(clusters[bj]); clusters.splice(bj, 1)
  }
  // a "voice" heard for under MIN_VOICE_S in all is almost always a split-off piece of a real one: fold it in
  const talk = (c) => c.reduce((s, i) => s + dur(usable[i]), 0)
  const big = clusters.filter((c) => talk(c) >= MIN_VOICE_S)
  if (big.length) {
    for (const c of clusters.filter((c) => talk(c) < MIN_VOICE_S)) for (const i of c) {
      let b = -2, bk = 0; big.forEach((g, k) => { const s = sim([i], g); if (s > b) { b = s; bk = k } }); big[bk].push(i)
    }
    clusters = big
  }
  const labels = new Array(usable.length).fill(-1)
  clusters.forEach((c, k) => c.forEach((i) => { labels[i] = k }))
  const cents = clusters.map((c) => norm(c.reduce((acc, i) => acc.map((x, d) => x + usable[i].v[d]), new Float32Array(usable[0].v.length))))
  usable.forEach((l, i) => { if (labels[i] < 0) { let b = -1, bk = 0; cents.forEach((c, k) => { const s = cos(c, l.v); if (s > b) { b = s; bk = k } }); labels[i] = bk } })
  return labels
}

// (c) enrolment: each person's first ENROL_S seconds of lines are their voice print; later lines are named
function enrolment(th) {
  const prints = new Map(), used = new Set()
  for (const spk of new Set(usable.map((l) => l.spk))) {
    let got = 0; const vs = []
    for (const [i, l] of usable.entries()) if (l.spk === spk && got < ENROL_S && dur(l) >= 1) { vs.push(l.v); got += dur(l); used.add(i) }
    prints.set(spk, norm(vs.reduce((a, v) => a.map((x, d) => x + v[d]), new Float32Array(vs[0].length))))
  }
  const buckets = { '<1s': [0, 0, 0], '1-2s': [0, 0, 0], '2-4s': [0, 0, 0], '4s+': [0, 0, 0] } // right, wrong, unknown
  usable.forEach((l, i) => {
    if (used.has(i)) return
    let best = -1, who = null
    for (const [spk, p] of prints) { const s = cos(p, l.v); if (s > best) { best = s; who = spk } }
    const b = dur(l) < 1 ? '<1s' : dur(l) < 2 ? '1-2s' : dur(l) < 4 ? '2-4s' : '4s+'
    buckets[b][best < th ? 2 : who === l.spk ? 0 : 1]++
  })
  return Object.fromEntries(Object.entries(buckets).map(([k, [r, w, u]]) => [k, { right: r, wrong: w, unknown: u }]))
}

const t0 = performance.now()
const res = {
  embedding: emb.split('/').pop(), dim: ex.dim, lines: usable.length, linesUnder1s: usable.filter((l) => dur(l) < 1).length,
  embedRtf: +(embedMs / 1000 / embedAudioS).toFixed(4), embedMsPerLine: +(embedMs / usable.length).toFixed(1),
  online: Object.fromEntries([ONLINE - 0.1, ONLINE, ONLINE + 0.1].map((t) => [t.toFixed(2), score(online(t))])),
  offline: Object.fromEntries([OFFLINE - 0.1, OFFLINE, OFFLINE + 0.1].map((t) => [t.toFixed(2), score(offline(t))])),
  enrolment: { enrolSeconds: ENROL_S, threshold: ID, byLineLength: enrolment(ID) },
}
res.clusterMs = Math.round(performance.now() - t0)
console.log(JSON.stringify(res, null, 1))
