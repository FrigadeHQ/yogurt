import type { AgendaEvent, MeetingCard } from './types'

export const resumesNote = (note: AgendaEvent['note']): boolean => note?.state === 'stopped' || note?.state === 'done'

export function agendaNoteAction(event: AgendaEvent, recording: MeetingCard | undefined, now: number): 'start' | 'open' | 'prepare' | null {
  const note = recording?.eventId === event.id ? recording : event.note
  const meeting = event.attendees.length > 0 || !!event.url?.trim() // EventKit already excludes the owner.
  if (meeting && !recording && (!note || note.state === 'prepared') && event.start <= now && event.end > now) return 'start'
  if (note) return 'open'
  return meeting ? 'prepare' : null
}

export const DAY_MS = 86_400_000
export function unusedPreparedNote(p: { state: string; eventEnd: number | null; openedAt: number | null; mine: string; enhanced: string | null; segments: number; userEdited: boolean }, now: number): boolean {
  return p.state === 'prepared' && p.eventEnd !== null && p.eventEnd < now - DAY_MS && p.openedAt !== null && p.openedAt < now - DAY_MS
    && !p.mine && !p.enhanced && !p.segments && !p.userEdited
}
