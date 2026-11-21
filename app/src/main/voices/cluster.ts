import { EigenvalueDecomposition, Matrix } from 'ml-matrix'

/**
 * Groups voice embeddings into speakers without being told how many there are.
 *
 * Spectral clustering on a pruned cosine-affinity graph, the count from the largest eigengap of its Laplacian, tried
 * at several pruning levels and the best-separated kept (NME-SC, Park et al. 2019). Measured on a 57-minute Teams call
 * with six remote speakers: six found, and 1 of 396 sentences that run on across lines split between two of them
 * (a fixed distance threshold found 9 to 128 "speakers" on the same call).
 *
 * Then groups whose average voices are this alike are one person: on that call two different people never came out
 * above 0.50, while two halves of one person's speech never came out below 0.84. This keeps a lone remote person one
 * speaker (the eigengap always offers at least two).
 */
export const SAME_PERSON = 0.7
const PRUNING = [0.02, 0.04, 0.06, 0.08, 0.1, 0.15, 0.2]
const K_MAX = 10
/** past this many windows the graph is built on an even sample (the eigensolver grows with the cube); the rest join by nearest centre */
export const MAX_POINTS = 800
const KMEANS_STARTS = 10

type Vec = Float32Array | number[]

const unit = (v: number[]): number[] => { const n = Math.hypot(...v) || 1; return v.map(x => x / n) }
const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s }
const mean = (rows: ArrayLike<number>[], dim: number) => { const m = new Array<number>(dim).fill(0); for (const r of rows) for (let i = 0; i < dim; i++) m[i] += r[i] / rows.length; return m }

/** A small seeded generator, so the same meeting always comes out the same */
function random(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 } }

/** k-means with k-means++ starts, the best of several: the labels */
export function kmeans(points: number[][], k: number, starts = KMEANS_STARTS, seed = 1): number[] {
  const n = points.length, rnd = random(seed)
  if (k >= n) return points.map((_, i) => i)
  const dist = (a: number[], b: number[]) => { let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2; return s }
  let best: { labels: number[]; cost: number } | null = null
  for (let start = 0; start < starts; start++) {
    const centres = [points[Math.floor(rnd() * n)]]
    while (centres.length < k) {
      const d = points.map(p => Math.min(...centres.map(c => dist(p, c))))
      let r = rnd() * d.reduce((a, b) => a + b, 0), i = 0
      while (i < n - 1 && (r -= d[i]) > 0) i++
      centres.push(points[i])
    }
    let labels = new Array<number>(n).fill(-1)
    for (let iter = 0; iter < 100; iter++) {
      const next = points.map(p => { let b = 0, bd = Infinity; centres.forEach((c, j) => { const x = dist(p, c); if (x < bd) { bd = x; b = j } }); return b })
      const moved = next.some((l, i) => l !== labels[i])
      labels = next
      for (let j = 0; j < k; j++) { const mine = points.filter((_, i) => labels[i] === j); if (mine.length) centres[j] = mean(mine, points[0].length) }
      if (!moved) break
    }
    const cost = points.reduce((s, p, i) => s + dist(p, centres[labels[i]]), 0)
    if (!best || cost < best.cost) best = { labels, cost }
  }
  return best!.labels
}

