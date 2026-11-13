import { describe, expect, it } from 'vitest'
import { AMBIGUOUS_MIN, AUTO_NAME_MIN, BEST_MARGIN, bestMatch, blend, cosine, normalize, type ProfileVec } from '../src/main/diarize/match'

const unit = (dims: number, at: number): Float32Array => { const v = new Float32Array(dims); v[at] = 1; return v }
const profile = (id: string, v: Float32Array): ProfileVec => ({ id, name: id, centroid: v, meetings: 1 })

describe('vector math', () => {
  it('normalizes to unit length', () => {
    const v = normalize(new Float32Array([3, 4]))
    expect(Math.hypot(...v)).toBeCloseTo(1)
  })
  it('cosine of normalized vectors is their dot', () => {
    expect(cosine(unit(4, 0), unit(4, 0))).toBeCloseTo(1)
    expect(cosine(unit(4, 0), unit(4, 1))).toBeCloseTo(0)
  })
  it('blend is 0.7 old + 0.3 fresh, renormalized', () => {
    const old = new Float32Array([1, 0]), fresh = new Float32Array([0, 1])
    const out = blend(old, fresh)
    expect(out[0] / out[1]).toBeCloseTo(7 / 3)
    expect(Math.hypot(...out)).toBeCloseTo(1)
  })
})

describe('bestMatch', () => {
  // sim is the resulting cosine: mix the target with an orthogonal decoy weighted sqrt(1-sim^2)
  const near = (target: Float32Array, sim: number, dims = 4): Float32Array => {
    const decoy = unit(dims, dims - 1)
    const mixed = new Float32Array(dims)
    const w = Math.sqrt(1 - sim * sim)
    for (let i = 0; i < dims; i++) mixed[i] = sim * target[i] + w * decoy[i]
    return normalize(mixed)
  }
  it(`auto-names at cosine >= ${AUTO_NAME_MIN} with a clear margin`, () => {
    const p = unit(4, 0)
    const m = bestMatch(near(p, 0.95), [profile('p1', p)])
    expect(m).toEqual({ id: 'p1', score: expect.any(Number) })
    expect(m && m.score).toBeGreaterThan(AUTO_NAME_MIN)
  })
  it('no match below the floor', () => {
    const p = unit(4, 0)
    expect(bestMatch(near(p, 0.2), [profile('p1', p)])).toBeNull()
    expect(bestMatch(unit(4, 0), [])).toBeNull()
  })
  it(`the ambiguous band (${AMBIGUOUS_MIN}–${AUTO_NAME_MIN}) matches nothing`, () => {
    const p = unit(4, 0)
    const m = bestMatch(near(p, 0.62), [profile('p1', p)])
    expect(m).toEqual({ id: null, score: expect.any(Number) })
    expect(m && m.score).toBeGreaterThanOrEqual(AMBIGUOUS_MIN)
    expect(m && m.score).toBeLessThan(AUTO_NAME_MIN)
  })
  it(`two profiles too close (margin < ${BEST_MARGIN}) match nothing`, () => {
    const a = unit(4, 0), b = normalize(near(a, 0.97))
    const m = bestMatch(a, [profile('p1', a), profile('p2', b)])
    expect(m).toEqual({ id: null, score: expect.any(Number) })
  })
  it('picks the better of two well-separated profiles', () => {
    const a = unit(4, 0), b = unit(4, 2)
    expect(bestMatch(a, [profile('p2', b), profile('p1', a)])).toMatchObject({ id: 'p1' })
  })
})
