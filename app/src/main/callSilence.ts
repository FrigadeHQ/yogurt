/** under this the call side heard nothing (the same line levelLog.ts calls "no call audio heard") */
const HEARD = 0.05
/** levels come ten a second; a gap longer than this is a pause, whose time is not silence */
const GAP_MS = 5000
/** the call side silent this long, with the speaker here talking for a minute of it, is probably a lost capture, not a quiet call */
export const CALL_SILENT_MS = 4 * 60_000
const TALKED_MS = 60_000

/**
 * Whether the other side of a call has stopped coming through while somebody talks at this end (a headset that
 * switched mode, a device that went away): the capture can stop without a word, and the person finds out after the meeting.
 * Only after the call side was heard once, so a missing permission keeps its own hint. Gives true when it starts, false
 * when the call is heard again, undefined otherwise. talking: somebody speaks into the mic now.
 */
export function createCallSilence(silentMs = CALL_SILENT_MS) {
  let heard = false, silent = false, lastThem = 0, lastSeen = 0, talkMs = 0
  return (them: number, talking: boolean, now: number): boolean | undefined => {
    const dt = lastSeen ? now - lastSeen : 0
    lastSeen = now
    if (dt > GAP_MS) { lastThem = now; talkMs = 0 } else if (talking) talkMs += dt
    if (them >= HEARD) {
      heard = true; lastThem = now; talkMs = 0
      if (silent) { silent = false; return false }
    } else if (!silent && heard && now - lastThem >= silentMs && talkMs >= TALKED_MS) {
      silent = true
      return true
    }
    return undefined
  }
}
