import { readFileSync } from 'node:fs'
import type { Llm } from './enhance'
import type { NotesModel } from './model'

/**
 * A notes model on another computer the person runs themselves (an OpenAI-compatible server such as LiteLLM, vLLM,
 * llama.cpp's server or Ollama), tried first; the model on this computer is the fallback. Off unless settings.json
 * has notesServer. The key is read from a file so it never sits in settings.json.
 */
export type NotesServer = {
  /** off keeps the address and model for later; missing means on (a hand-written settings.json) */
  enabled?: boolean
  /** the API base, ending in /v1 */
  url: string
  model: string
  /** a file holding the bearer key, if the server wants one */
  keyFile?: string
  /** tokens a prompt may use; the local model's window by default, so a job that falls back still fits */
  contextSize?: number
}

/** the server to try first, or none: switched off, or no address or model yet */
export const activeServer = (s?: NotesServer): NotesServer | undefined =>
  s && s.enabled !== false && s.url?.trim() && s.model?.trim() ? s : undefined

/** what Settings shows; the key itself never goes back to the window */
export type NotesServerView = { enabled: boolean; url: string; model: string; hasKey: boolean }
/** a connection check: the models the server offers, or why it couldn't say */
export type NotesServerCheck =
  | { ok: true; models: string[] }
  | { ok: false; reason: 'address' | 'unreachable' | 'refused' | 'status'; status?: number }

/** a rough count, high on purpose: about 3 characters a token keeps a prompt inside the window on any tokenizer */
export const roughTokens = (text: string) => Math.ceil(text.length / 3) + 1

type Fetch = typeof fetch

const keyOf = (s: NotesServer) => {
  if (!s.keyFile) return undefined
  try { return readFileSync(s.keyFile, 'utf8').trim() || undefined } catch { return undefined }
}
const headers = (s: NotesServer): Record<string, string> => {
  const key = keyOf(s)
  return { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }
}
const base = (s: NotesServer) => s.url.replace(/\/+$/, '')

/** an http(s) address, without a trailing slash; anything else is not an address */
export const cleanUrl = (url: string): string | undefined => {
  try {
    const u = new URL(url.trim())
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString().replace(/\/+$/, '') : undefined
  } catch {
    return undefined
  }
}

/** Settings → Test: asks the server for its models with the key being typed, or the saved one when none is */
export async function checkServer(url: string, key: string | undefined, ms = 5000, f: Fetch = fetch): Promise<NotesServerCheck> {
  const base = cleanUrl(url)
  if (!base) return { ok: false, reason: 'address' }
  try {
    const r = await f(`${base}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(ms) })
    if (r.status === 401 || r.status === 403) return { ok: false, reason: 'refused', status: r.status }
    if (!r.ok) return { ok: false, reason: 'status', status: r.status }
    const body = await r.json().catch(() => ({})) as { data?: Array<{ id?: unknown }> }
    const models = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string').slice(0, 200)
    return { ok: true, models }
  } catch {
    return { ok: false, reason: 'unreachable' }
  }
}

/** the server answers its model list within ms */
export async function reachable(s: NotesServer, ms = 3000, f: Fetch = fetch): Promise<boolean> {
  try {
    const r = await f(`${base(s)}/models`, { headers: headers(s), signal: AbortSignal.timeout(ms) })
    return r.ok
  } catch {
    return false
  }
}

/** one streamed answer: only the answer's words reach onToken, never the model's reasoning */
export async function remoteChat(s: NotesServer, messages: { role: string; content: string }[], onToken: (t: string) => void,
  o: { maxTokens?: number; temperature?: number; signal?: AbortSignal } = {}, f: Fetch = fetch): Promise<string> {
  const r = await f(`${base(s)}/chat/completions`, {
    method: 'POST',
    headers: headers(s),
    signal: o.signal,
    body: JSON.stringify({ model: s.model, messages, stream: true, ...(o.maxTokens ? { max_tokens: o.maxTokens } : {}), ...(o.temperature !== undefined ? { temperature: o.temperature } : {}) }),
  })
  if (!r.ok || !r.body) throw new Error(`notes server answered ${r.status}`)
  const decoder = new TextDecoder()
  let pending = '', text = ''
  const take = (line: string) => {
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') return
    let piece: unknown
    try { piece = JSON.parse(data).choices?.[0]?.delta?.content } catch { return }
    if (typeof piece !== 'string' || !piece) return
    // the answer starts at its first word: some servers send the blank lines that followed the reasoning
    if (!text) piece = piece.replace(/^\s+/, '')
    if (!piece) return
    text += piece
    onToken(piece as string)
  }
  for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
    pending += decoder.decode(chunk, { stream: true })
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const l of lines) take(l.trim())
  }
  take(pending.trim())
  return text
}

/** before: earlier prompts and answers, in turn */
const conversation = (prompt: string, before: string[] = []) =>
  [...before.map((content, i) => ({ role: i % 2 ? 'assistant' : 'user', content })), { role: 'user', content: prompt }]

/**
 * The notes model with a server tried first. The server is checked at most once a minute; while it answers, notes,
 * Ask and folder suggestions use it and the local model isn't loaded. A chat that fails before its first word is
 * asked of the local model instead, so nothing is lost when the server goes away mid-job.
 */
export function remoteFirst(local: NotesModel, server: () => NotesServer | undefined,
  o: { fetch?: Fetch; now?: () => number; checkEveryMs?: number; log?: (m: string) => void } = {}): NotesModel {
  const f = o.fetch ?? fetch, now = o.now ?? Date.now, every = o.checkEveryMs ?? 60_000, log = o.log ?? ((m) => console.info('NOTES', m))
  let last: { url: string; at: number; up: boolean } | undefined
  const up = async (s: NotesServer) => {
    if (last && last.url === s.url && now() - last.at < every) return last.up
    const ok = await reachable(s, 3000, f)
    if (ok !== last?.up || last?.url !== s.url) log(ok ? `using the notes server ${s.url} (${s.model})` : `the notes server ${s.url} isn't answering: using the model on this computer`)
    last = { url: s.url, at: now(), up: ok }
    return ok
  }
  const down = (s: NotesServer, e: unknown) => {
    log(`the notes server ${s.url} failed (${e instanceof Error ? e.message : String(e)}): using the model on this computer`)
    last = { url: s.url, at: now(), up: false }
  }

  return {
    ...local,
    async llm(signal?: AbortSignal): Promise<Llm> {
      const s = server()
      if (!s || !(await up(s))) return local.llm(signal)
      return {
        contextSize: s.contextSize ?? 32_768,
        count: async (texts) => texts.map(roughTokens),
        chat: async (prompt, onToken, opts) => {
          let wrote = false
          try {
            return await remoteChat(s, conversation(prompt, opts?.before), (t) => { wrote = true; onToken(t) },
              { maxTokens: opts?.maxTokens, temperature: opts?.temperature, signal }, f)
          } catch (e) {
            if (wrote || signal?.aborted) throw e
            down(s, e)
            return (await local.llm(signal)).chat(prompt, onToken, opts)
          }
        },
        // no readAhead: the server keeps its own prompt cache
      }
    },
    needsLoad: () => (server() && last?.up ? false : local.needsLoad()),
  }
}
