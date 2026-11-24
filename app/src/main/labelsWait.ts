/**
 * Summaries that wait for the person: with the settings switch on, a diarized meeting whose transcript still has
 * voices called Speaker N, voices without a name, or lines nobody claimed holds its notes back until everything is
 * labeled — or until the person asks for the summary anyway. The notes pipeline awaits `wait` where it already
 * waited for diarization; renaming, merging and assigning re-check, and a release makes the meeting never wait again.
 */
export type LabelWait = ReturnType<typeof createLabelWait>

export function createLabelWait(p: {
  /** summaries wait for speaker labels (the settings switch) */
  wanted: () => boolean
  /** does this meeting still have something to label? */
  pending: (id: string) => boolean
}) {
  const waits = new Map<string, Promise<void>>()
  const wake = new Map<string, () => void>()
  return {
    /** resolves at once when the meeting needs nothing, and otherwise once it is labeled or released */
    wait(id: string): Promise<void> {
      if (!p.wanted() || !p.pending(id)) { this.forget(id); return Promise.resolve() }
      const had = waits.get(id)
      if (had) return had
      const done = new Promise<void>((resolve) => wake.set(id, resolve))
      waits.set(id, done)
      return done
    },
    /** labeling happened (or the meeting changed): a held meeting that needs nothing anymore goes on */
    recheck(id: string) {
      if (!waits.has(id) || (p.wanted() && p.pending(id))) return
      this.forget(id)
    },
    /** the meeting never waits again (released by hand, or it records again) */
    forget(id: string) {
      const done = wake.get(id)
      wake.delete(id)
      waits.delete(id)
      done?.()
    },
  }
}
