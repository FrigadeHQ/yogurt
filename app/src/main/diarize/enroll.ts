import { randomUUID } from 'node:crypto'
import type { Store } from '../store'
import { bestMatch, blend, normalize, type ProfileVec } from './match'

/** a voice still called Speaker N is not a person's name: never remembered */
export const SPEAKER_N = /^Speaker \d+$/

/** the speaker model needs this much clean speech in one range */
export const ENROLL_MIN_RANGE_MS = 800
/** and this much in all, or the vector is not trustworthy */
export const ENROLL_MIN_TOTAL_MS = 2000
const MAX_RANGES = 24
const MAX_TOTAL_MS = 120_000

type VoiceStore = Pick<Store, 'voiceCentroids' | 'voiceProfiles' | 'createVoiceProfile' | 'updateVoiceCentroid' | 'bumpVoiceProfile'>
export type Range = { startMs: number; endMs: number }
export type Enrolled = { profileId: string | null; score: number | null }

const bufferOf = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength)

/**
 * The speech of one voice in a meeting, as ranges the speaker model can embed: short fragments are dropped
 * (the model refuses them), and the total is capped so a long meeting does not turn one rename into a minute
 * of inference.
 */
export function enrollRanges(lines: Range[]): Range[] {
  const out: Range[] = []
  let total = 0
  for (const l of [...lines].sort((a, b) => a.startMs - b.startMs)) {
    const ms = l.endMs - l.startMs
    if (ms < ENROLL_MIN_RANGE_MS) continue
    if (out.length >= MAX_RANGES || total >= MAX_TOTAL_MS) break
    out.push({ startMs: l.startMs, endMs: l.endMs })
    total += ms
  }
  return total >= ENROLL_MIN_TOTAL_MS ? out : []
}

/**
 * Remember a voice the person named by hand, with the same rules diarization uses: a profile whose name
 * differs is never touched, a name another profile already has is never reused, and the meeting counts once
 * even when the voice is renamed again.
 */
export function enrollNamed(store: VoiceStore, p: { meetingId: string; key: string; name: string; vec: Float32Array; linkedProfileId?: string | null }): Enrolled {
  const name = p.name.replace(/\s+/g, ' ').trim()
  if (!name || SPEAKER_N.test(name)) return { profileId: null, score: null }
  const vec = normalize(p.vec)
  if (!vec.length) return { profileId: null, score: null }
  const dims = vec.length
  const profiles: ProfileVec[] = store.voiceCentroids()
    .filter(pr => pr.dims === dims)
    .map(pr => ({ id: pr.id, name: pr.name, centroid: normalize(pr.centroid), meetings: pr.meetings }))
  const match = bestMatch(vec, profiles)
  if (match?.id) {
    const profile = profiles.find(pr => pr.id === match.id)!
    // a different name on the same voiceprint: the person may have named the wrong voice, so leave it alone
    if (profile.name !== name) return { profileId: null, score: match.score }
    store.updateVoiceCentroid(profile.id, bufferOf(blend(profile.centroid, vec)))
    if (p.linkedProfileId !== profile.id) store.bumpVoiceProfile(profile.id)
    return { profileId: profile.id, score: match.score }
  }
  // no sure match: a new voiceprint, unless the name already belongs to another voice
  if (store.voiceProfiles().some(pr => pr.name === name)) return { profileId: null, score: null }
  const profileId = `vp_${randomUUID()}`
  store.createVoiceProfile({ id: profileId, name, model: 'campplus', dims, centroid: bufferOf(vec) })
  store.bumpVoiceProfile(profileId)
  return { profileId, score: null }
}
