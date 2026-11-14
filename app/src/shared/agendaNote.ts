import type { AgendaEvent, MeetingCard } from './types'

export const resumesNote = (note: AgendaEvent['note']): boolean => note?.state === 'stopped' || note?.state === 'done'

export function agendaNoteAction(event: AgendaEvent, recording: MeetingCard | undefined, now: number): 'start' | 'open' | 'prepare' | null {
  const note = recording?.eventId === event.id ? recording : event.note
  if (!recording && (!note || note.state === 'prepared') && event.start <= now && event.end > now) return 'start'
  return note ? 'open' : 'prepare'
}

export const DAY_MS = 86_400_000
export function unusedPreparedNote(p: { state: string; eventEnd: number | null; openedAt: number | null; mine: string; enhanced: string | null; segments: number; userEdited: boolean }, now: number): boolean {
  return p.state === 'prepared' && p.eventEnd !== null && p.eventEnd < now - DAY_MS && p.openedAt !== null && p.openedAt < now - DAY_MS
    && !p.mine && !p.enhanced && !p.segments && !p.userEdited
}
