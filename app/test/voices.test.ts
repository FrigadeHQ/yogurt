import { describe, expect, it } from 'vitest'
import { clusterVoices, kmeans } from '../src/main/voices/cluster'
import { nameVoices, voiceOfLines, type NamedLine } from '../src/main/voices/assign'
import { voiceTurns, RATE, type Engine } from '../src/main/voices/run'
import type { VoiceTurn } from '../src/main/voices/run'

/** a seeded stand-in for a voice: embeddings scattered around a direction of its own */
function voices(sizes: number[], spread = 0.35, dim = 64, seed = 7) {
  let s = seed
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 - 0.5 }
  const centres = sizes.map(() => Array.from({ length: dim }, rnd))
  const emb: number[][] = [], truth: number[] = []
  sizes.forEach((n, v) => { for (let i = 0; i < n; i++) { emb.push(centres[v].map(c => c + rnd() * spread)); truth.push(v) } })
  return { emb, truth }
}
/** the same grouping, whatever numbers the groups got */
const sameGroups = (a: number[], b: number[]) => a.every((x, i) => a.every((y, j) => (x === y) === (b[i] === b[j])))

describe('clusterVoices', () => {
  it('finds how many voices there are without being told, and who is who', () => {
    for (const sizes of [[80, 60], [90, 70, 50], [60, 60, 50, 40, 30]]) {
      const { emb, truth } = voices(sizes)
      const r = clusterVoices(emb)
      expect(r.count).toBe(sizes.length)
      expect(sameGroups(r.labels, truth)).toBe(true)
    }
  })
  it('keeps one voice one speaker: the eigengap always offers two, alike groups are merged', () => {
    const { emb } = voices([150])
    expect(clusterVoices(emb).count).toBe(1)
  })
  it('numbers the voices by how much they are heard, the most first', () => {
    const { emb, truth } = voices([30, 120, 60])
    const r = clusterVoices(emb)
    expect(r.labels[truth.indexOf(1)]).toBe(0)
    expect(r.labels[truth.indexOf(2)]).toBe(1)
    expect(r.labels[truth.indexOf(0)]).toBe(2)
  })
  it('builds the groups from the anchors and puts everything else with the nearest', () => {
    const { emb, truth } = voices([70, 70])
    const anchors = emb.map((_, i) => i).filter(i => i % 3 !== 0)
    expect(sameGroups(clusterVoices(emb, anchors).labels, truth)).toBe(true)
  })
  it('comes out the same each time', () => {
    const { emb } = voices([50, 40, 30])
    expect(clusterVoices(emb)).toEqual(clusterVoices(emb))
  })
  it('handles nothing and almost nothing', () => {
    expect(clusterVoices([])).toEqual({ count: 0, labels: [] })
    expect(clusterVoices([[1, 0], [0.9, 0.1]]).count).toBe(1)
  })
})

describe('kmeans', () => {
  it('splits plainly separate points', () => {
    const labels = kmeans([[0, 0], [0, 1], [10, 10], [10, 11]], 2)
    expect(labels[0]).toBe(labels[1]); expect(labels[2]).toBe(labels[3]); expect(labels[0]).not.toBe(labels[2])
  })
})

const line = (id: number, startMs: number, endMs: number, speaker: string | null = null): NamedLine => ({ id, startMs, endMs, speaker })
const turn = (startMs: number, endMs: number, voice: number): VoiceTurn => ({ startMs, endMs, voice })

describe('voiceOfLines', () => {
  it('gives each line the voice heard most over it, and none where no turn covers it', () => {
    const v = voiceOfLines([line(1, 0, 1000), line(2, 1000, 3000), line(3, 9000, 9500)], [turn(0, 1200, 0), turn(1200, 3000, 1)])
    expect([...v]).toEqual([[1, 0], [2, 1], [3, null]])
  })
})

describe('nameVoices', () => {
  const turns = [turn(0, 10_000, 0), turn(10_000, 20_000, 1), turn(20_000, 30_000, 0), turn(30_000, 40_000, 2)]
  const lines = [line(1, 0, 4000), line(2, 5000, 9000), line(3, 11_000, 19_000), line(4, 21_000, 29_000), line(5, 31_000, 39_000)]

  it('labels the voices Speaker 1, 2, 3, the one heard most first', () => {
    expect(nameVoices(lines, turns, 3)).toEqual([
      { id: 1, speaker: 'Speaker 1' }, { id: 2, speaker: 'Speaker 1' }, { id: 3, speaker: 'Speaker 2' },
      { id: 4, speaker: 'Speaker 1' }, { id: 5, speaker: 'Speaker 3' },
    ])
  })
  it('never changes a line that has a name: the call app\'s, an earlier label, or the person\'s own', () => {
    const named = nameVoices([{ ...lines[0], speaker: 'Ahmed' }, ...lines.slice(1)], turns, 3)
    expect(named.find(n => n.id === 1)).toBeUndefined()
  })
  it('carries a name over to the rest of its voice when most of that voice\'s named lines have it', () => {
    const t = [turn(0, 100_000, 0), turn(100_000, 200_000, 1)]
    const ls = [...[0, 1, 2].map(i => line(i, i * 10_000, i * 10_000 + 5000, 'Sara')), line(9, 50_000, 55_000), line(10, 150_000, 155_000)]
    expect(nameVoices(ls, t, 2)).toEqual([{ id: 9, speaker: 'Sara' }, { id: 10, speaker: 'Speaker 1' }])
  })
  it('numbers new voices after the labels already used (a resumed meeting)', () => {
    const named = nameVoices([{ ...lines[2], speaker: 'Speaker 4' }, lines[4]], turns, 3)
    expect(named).toEqual([{ id: 5, speaker: 'Speaker 5' }])
  })
  it('leaves a lone voice with nothing named as Them', () => {
    expect(nameVoices([line(1, 0, 4000), line(2, 5000, 9000)], [turn(0, 10_000, 0)], 1)).toEqual([])
  })
})

describe('voiceTurns', () => {
  it('reads the audio in pieces, embeds each line in windows, and gives each line a voice', async () => {
    // two "voices": a line a second; the embedding says which half of the minute the window is in
    const engine: Engine = { embed: samples => Float32Array.from(samples[0] > 0 ? [1, 0.02, 0] : [0, 0.02, 1]) }
    const spans = Array.from({ length: 60 }, (_, i) => ({ startMs: i * 1000, endMs: i * 1000 + 900 }))
    async function* audio() {
      const a = new Float32Array(30 * RATE).fill(0.5), b = new Float32Array(30 * RATE).fill(-0.5)
      yield a.subarray(0, 7 * RATE); yield a.subarray(7 * RATE); yield b
    }
    const r = await voiceTurns(audio(), spans, engine)
    expect(r.voices).toBe(2)
    expect(r.turns).toHaveLength(60)
    expect(new Set(r.turns.slice(0, 30).map(t => t.voice)).size).toBe(1)
    expect(r.turns[0].voice).not.toBe(r.turns[59].voice)
  })
  it('gives no voice to a line too short to hear one in', async () => {
    const engine: Engine = { embed: () => Float32Array.from([1, 0, 0]) }
    async function* audio() { yield new Float32Array(5 * RATE).fill(0.1) }
    const r = await voiceTurns(audio(), [{ startMs: 0, endMs: 300 }], engine)
    expect(r).toEqual({ turns: [], voices: 0 })
  })
})