/** One pruning level: the count from the eigengap, how well it separates (smaller is better), and the labels */
function spectral(affinity: number[][], p: number): { k: number; ratio: number; labels: number[] } {
  const n = affinity.length, keep = Math.max(2, Math.floor(p * n))
  // each row keeps only its strongest links, then made symmetric
  const pruned = affinity.map(row => {
    const cut = [...row].sort((a, b) => b - a)[Math.min(keep, n) - 1]
    return row.map(v => (v >= cut ? v : 0))
  })
  const sym = pruned.map((row, i) => row.map((v, j) => (v + pruned[j][i]) / 2))
  const d = sym.map(row => 1 / Math.sqrt(row.reduce((a, b) => a + b, 0) + 1e-9))
  const lap = new Matrix(sym.map((row, i) => row.map((v, j) => (i === j ? 1 : 0) - d[i] * v * d[j])))
  const eig = new EigenvalueDecomposition(lap, { assumeSymmetric: true })
  const order = eig.realEigenvalues.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0])
  const vals = order.map(([v]) => v)
  const kmax = Math.min(K_MAX, n - 1)
  const gaps = vals.slice(1, kmax + 1).map((v, i) => v - vals[i])
  // at least two: the gap after the first eigenvalue only says the graph is connected
  let k = 2
  for (let i = 2; i <= kmax; i++) if (gaps[i - 1] > gaps[k - 1]) k = i
  const ratio = p / (gaps[k - 1] + 1e-9)
  const vecs = eig.eigenvectorMatrix
  const rows = Array.from({ length: n }, (_, r) => unit(order.slice(0, k).map(([, c]) => vecs.get(r, c))))
  return { k, ratio, labels: kmeans(rows, k) }
}

/**
 * Speaker labels (0 = the one heard most) for each embedding, and how many speakers.
 * `anchors`: the embeddings to build the groups from (windows of longer turns, which carry a clearer voice); the
 * others take the nearest group. All of them when left out.
 */
export function clusterVoices(embeddings: Vec[], anchors?: number[]): { count: number; labels: number[] } {
  const n = embeddings.length
  if (n === 0) return { count: 0, labels: [] }
  const dim = embeddings[0].length
  const raw = embeddings.map(e => unit(Array.from(e)))
  // centred: what every window shares (the call's codec, the room) is taken off, leaving the voice
  const centre = mean(raw, dim)
  const x = raw.map(v => unit(v.map((c, i) => c - centre[i])))
  let use = anchors && anchors.length >= 10 ? anchors : raw.map((_, i) => i)
  if (use.length > MAX_POINTS) { const step = use.length / MAX_POINTS; use = Array.from({ length: MAX_POINTS }, (_, i) => use[Math.floor(i * step)]) }
  if (use.length < 4) return { count: 1, labels: new Array(n).fill(0) }

  const pts = use.map(i => x[i])
  const affinity = pts.map(a => pts.map(b => Math.max(0, dot(a, b))))
  const best = PRUNING.map(p => spectral(affinity, p)).reduce((a, b) => (b.ratio < a.ratio ? b : a))

  // every embedding joins the nearest group centre
  const centres = (labels: number[], k: number) => Array.from({ length: k }, (_, c) => unit(mean(use.filter((_, j) => labels[j] === c).map(i => x[i]), dim)))
  const cs = centres(best.labels, best.k)
  let labels = x.map(v => { let b = 0; cs.forEach((c, j) => { if (dot(v, c) > dot(v, cs[b])) b = j }); return b })

  // groups that are the same voice become one (raw embeddings: centring would make a lone voice look like noise)
  const groups = [...new Set(labels)]
  const rawCentre = (g: number) => unit(mean(raw.filter((_, i) => labels[i] === g), dim))
  const parent = new Map(groups.map(g => [g, g]))
  const root = (g: number): number => (parent.get(g) === g ? g : root(parent.get(g)!))
  for (let a = 0; a < groups.length; a++) for (let b = a + 1; b < groups.length; b++) {
    if (dot(rawCentre(groups[a]), rawCentre(groups[b])) > SAME_PERSON) parent.set(root(groups[b]), root(groups[a]))
  }
  labels = labels.map(root)

  // 0 for the one heard most, then 1, 2...
  const size = new Map<number, number>()
  for (const l of labels) size.set(l, (size.get(l) ?? 0) + 1)
  const rank = new Map([...size].sort((a, b) => b[1] - a[1]).map(([g], i) => [g, i]))
  return { count: rank.size, labels: labels.map(l => rank.get(l)!) }
}
