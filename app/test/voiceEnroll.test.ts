import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openStore, type Store } from '../src/main/store'
import { enrollNamed, enrollRanges } from '../src/main/diarize/enroll'

const dirs: string[] = []
const stores: Store[] = []
afterEach(() => { stores.splice(0).forEach((s) => s.close()); dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })) })
const fresh = () => { const d = mkdtempSync(join(tmpdir(), 'yogurt-enroll-')); dirs.push(d); const s = openStore(join(d, 'yogurt.db')); stores.push(s); return s }

const vec = (x: number, y: number, z: number) => new Float32Array([x, y, z])
const profile = (s: Store, id: string, name: string, v: Float32Array, meetings = 0) => {
  s.createVoiceProfile({ id, name, model: 'campplus', dims: v.length, centroid: Buffer.from(v.buffer) })
  if (meetings) s.bumpVoiceProfile(id)
}
const enrolled = (s: Store, name: string, v: Float32Array, linkedProfileId?: string | null) =>
  enrollNamed(s, { meetingId: 'm1', key: 'v1', name, vec: v, linkedProfileId })

describe('enrollRanges', () => {
  it('keeps ranges the model can embed and drops fragments below 800 ms', () => {
    const ranges = enrollRanges([
      { startMs: 0, endMs: 400 },
      { startMs: 1000, endMs: 2500 },
      { startMs: 3000, endMs: 3800 },
    ])
    expect(ranges).toEqual([{ startMs: 1000, endMs: 2500 }, { startMs: 3000, endMs: 3800 }])
  })
  it('needs two seconds of speech in all', () => {
    expect(enrollRanges([{ startMs: 0, endMs: 900 }])).toEqual([])
  })
  it('takes the speech in order', () => {
    expect(enrollRanges([{ startMs: 3000, endMs: 5000 }, { startMs: 0, endMs: 2000 }]).map(r => r.startMs)).toEqual([0, 3000])
  })
})

describe('enrollNamed', () => {
  it('remembers a new name as a profile heard in this meeting', () => {
    const s = fresh()
    const out = enrolled(s, 'Ann Lee', vec(1, 0, 0))
    expect(out.profileId).toBeTruthy()
    expect(s.voiceProfiles()).toEqual([expect.objectContaining({ name: 'Ann Lee', meetings: 1 })])
  })

  it('never remembers a voice still called Speaker N', () => {
    const s = fresh()
    expect(enrolled(s, 'Speaker 3', vec(1, 0, 0))).toEqual({ profileId: null, score: null })
    expect(s.voiceProfiles()).toEqual([])
  })

  it('links the same voice on a sure match and counts the meeting once', () => {
    const s = fresh()
    profile(s, 'p1', 'Ann Lee', vec(1, 0, 0))
    const first = enrolled(s, 'Ann Lee', vec(1, 0, 0))
    expect(first.profileId).toBe('p1')
    expect(s.voiceProfiles()[0].meetings).toBe(1)
    // renamed again: the meeting is already counted, the voiceprint may still drift
    expect(enrolled(s, 'Ann Lee', vec(1, 0, 0), 'p1').profileId).toBe('p1')
    expect(s.voiceProfiles()[0].meetings).toBe(1)
  })

  it('never puts a name on a voiceprint that already has a different one', () => {
    const s = fresh()
    profile(s, 'p1', 'Ann Lee', vec(1, 0, 0))
    const out = enrolled(s, 'Bob', vec(1, 0, 0))
    expect(out.profileId).toBeNull()
    expect(out.score).toBeCloseTo(1)
    expect(s.voiceProfiles().map(p => p.name)).toEqual(['Ann Lee'])
  })

  it('does not reuse a name another voice already has', () => {
    const s = fresh()
    profile(s, 'p1', 'Bob', vec(0, 1, 0))
    expect(enrolled(s, 'Bob', vec(1, 0, 0))).toEqual({ profileId: null, score: null })
    expect(s.voiceProfiles()).toHaveLength(1)
  })

  it('a sure match under another name is left alone', () => {
    const s = fresh()
    profile(s, 'p1', 'Ann Lee', vec(1, 0, 0))
    // 0.95 cosine: a sure match, but under Bob the voiceprint is left alone
    expect(enrolled(s, 'Bob', vec(0.95, 0.312, 0)).profileId).toBeNull()
    expect(s.voiceProfiles()[0].meetings).toBe(0)
  })
})
