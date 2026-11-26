import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

type Schedule = Record<string, number | null>

export function createProcessingSchedule(d: {
  file: string
  now?: () => number
  ready: () => boolean
  start: (id: string) => Promise<boolean>
}) {
  const now = d.now ?? (() => Date.now())
  let entries: Schedule = existsSync(d.file) ? JSON.parse(readFileSync(d.file, 'utf8')) : {}
  let releasing: string | undefined
  const save = (next: Schedule) => {
    const tmp = d.file + '.tmp'
    writeFileSync(tmp, JSON.stringify(next))
    renameSync(tmp, d.file)
    entries = next
  }
  const held = (id: string) => Object.hasOwn(entries, id) && releasing !== id
  return {
    held,
    pending: () => Object.entries(entries).filter(([id]) => held(id)).map(([id, at]) => ({ id, at })),
    hold(id: string) {
      if (!Object.hasOwn(entries, id)) save({ ...entries, [id]: null })
    },
    choose(id: string, at: number) {
      if (!held(id)) return false
      if (!Number.isFinite(at) || (at !== 0 && at <= now())) throw new Error('Choose a future time')
      save({ ...entries, [id]: at })
      return true
    },
    async tick() {
      if (releasing) return
      // Start one due job per tick. The normal saved-transcription queue owns it from here.
      for (const [id, at] of Object.entries(entries)) {
        if (at === null || at > now()) continue
        if (!d.ready()) return
        releasing = id
        try {
          if (await d.start(id)) {
            const next = { ...entries }
            delete next[id]
            save(next)
            return
          }
        } finally {
          releasing = undefined
        }
      }
    },
  }
}
