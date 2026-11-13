import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type Store } from '../src/main/store'

const dirs: string[] = []
const stores: Store[] = []
function fresh(): Store {
  const d = mkdtempSync(join(tmpdir(), 'yogurt-diarize-store-'))
  dirs.push(d)
  const s = openStore(join(d, 'yogurt.db'))
  stores.push(s)
  return s
}
afterEach(() => {
  stores.splice(0).forEach((s) => s.close())
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})
const base = { title: 'Sync', endedAt: null, eventId: null, app: null, attendees: [], state: 'recording' as const }
const words = (t: string, from: number, to: number) => {
  const parts = t.split(' ')
  return parts.map((w, i) => ({ text: w, startMs: from + Math.round((to - from) * i / parts.length), endMs: from + Math.round((to - from) * (i + 1) / parts.length) }))
}

describe('diarization store', () => {
  it('persists speaker_key and words on segments, and maps them back', () => {
    const s = fresh()
    const m = s.createMeeting({ ...base, startedAt: 1 })
    s.addSegments([{ meetingId: m.id, track: 'them', startMs: 100, endMs: 900, text: 'hello there', speaker: null, speakerKey: 'v1', words: words('hello there', 100, 900) }])
    const seg = s.segments(m.id)[0]
    expect(seg.speakerKey).toBe('v1')
    expect(seg.words?.map(w => w.text)).toEqual(['hello', 'there'])
  })

  it('applyDiarization deletes, splits and writes clusters in one transaction', () => {
    const s = fresh()
    const m = s.createMeeting({ ...base, startedAt: 1 })
    s.addSegments([{ meetingId: m.id, track: 'them', startMs: 0, endMs: 2000, text: 'one two', speaker: 'Ann' }])
    const old = s.segments(m.id)[0]
    s.applyDiarization(m.id, {
      deleteIds: [old.id],
      insert: [
        { meetingId: m.id, track: 'them', startMs: 0, endMs: 900, text: 'one', speaker: 'Ann', speakerKey: 'v1', words: words('one', 0, 900) },
        { meetingId: m.id, track: 'them', startMs: 1000, endMs: 2000, text: 'two', speaker: null, speakerKey: 'v2', words: words('two', 1000, 2000) },
      ],
      speakers: [
        { key: 'v1', speaker: 'Ann', startMs: 0, endMs: 900 },
        { key: 'v2', speaker: 'Speaker 1', startMs: 1000, endMs: 2000 },
      ],
    })
    expect(s.segments(m.id).map(x => [x.text, x.speakerKey])).toEqual([['one', 'v1'], ['two', 'v2']])
    expect(s.meetingSpeakers(m.id).map(x => [x.key, x.profileId])).toEqual([['v1', null], ['v2', null]])
    expect(s.meetingSpeakers(m.id).map(x => x.startMs)).toEqual([0, 1000])
  })

  it('renameSpeaker renames every row of the voice in place, keeping colour order', () => {
    const s = fresh()
    const m = s.createMeeting({ ...base, startedAt: 1 })
    s.addSegments([
      { meetingId: m.id, track: 'them', startMs: 0, endMs: 900, text: 'a', speaker: 'Speaker 1', speakerKey: 'v1' },
      { meetingId: m.id, track: 'them', startMs: 1000, endMs: 1900, text: 'b', speaker: 'Speaker 2', speakerKey: 'v2' },
    ])
    s.speakerOrder(m.id)
    expect(s.renameSpeaker(m.id, 'v1', '  Ada   Chen ')).toBe(true)
    expect(s.segments(m.id).map(x => x.speaker)).toEqual(['Ada Chen', 'Speaker 2'])
    expect(JSON.parse(String(s.db.prepare('SELECT speaker_order FROM meetings WHERE id = ?').get(m.id)!.speaker_order))).toEqual(['Ada Chen', 'Speaker 2'])
    // unknown key: no
    expect(s.renameSpeaker(m.id, 'vX', 'Zoe')).toBe(false)
  })

  it('renameSpeaker refuses a name another live voice already has (routes to merge)', () => {
    const s = fresh()
    const m = s.createMeeting({ ...base, startedAt: 1 })
    s.addSegments([
      { meetingId: m.id, track: 'them', startMs: 0, endMs: 900, text: 'a', speaker: 'Ada', speakerKey: 'v1' },
      { meetingId: m.id, track: 'them', startMs: 1000, endMs: 1900, text: 'b', speaker: 'Speaker 1', speakerKey: 'v2' },
    ])
    expect(s.renameSpeaker(m.id, 'v2', 'Ada')).toBe(false)
    expect(s.renameSpeaker(m.id, 'v2', 'Ada ')).toBe(false)
  })

  it('renameSpeaker can name a voice that was Them, appending to the colour order', () => {
    const s = fresh()
    const m = s.createMeeting({ ...base, startedAt: 1 })
    s.addSegments([{ meetingId: m.id, track: 'them', startMs: 0, endMs: 900, text: 'a', speaker: null, speakerKey: 'v1' }])
    expect(s.renameSpeaker(m.id, 'v1', 'Bo')).toBe(true)
    expect(s.segments(m.id)[0].speaker).toBe('Bo')
    expect(JSON.parse(String(s.db.prepare('SELECT speaker_order FROM meetings WHERE id = ?').get(m.id)!.speaker_order))).toEqual(['Bo'])
  })

  it('mergeSpeakers moves rows and cluster metadata to the target and keeps the source colour slot', () => {
    const s = fresh()
    const m = s.createMeeting({ ...base, startedAt: 1 })
    s.addSegments([
      { meetingId: m.id, track: 'them', startMs: 0, endMs: 900, text: 'a', speaker: 'Speaker 1', speakerKey: 'v1' },
      { meetingId: m.id, track: 'them', startMs: 1000, endMs: 1900, text: 'b', speaker: 'Speaker 2', speakerKey: 'v2' },
      { meetingId: m.id, track: 'them', startMs: 2000, endMs: 2900, text: 'c', speaker: 'Speaker 3', speakerKey: 'v3' },
    ])
    s.speakerOrder(m.id)
    // meeting_speakers.profile_id references voice_profiles, so the matched profile must exist
    s.createVoiceProfile({ id: 'p1', name: 'Ada', model: 'campplus', dims: 192, centroid: Buffer.from([1, 2]) })
    s.applyDiarization(m.id, { deleteIds: [], insert: [], speakers: [
      { key: 'v1', speaker: 'Speaker 1', profileId: 'p1', score: 0.9, startMs: 0, endMs: 900 },
      { key: 'v2', speaker: 'Speaker 2', startMs: 1000, endMs: 1900 },
    ] })
    expect(s.mergeSpeakers(m.id, 'v2', 'v1')).toBe(true)
    const segs = s.segments(m.id)
    expect(segs.map(x => x.speakerKey)).toEqual(['v1', 'v1', 'v3'])
    expect(segs.map(x => x.speaker)).toEqual(['Speaker 1', 'Speaker 1', 'Speaker 3'])
    const sp = Object.fromEntries(s.meetingSpeakers(m.id).map(x => [x.key, x]))
    expect(sp.v2).toBeUndefined()
    expect(sp.v1).toMatchObject({ startMs: 0, endMs: 1900, profileId: 'p1', score: 0.9 })
    // the source name stays as an unused slot, so Speaker 3 keeps its colour
    expect(JSON.parse(String(s.db.prepare('SELECT speaker_order FROM meetings WHERE id = ?').get(m.id)!.speaker_order))).toEqual(['Speaker 1', 'Speaker 2', 'Speaker 3'])
    expect(s.mergeSpeakers(m.id, 'vX', 'v1')).toBe(false)
    expect(s.mergeSpeakers(m.id, 'v1', 'v1')).toBe(false)
  })

  it('setVoicesAllowed and markDiarized land on the meeting', () => {
    const s = fresh()
    const m = s.createMeeting({ ...base, startedAt: 1 })
    s.setVoicesAllowed(m.id, true)
    expect(s.meeting(m.id)).toMatchObject({ voicesAllowed: true, diarizeError: null })
    expect(s.meeting(m.id)!.diarizedAt).toBeUndefined()
    s.markDiarized(m.id)
    expect(s.meeting(m.id)).toMatchObject({ voicesAllowed: true, diarizeError: null })
    expect(s.meeting(m.id)!.diarizedAt).toBeGreaterThan(0)
    s.markDiarized(m.id, 'nemo-speech failed')
    expect(s.meeting(m.id)).toMatchObject({ diarizeError: 'nemo-speech failed' })
  })

  it('voice profiles: create, list without vectors, bump, update, delete, delete all', () => {
    const s = fresh()
    expect(s.voiceProfiles()).toEqual([])
    s.createVoiceProfile({ id: 'p1', name: 'Ada', model: 'campplus', dims: 192, centroid: Buffer.from([1, 2]) })
    s.createVoiceProfile({ id: 'p2', name: 'Bo', model: 'campplus', dims: 192, centroid: Buffer.from([3]) })
    s.bumpVoiceProfile('p1')
    // real float32s: a centroid is dims floats, four bytes each (the mapper reads them back with readFloatLE)
    const updated = Buffer.alloc(8)
    updated.writeFloatLE(9, 0); updated.writeFloatLE(9, 4)
    s.updateVoiceCentroid('p1', updated)
    expect(s.voiceProfiles().map(p => [p.name, p.meetings])).toEqual([['Ada', 1], ['Bo', 0]])
    expect(Object.keys(s.voiceProfiles()[0])).not.toContain('centroid')
    expect([...s.voiceCentroids().find(p => p.id === 'p1')!.centroid.slice(0, 2)]).toEqual([9, 9])
    expect(s.voiceCentroids().find(p => p.id === 'p1')!.dims).toBe(192)
  })
  it('setMeetingSpeakerProfile fills profile and score without erasing them', () => {
    const s = fresh()
    // meeting_speakers.profile_id references voice_profiles (ON DELETE SET NULL), so the profiles must exist
    s.createVoiceProfile({ id: 'p1', name: 'Ada', model: 'campplus', dims: 192, centroid: Buffer.from([1, 2]) })
    s.createVoiceProfile({ id: 'p2', name: 'Bo', model: 'campplus', dims: 192, centroid: Buffer.from([3]) })
    const m = s.createMeeting({ ...base, startedAt: 1 })
    s.applyDiarization(m.id, { deleteIds: [], insert: [], speakers: [{ key: 'v1', speaker: 'Speaker 1', score: 0.5, startMs: 0, endMs: 100 }] })
    s.setMeetingSpeakerProfile(m.id, 'v1', { profileId: 'p1', score: null })
    expect(s.meetingSpeakers(m.id)[0]).toMatchObject({ profileId: 'p1', score: 0.5 })
    // a meeting_speakers row loses its profile but keeps its name when the profile is deleted
    const m2 = s.createMeeting({ ...base, startedAt: 2 })
    s.applyDiarization(m2.id, { deleteIds: [], insert: [], speakers: [{ key: 'v1', speaker: 'Ada', profileId: 'p1', startMs: 0, endMs: 100 }] })
    s.deleteVoiceProfile('p1')
    expect(s.voiceProfiles().map(p => p.id)).toEqual(['p2'])
    expect(s.meetingSpeakers(m2.id)[0].profileId).toBeNull()
    s.deleteAllVoiceProfiles()
    expect(s.voiceProfiles()).toEqual([])
  })
})
