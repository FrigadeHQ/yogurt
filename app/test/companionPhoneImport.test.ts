import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openStore, type Store } from '../src/main/store'
import { importPhoneRecording, isPhoneDraft, phoneWavOk } from '../src/main/companion/phoneImport'
import { wavBytes } from '../src/main/asr/transcribe'
import { AUDIO_SPEAKER } from '../src/shared/audioUpload'

let store: Store, root: string
const start = vi.fn(), changed = vi.fn()
const meeting = { id: 'phone-rec-1', title: 'Meeting at 3:40 PM', titleSource: 'default' as const, startedAt: 1000, endedAt: 61_000, attendees: [] }
const draft = { myNotes: 'ask about the budget', summary: '## Budget\n- Made-up draft point', transcript: [
  { startMs: 0, endMs: 900, text: 'Made-up first line.' }, { startMs: 1000, endMs: 1900, text: '  ' }, { startMs: 2000, endMs: 2900, text: 'Made-up second line.' }] }
/** a tenth of a second of made-up 16 kHz mono 16-bit audio, as the phone sends it */
const tinyWav = (name = 'up.wav') => { const f = join(root, name); const s = new Float32Array(1600).map((_, i) => Math.sin(i / 8) * 0.2); const b = wavBytes(s); b.writeUInt32LE(36 + s.length * 2, 4); b.writeUInt32LE(s.length * 2, 40); writeFileSync(f, b); return f }
const deps = () => ({ store, meetingDir: (id: string) => join(root, 'meetings', id), start, changed })

beforeEach(() => { store = openStore(':memory:'); root = mkdtempSync(join(tmpdir(), 'yogurt-phone-')); vi.resetAllMocks() })
afterEach(() => store.close())

it('a phone WAV becomes them.wav, keeps the phone transcript and draft notes, and is transcribed again over them', async () => {
  const wav = tinyWav(), bytes = readFileSync(wav)
  await importPhoneRecording(deps(), meeting, wav, draft)
  const dir = join(root, 'meetings', meeting.id)
  expect(readFileSync(join(dir, 'them.wav'))).toEqual(bytes)
  expect(existsSync(wav)).toBe(false)
  const m = store.meeting(meeting.id)!
  expect(m).toMatchObject({ source: 'audio-file', title: meeting.title, transcriptionPending: true })
  expect(isPhoneDraft(m)).toBe(true)
  expect(store.segments(meeting.id).map((s) => [s.text, s.track, s.speaker, s.startMs])).toEqual([
    ['Made-up first line.', 'them', AUDIO_SPEAKER, 0], ['Made-up second line.', 'them', AUDIO_SPEAKER, 2000]])
  expect(store.notes(meeting.id)).toMatchObject({ mine: 'ask about the budget', enhanced: '## Budget\n- Made-up draft point' })
  // the computer's transcript replaces the phone's only once it has one
  expect(start).toHaveBeenCalledExactlyOnceWith(meeting.id, true)
  expect(changed).toHaveBeenCalled()
})

it('with nothing from the phone it is transcribed like any upload', async () => {
  await importPhoneRecording(deps(), meeting, tinyWav(), { myNotes: '', transcript: [] })
  const m = store.meeting(meeting.id)!
  expect(isPhoneDraft(m)).toBe(false)
  expect(store.segments(meeting.id)).toEqual([])
  expect(store.notes(meeting.id).enhanced).toBeNull()
  expect(start).toHaveBeenCalledExactlyOnceWith(meeting.id, false)
})

it('an m4a from an older phone stays them.m4a', async () => {
  const f = join(root, 'up.m4a'); writeFileSync(f, 'made-up m4a bytes')
  await importPhoneRecording(deps(), meeting, f, draft)
  expect(existsSync(join(root, 'meetings', meeting.id, 'them.m4a'))).toBe(true)
})

it('a WAV that is not 16 kHz mono 16-bit is refused before any meeting is made', async () => {
  const f = join(root, 'odd.wav'); const b = Buffer.from(readFileSync(tinyWav('good.wav'))); b.writeUInt32LE(44100, 24); writeFileSync(f, b)
  expect(await phoneWavOk(f)).toBe(false)
  expect(await phoneWavOk(tinyWav('good.wav'))).toBe(true)
  await expect(importPhoneRecording(deps(), meeting, f, draft)).rejects.toThrow()
  expect(store.meeting(meeting.id)).toBeUndefined()
  expect(start).not.toHaveBeenCalled()
})

it('imports once', async () => {
  await importPhoneRecording(deps(), meeting, tinyWav(), draft)
  await importPhoneRecording(deps(), meeting, tinyWav(), draft)
  expect(start).toHaveBeenCalledOnce()
  expect(store.segments(meeting.id)).toHaveLength(2)
})

it("the phone's default title is the computer's to replace; one its model wrote may be improved; one typed stays", async () => {
  await importPhoneRecording(deps(), meeting, tinyWav(), draft)
  expect(store.meeting(meeting.id)!.titleSource).toBe('generic')
  await importPhoneRecording(deps(), { ...meeting, id: 'phone-rec-2', title: 'Budget walk', titleSource: 'model' }, tinyWav('b.wav'), draft)
  expect(store.meeting('phone-rec-2')!.titleSource).toBe('auto')
  await importPhoneRecording(deps(), { ...meeting, id: 'phone-rec-3', title: 'Kiwi plans', titleSource: 'typed' }, tinyWav('c.wav'), draft)
  expect(store.meeting('phone-rec-3')!.titleSource).toBe('user')
})
