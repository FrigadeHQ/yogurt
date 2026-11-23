import { ipcMain } from 'electron'
import { loadSettings, updateSettings } from '../settings'
import { AGENTS, AI_TASKS, isProvider, isTask, MAX_SERVER_CONTEXT, MIN_SERVER_CONTEXT, SERVER_CONTEXT, type AiStatus } from '../../shared/ai'
import { createRouter, type Model } from './router'
import { serverLlm, serverModels, serverUrl, type Server } from './server'
import type { Agents } from './agents'

const contextOf = (n: unknown) => (Number.isInteger(n) && (n as number) >= MIN_SERVER_CONTEXT && (n as number) <= MAX_SERVER_CONTEXT ? (n as number) : SERVER_CONTEXT)
const modelName = (x: unknown) => (typeof x === 'string' && x.trim() && x.length <= 200 ? x.trim() : undefined)

/**
 * Settings → AI models: what writes each task's text (shared/ai.ts), the person's own server and the agent apps. Returns the router
 * every caller of the notes model goes through. changed: a choice changed, so jobs waiting for a model may run now.
 */
export function hookAi(o: {
  file: string; local: Model; hasLocal: () => boolean; agents?: Agents; changed: () => void
  /** the server's key, kept with the system's keychain where it has one */
  seal: (plain: string) => string; open: (sealed: string) => string
}) {
  const saved = () => loadSettings(o.file)
  const key = (sealed?: string) => {
    if (!sealed) return
    try { return o.open(sealed) } catch (e) { console.warn('AI', "the server's key couldn't be read", e) }
  }
  const server = (): Server | undefined => {
    const s = saved().aiServer, url = serverUrl(s?.url), model = modelName(s?.model)
    return s && url && model ? { url, model, contextSize: contextOf(s.contextSize), key: key(s.key) } : undefined
  }
  const router = createRouter({
    local: o.local, hasLocal: o.hasLocal,
    choice: (task) => { const c = saved().ai?.[task]; return isProvider(c) ? c : 'local' },
    remote: (p, signal) => {
      if (p !== 'server') return o.agents?.llm(p, signal)
      const s = server()
      return s && serverLlm(s, signal)
    },
  })
  const status = (): AiStatus => {
    const s = saved().aiServer, url = serverUrl(s?.url)
    return {
      tasks: Object.fromEntries(AI_TASKS.map((t) => [t, router.chosen(t)])) as AiStatus['tasks'],
      server: s && url ? { url, model: s.model ?? '', contextSize: contextOf(s.contextSize), hasKey: !!s.key } : null,
      agents: AGENTS.map((a) => ({ id: a.id, name: a.name, found: !!o.agents?.found(a.id) })),
      local: o.hasLocal(),
    }
  }

  ipcMain.handle('ai:status', async () => { await o.agents?.refresh(); return status() })
  ipcMain.handle('ai:set-task', (_e, task: unknown, provider: unknown) => {
    if (!isTask(task) || !isProvider(provider)) throw new Error('Invalid AI choice')
    updateSettings(o.file, { ai: { ...saved().ai, [task]: provider === 'local' ? undefined : provider } })
    o.changed()
    return status()
  })
  /** null: no server. key: undefined keeps the saved one (for the same address only), '' removes it */
  ipcMain.handle('ai:set-server', (_e, v: unknown) => {
    if (v === null) { updateSettings(o.file, { aiServer: undefined }); o.changed(); return status() }
    const x = v as { url?: unknown; model?: unknown; contextSize?: unknown; key?: unknown }
    const url = serverUrl(x?.url), model = modelName(x?.model)
    if (!url || !model || (x.key !== undefined && (typeof x.key !== 'string' || x.key.length > 4000))) throw new Error('Invalid server')
    const was = saved().aiServer
    // a key is never sent to an address it wasn't given for
    const sealed = typeof x.key === 'string' ? (x.key.trim() ? o.seal(x.key.trim()) : undefined) : serverUrl(was?.url) === url ? was?.key : undefined
    updateSettings(o.file, { aiServer: { url, model, contextSize: contextOf(x.contextSize), ...(sealed ? { key: sealed } : {}) } })
    o.changed()
    return status()
  })
  /** Test connection: the models the server offers, with the key typed or the one saved for this address */
  ipcMain.handle('ai:server-models', async (_e, v: unknown) => {
    const x = v as { url?: unknown; key?: unknown }
    const url = serverUrl(x?.url)
    if (!url) return { error: 'address' as const }
    const was = saved().aiServer
    const k = typeof x.key === 'string' && x.key.trim() ? x.key.trim() : serverUrl(was?.url) === url ? key(was?.key) : undefined
    try { return { models: await serverModels({ url, key: k }) } } catch (e) {
      console.warn('AI', 'the server did not list its models', e)
      return { error: 'unreachable' as const, detail: e instanceof Error ? e.message.slice(0, 200) : '' }
    }
  })
  return router
}
