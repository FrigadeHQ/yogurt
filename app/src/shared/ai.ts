/**
 * Settings → AI models: what writes each kind of text. The model on this computer unless the person picks their own
 * server (OpenAI-compatible) or an AI agent app on this computer. Titles and Edit summary follow the summary.
 */
export const AI_TASKS = ['notes', 'ask', 'folders'] as const
export type AiTask = (typeof AI_TASKS)[number]

/** AI agent apps Yogurt can hand text to, each through its own sign-in: shown only once found on this computer */
export const AGENTS = [
  { id: 'hermes', name: 'Hermes', install: 'https://github.com/NousResearch/hermes-agent' },
  { id: 'codex', name: 'Codex', install: 'https://github.com/openai/codex' },
  { id: 'claude', name: 'Claude Code', install: 'https://github.com/anthropics/claude-code' },
] as const
export type AgentId = (typeof AGENTS)[number]['id']

export type Provider = 'local' | 'server' | AgentId
export const isProvider = (x: unknown): x is Provider => x === 'local' || x === 'server' || AGENTS.some((a) => a.id === x)
export const isTask = (x: unknown): x is AiTask => AI_TASKS.includes(x as AiTask)

/** the person's own server; the key never leaves main, the window only hears whether there is one */
export type ServerView = { url: string; model: string; contextSize: number; hasKey: boolean }
/** what Settings shows: each task's choice, and what can be chosen */
export type AiStatus = {
  tasks: Record<AiTask, Provider>
  server: ServerView | null
  agents: Array<{ id: AgentId; name: string; found: boolean }>
  /** a notes model is on this computer */
  local: boolean
  /** Transcription: the one picked (null: Auto), what Auto means here, and every speech model there is, best first */
  speech?: { choice: string | null; auto?: { id: string; name: string }; models: Array<{ id: string; name: string; bytes: number }> }
}
/** a server's context when it doesn't say: what the model on this computer reads at most */
export const SERVER_CONTEXT = 32_768
export const MIN_SERVER_CONTEXT = 4096
export const MAX_SERVER_CONTEXT = 2_000_000
