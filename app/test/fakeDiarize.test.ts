import { afterEach, describe, expect, it } from 'vitest'
import { fakeTurns, fakeVectorFor, fakeVector } from '../src/main/diarize/fake'
import { cosine } from '../src/main/diarize/match'

afterEach(() => {
  delete process.env.YOGURT_FAKE_VOICES
  delete process.env.YOGURT_FAKE_VOICE_SIM
  delete process.env.YOGURT_FAKE_DIARIZE_FAIL
})

describe('fake diarizer', () => {
  it('two voices from the fake transcript, one with YOGURT_FAKE_VOICES=1', () => {
    expect(fakeTurns()).toHaveLength(2)
    process.env.YOGURT_FAKE_VOICES = '1'
    expect(fakeTurns()).toHaveLength(1)
  })
  it('vectors match their own key strongly, and the sim knob tunes it', () => {
    const self = cosine(fakeVectorFor('f1'), fakeVector('f1'))
    expect(self).toBeGreaterThan(0.8)
    process.env.YOGURT_FAKE_VOICE_SIM = 'ambiguous'
    expect(cosine(fakeVectorFor('f1'), fakeVector('f1'))).toBeGreaterThan(0.6)
    expect(cosine(fakeVectorFor('f1'), fakeVector('f1'))).toBeLessThan(0.72)
    process.env.YOGURT_FAKE_VOICE_SIM = 'none'
    expect(cosine(fakeVectorFor('f1'), fakeVector('f1'))).toBeLessThan(0.6)
  })
  it('different keys differ', () => {
    expect(cosine(fakeVector('f1'), fakeVector('f2'))).toBeLessThan(0.99)
  })
  it('YOGURT_FAKE_DIARIZE_FAIL=1 makes diarization a recorded no-op', () => {
    expect(fakeTurns()).toHaveLength(2)
    process.env.YOGURT_FAKE_DIARIZE_FAIL = '1'
    expect(fakeTurns()).toEqual([])
  })
})
