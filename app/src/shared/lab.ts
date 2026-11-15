// Transcript lab, the shapes the window and the main process share.

/** A place where the models' readings differ: each option is what some of them heard there (empty text: nothing) */
export type LabChoice = { at: number; options: Array<{ text: string; models: string[]; weight: number }>; picked: number }

/** A stretch of one speaker the extra models read, with what came of it */
export type LabWindow = {
  key: string; track: 'me' | 'them'; speaker: string | null; startMs: number; endMs: number; segmentIds: number[]
  /** the live lines' text, as they were */
  texts: string[]
  language: string | null
  combined: string | null
  choices: LabChoice[]
  /** the person's own text for this stretch: shown whatever the version, and the truth models are measured against */
  fixed: string | null
}

export type LabStatus = { state: 'none' | 'queued' | 'running' | 'done' | 'failed'; step?: string; error?: string; updatedAt?: number
  /** what the transcript shows: 'live', 'combined', or a model's id */
  using: string }

export type LabModelInfo = { id: string; label: string; combine: boolean }

export type LabView = { status: LabStatus; windows: LabWindow[]; readings: Record<string, Record<string, string>>; models: LabModelInfo[] }

/** each version's word errors against the person's fixes, over every meeting: errors / words heard in the fixed text */
export type LabScores = Record<string, { errors: number; words: number }>
