/**
 * One diarization run per meeting after it stops: the recording, transcript and (briefly) the call's names settle
 * first, then the job is queued, and this promise settles with it. A failure is only warned about: the notes of the
 * meeting wait on this promise and must always be able to go on.
 */
export type DiarizeSchedule = ReturnType<typeof createDiarizeSchedule>

export function createDiarizeSchedule(p: {
  recordingFinished: (id: string) => Promise<void>
  transcriptFinished: (id: string) => Promise<void>
  /** the names from the call: naming evidence for diarization, waited for but never longer than namesWaitMs */
  namesFinished: (id: string) => Promise<void>
  /** speakers are separated at all (the settings switch); off: the meeting never diarizes and nothing waits for it */
  wanted?: () => boolean
  schedule: (id: string) => void
  finished: (id: string) => Promise<void>
  namesWaitMs: number
  warn?: (message: string, error: unknown) => void
}) {
  const runs = new Map<string, Promise<void>>()
  /** wait for something, but never longer than this */
  const upTo = async (wait: Promise<void>, ms: number) => {
    let timer: NodeJS.Timeout | undefined
    await Promise.race([wait.catch(() => {}), new Promise<void>((r) => { timer = setTimeout(r, ms) })])
    clearTimeout(timer)
  }
  return {
    /** the run for this meeting; a second start joins the first and never schedules twice */
    start(id: string): Promise<void> {
      const had = runs.get(id)
      if (had) return had
      const done = p.wanted && !p.wanted() ? Promise.resolve() : (async () => {
        await p.recordingFinished(id)
        await p.transcriptFinished(id)
        await upTo(p.namesFinished(id), p.namesWaitMs)
        p.schedule(id)
        await p.finished(id)
      })().catch((e) => (p.warn ?? console.warn)('diarization after the meeting failed', e))
      runs.set(id, done)
      return done
    },
    /** the run for this meeting, or nothing to wait for (an imported meeting, or one never scheduled) */
    wait: (id: string): Promise<void> => runs.get(id) ?? Promise.resolve(),
    /** the meeting records again: its next stop starts a fresh run */
    forget: (id: string) => { runs.delete(id) },
  }
}
