import { contextBody, mentionIn, type ContextLine } from '../shared/mentions'

/** a line as the transcript sends it: who said it and what */
type Said = { meetingId: string; track: 'me' | 'them'; startMs: number; text: string; speaker: string | null; hidden?: boolean }

/** what the notification says; clicking it opens the meeting's note */
export type MentionNotice = { meetingId: string; title: string; body: string }

/** a conversation about the person names them again and again: one notice, then quiet this long */
export const MENTION_QUIET_MS = 60_000
/** the lines shown: the mention's and a few before it */
export const CONTEXT_LINES = 4

/**
 * Listens to each line saved while a meeting records. When someone on the other side says one of the person's names, it
 * tells them, with the last few lines of the conversation. Only the other side: the person saying their own name into the
 * mic ("Hi, I'm Alex") is not a mention.
 */
export function createMentionAlerts(d: {
  /** on unless turned off in Settings; read on each line, so a change counts at once */
  on: () => boolean
  /** the names to listen for (mentionNames), read on each line */
  names: () => string[]
  /** the meeting's latest lines, oldest first (the mentioning one among them) */
  recent: (meetingId: string, count: number) => Said[]
  /** who said a line, as the transcript shows it: You, the name the call app showed, or Them */
  who: (l: Pick<Said, 'track' | 'speaker'>) => string
  /** the notification's title: who said the name, or null when the call app did not show it */
  title: (speaker: string | null) => string
  notify: (n: MentionNotice) => void
  now?: () => number
}) {
  const now = d.now ?? Date.now
  const last = new Map<string, number>()
  return {
    /** a line was saved (lines come in order on each track; hidden echo lines are never mentions) */
    line(seg: Said): void {
      if (seg.track !== 'them' || seg.hidden || !d.on()) return
      const name = mentionIn(seg.text, d.names())
      if (!name) return
      const t = now()
      const before = last.get(seg.meetingId)
      if (before !== undefined && t - before < MENTION_QUIET_MS) return
      last.set(seg.meetingId, t)
      // the saved lines up to this one: a `me` line still held back for its echo check may come later, and is left out
      const lines = d.recent(seg.meetingId, CONTEXT_LINES + 2).filter((l) => !l.hidden && l.startMs <= seg.startMs)
      const tail = lines.slice(-CONTEXT_LINES)
      // the line just heard is the newest one shown, even if the store has not got it (or got one starting at the same time)
      if (!tail.length || tail.at(-1)!.text !== seg.text) { tail.push(seg); if (tail.length > CONTEXT_LINES) tail.shift() }
      const context: ContextLine[] = tail.map((l) => ({ who: d.who(l), text: l.text }))
      d.notify({ meetingId: seg.meetingId, title: d.title(seg.speaker), body: contextBody(context, name) })
    },
  }
}
