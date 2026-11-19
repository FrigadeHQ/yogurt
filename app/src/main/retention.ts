import type { Settings } from './settings'
import type { Store } from './store'
import type { DeleteRecordingResult } from '../shared/types'
import { retentionDays, type Retention, type RetentionKind } from '../shared/retention'

const DAY = 24 * 60 * 60 * 1000
const KEY = { audio: 'audioDays', transcript: 'transcriptDays', meeting: 'meetingDays' } as const satisfies Record<RetentionKind, keyof Settings>
/** after: only meetings that ended after this time (the audio switch from before rules) */
export type Rule = { days: number; after?: number }

export function ruleOf(s: Settings, kind: RetentionKind): Rule | null {
  const days = retentionDays(kind, s[KEY[kind]])
  if (days != null) return { days }
  // "Keep audio recordings" off, from before rules: audio went once the summary was saved, for meetings that ended after that
  if (kind === 'audio' && s.keepRecordings === false && typeof s.recordingsOffAt === 'number' && Number.isFinite(s.recordingsOffAt)) return { days: 0, after: s.recordingsOffAt }
  return null
}
export const retentionOf = (s: Settings): Retention => ({ audio: ruleOf(s, 'audio')?.days ?? null, transcript: ruleOf(s, 'transcript')?.days ?? null, meeting: ruleOf(s, 'meeting')?.days ?? null })
/** a rule picked in Settings; a new audio rule replaces the old switch */
export const retentionPatch = (kind: RetentionKind, days: number | null): Partial<Settings> =>
  ({ [KEY[kind]]: days ?? undefined, ...(kind === 'audio' ? { keepRecordings: undefined, recordingsOffAt: undefined } : {}) })

/** a meeting that ended then is past the rule */
export const isDue = (rule: Rule | null, endedAt: number | null, now: number): boolean =>
  !!rule && endedAt != null && endedAt <= now - rule.days * DAY && (rule.after == null || endedAt > rule.after)

type Deps = {
  store: Pick<Store, 'retentionDue'>
  hasAudio: (id: string) => boolean
  /** automatic deletion: it still needs a saved transcript and summary */
  removeAudio: (id: string) => Promise<DeleteRecordingResult>
  /** the transcript goes once its audio has */
  removeTranscript: (id: string) => void
  trash: (id: string) => void
}

/** the meetings a rule acts on now: past it, and still holding what it removes */
export function dueNow(d: Pick<Deps, 'store' | 'hasAudio'>, kind: RetentionKind, rule: Rule, now = Date.now()): string[] {
  const ids = d.store.retentionDue(kind, now - rule.days * DAY, rule.after)
  return kind === 'audio' ? ids.filter(d.hasAudio) : ids
}

/** Every rule once: the Trash first (the rest goes with the meeting), then transcripts with their audio, then audio.
 * Anything that can't go now is tried again next time. */
export async function sweep(d: Deps & { settings: Settings }, now = Date.now()): Promise<void> {
  const meeting = ruleOf(d.settings, 'meeting'), transcript = ruleOf(d.settings, 'transcript'), audio = ruleOf(d.settings, 'audio')
  for (const id of meeting ? dueNow(d, 'meeting', meeting, now) : []) d.trash(id)
  for (const id of transcript ? dueNow(d, 'transcript', transcript, now) : []) {
    try { if (await d.removeAudio(id) === 'deleted') d.removeTranscript(id) } catch (e) { console.warn('retention kept a transcript it could not delete', id, e) }
  }
  for (const id of audio ? dueNow(d, 'audio', audio, now) : []) await d.removeAudio(id)
}
