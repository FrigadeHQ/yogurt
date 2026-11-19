/** What Yogurt keeps (Settings): one rule each for a meeting's audio, an uploaded video, its transcript and the meeting itself */
export const RETENTION_KINDS = ['audio', 'video', 'transcript', 'meeting'] as const
export type RetentionKind = typeof RETENTION_KINDS[number]
/** days after a meeting ends; null keeps it. Audio's 0 is "once the summary is saved"; video's 0 is not keeping it at all */
export type Retention = Record<RetentionKind, number | null>
/** the choices offered besides Never and Other */
export const RETENTION_PRESETS: Record<RetentionKind, number[]> = { audio: [0, 7, 30, 90, 365], video: [0, 7, 30, 90, 365], transcript: [30, 90, 365], meeting: [90, 365, 730] }
export const RETENTION_MAX_DAYS = 3650

/** whole days, 0 only for audio and video; anything else is no rule */
export const retentionDays = (kind: RetentionKind, v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= (kind === 'audio' || kind === 'video' ? 0 : 1) && v <= RETENTION_MAX_DAYS ? v : null
