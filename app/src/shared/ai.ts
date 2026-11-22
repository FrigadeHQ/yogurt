/**
 * Settings → AI models: what writes each kind of text. The model on this computer unless the person picks their own
 * server (OpenAI-compatible). Titles follow the summary's choice.
 */
export const AI_TASKS = ['notes', 'ask', 'folders'] as const
export type AiTask = (typeof AI_TASKS)[number]

export type Provider = 'local' | 'server'
export const isProvider = (x: unknown): x is Provider => x === 'local' || x === 'server'
export const isTask = (x: unknown): x is AiTask => AI_TASKS.includes(x as AiTask)

/** the person's own server; the key never leaves main, the window only hears whether there is one */
export type ServerView = { url: string; model: string; contextSize: number; hasKey: boolean }
/** what Settings shows: each task's choice, and what can be chosen */
export type AiStatus = {
  tasks: Record<AiTask, Provider>
  server: ServerView | null
  /** a notes model is on this computer */
  local: boolean
}
/** a server's context when it doesn't say: what the model on this computer reads at most */
export const SERVER_CONTEXT = 32_768
export const MIN_SERVER_CONTEXT = 4096
export const MAX_SERVER_CONTEXT = 2_000_000
