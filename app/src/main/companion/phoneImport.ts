// A meeting recorded on the iPhone, made on this computer from its upload. The phone sends 16 kHz mono 16-bit WAV, the
// same audio an uploaded file is turned into, so every platform can transcribe it (older phones sent m4a, which only a
// Mac decodes). What the phone already has (its transcript and draft notes) shows until this computer has its own.
import { mkdir, open, rename, copyFile, rm } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { Meeting, Store } from '../store'
import { AUDIO_SPEAKER } from '../../shared/audioUpload'
import { languageCode, languageName } from '../asr/appleSpeech'
import type { PhoneDraft, UploadMeeting } from './handlers'

/** sourceId of a phone meeting whose notes are still the phone's draft: the computer's notes replace them once */
const DRAFT = 'phone-draft:'

export const isPhoneDraft = (m: Pick<Meeting, 'sourceId'> | undefined): boolean => !!m?.sourceId?.startsWith(DRAFT)
/** The language a phone recording was spoken in, as whisper's code: the phone said so, so it is not guessed */
export const phoneLanguage = (m: Pick<Meeting, 'sourceId' | 'language'> | undefined): string | undefined =>
  (m?.sourceId?.startsWith('phone') && languageCode(m.language)) || undefined
/** the computer is writing its own notes now: the draft mark goes, so later transcriptions keep them */
export const phoneDraftReplaced = (store: Pick<Store, 'updateMeeting'>, id: string) => store.updateMeeting(id, { sourceId: `phone:${id}` })

/** A canonical WAV header: PCM, one channel, 16 kHz, 16-bit, data right after (what uploadedAudio reads). */
export async function phoneWavOk(path: string): Promise<boolean> {
  const f = await open(path, 'r')
  try {
    const h = Buffer.alloc(44)
    const { bytesRead } = await f.read(h, 0, 44, 0)
    return bytesRead === 44 && h.toString('ascii', 0, 4) === 'RIFF' && h.toString('ascii', 8, 12) === 'WAVE' && h.toString('ascii', 12, 16) === 'fmt '
      && h.readUInt16LE(20) === 1 && h.readUInt16LE(22) === 1 && h.readUInt32LE(24) === 16000 && h.readUInt16LE(34) === 16
      && h.toString('ascii', 36, 40) === 'data'
  } finally { await f.close() }
}

export async function importPhoneRecording(
  d: { store: Store; meetingDir: (id: string) => string; start: (id: string, again: boolean) => unknown; changed: () => void },
  m: UploadMeeting, audioPath: string, draft: PhoneDraft,
): Promise<void> {
  if (d.store.meeting(m.id)) return
  const wav = extname(audioPath).toLowerCase() === '.wav'
  if (wav && !(await phoneWavOk(audioPath))) throw new Error('Unsupported phone audio')
  const dir = d.meetingDir(m.id), target = join(dir, wav ? 'them.wav' : 'them.m4a')
  await mkdir(dir, { recursive: true })
  await rename(audioPath, target).catch(async () => { await copyFile(audioPath, target); await rm(audioPath, { force: true }) })
  const lines = draft.transcript.filter((l) => l.text.trim())
  const summary = draft.summary?.trim() ? draft.summary : undefined
  // the phone's default title is this computer's to replace once its notes are written, like a generic one here; a
  // title Apple's model wrote can be improved the same way; one the person typed stays
  const titleSource = m.titleSource === 'typed' ? 'user' : m.titleSource === 'model' ? 'auto' : 'generic'
  d.store.createMeeting({ title: m.title, titleSource, source: 'audio-file',
    startedAt: m.startedAt, endedAt: m.endedAt, durationMs: m.endedAt - m.startedAt, eventId: null, app: null, attendees: m.attendees,
    state: 'stopped', transcriptionPending: true, language: m.language ? languageName(m.language) : null }, m.id)
  // marked as the phone's, so its language is kept when it is transcribed (phoneLanguage)
  d.store.updateMeeting(m.id, { sourceId: summary ? DRAFT + m.id : `phone:${m.id}` })
  if (draft.myNotes.trim() || summary) d.store.setNotes(m.id, { mine: draft.myNotes, ...(summary ? { enhanced: summary } : {}) })
  // one microphone in a room: nobody is named, like an uploaded file
  if (lines.length) d.store.addSegments(lines.map((l) => ({ meetingId: m.id, track: 'them' as const, startMs: l.startMs, endMs: l.endMs, text: l.text.trim(), speaker: AUDIO_SPEAKER })))
  d.changed()
  // with the phone's lines shown, this computer's transcript is staged and replaces them only when it is done
  void d.start(m.id, lines.length > 0)
}
