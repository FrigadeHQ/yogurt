import type { Llm } from '../notes/enhance'
import type { NotesModel } from '../notes/model'
import type { AiTask, Provider } from '../../shared/ai'

/** what every caller of the notes model already takes: notes, Ask, folder suggestions, reading ahead */
export type Model = Pick<NotesModel, 'llm'> & Partial<Pick<NotesModel, 'needsLoad'>>
/** a model other than the one on this computer, ready to ask; undefined when it isn't set up or isn't on this computer */
export type Remote = (provider: Exclude<Provider, 'local'>, signal?: AbortSignal) => Llm | undefined

/** room an answer gets when its question doesn't say */
const ANSWER_ROOM = 1024

/**
 * Each task's model: the one chosen for it in Settings → AI models, or the model on this computer. A chosen one that
 * fails before its first word hands the question to the model on this computer, when there is one and the question
 * fits it; one that fails after has said something, so the job fails as it would with the local model.
 */
export function createRouter(o: { local: Model; hasLocal: () => boolean; choice: (task: AiTask) => Provider; remote: Remote }) {
  /** the choice, while it can be used; the model on this computer otherwise */
  const chosen = (task: AiTask): Provider => {
    const p = o.choice(task)
    return p !== 'local' && o.remote(p) ? p : 'local'
  }
  const fallback = (remote: Llm, task: AiTask, p: Provider, signal?: AbortSignal): Llm => ({
    contextSize: remote.contextSize,
    count: remote.count,
    chat: async (prompt, onToken, opts) => {
      let wrote = false
      try {
        return await remote.chat(prompt, (t) => { wrote = true; onToken(t) }, opts)
      } catch (e) {
        if (wrote || signal?.aborted || !o.hasLocal()) throw e
        const local = await o.local.llm(signal)
        const [tokens] = await local.count([[...(opts?.before ?? []), prompt].join('\n')])
        if (tokens + (opts?.maxTokens ?? ANSWER_ROOM) > local.contextSize) throw e
        console.warn('AI', `${p} failed before answering (${task}): the model on this computer answers instead`, e)
        return local.chat(prompt, onToken, opts)
      }
    },
  })
  return {
    chosen,
    /** something can take this task's jobs now */
    ready: (task: AiTask) => chosen(task) !== 'local' || o.hasLocal(),
    model: (task: AiTask): Model => ({
      needsLoad: () => chosen(task) === 'local' && !!o.local.needsLoad?.(),
      llm: async (signal) => {
        const p = chosen(task)
        const remote = p === 'local' ? undefined : o.remote(p, signal)
        return remote ? fallback(remote, task, p, signal) : o.local.llm(signal)
      },
    }),
  }
}
export type Router = ReturnType<typeof createRouter>
