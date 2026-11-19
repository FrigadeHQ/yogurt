import type { Llm } from '../notes/enhance'
import { guess } from '../chat'

export type Server = { url: string; model: string; contextSize: number; key?: string }
type Fetch = typeof globalThis.fetch

/** reasoning models spend tokens thinking before they answer: room for that on top of what the answer may take */
export const REASONING_ROOM = 2048

/** only http and https addresses, like "http://localhost:1234/v1"; undefined for anything else */
export function serverUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length > 2000) return
  try {
    const u = new URL(raw.trim())
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href.replace(/\/+$/, '') : undefined
  } catch { return undefined }
}
const endpoint = (url: string, path: string) => `${url.replace(/\/+$/, '')}/${path}`
const headers = (key?: string) => ({ 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) })

/** what went wrong, from the server's own words where it gives them: never the key */
async function failure(res: Response): Promise<Error> {
  const body = await res.text().catch(() => '')
  let said = ''
  try { said = JSON.parse(body)?.error?.message ?? '' } catch { said = body }
  return new Error(`the server answered ${res.status}${said ? `: ${String(said).slice(0, 200)}` : ''}`)
}

/** the data lines of a server-sent event stream */
async function* events(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let rest = ''
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    rest += decoder.decode(chunk, { stream: true })
    for (let i = rest.indexOf('\n'); i >= 0; i = rest.indexOf('\n')) {
      const line = rest.slice(0, i).trim()
      rest = rest.slice(i + 1)
      if (line.startsWith('data:')) yield line.slice(5).trim()
    }
  }
}

/** The models the server offers (Test connection), from GET /models */
export async function serverModels(s: Pick<Server, 'url' | 'key'>, fetchImpl: Fetch = fetch): Promise<string[]> {
  const res = await fetchImpl(endpoint(s.url, 'models'), { headers: headers(s.key), signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw await failure(res)
  const ids = ((await res.json()) as { data?: Array<{ id?: unknown }> }).data?.map((m) => m.id).filter((id): id is string => typeof id === 'string') ?? []
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b))
}

/**
 * The person's own server as the notes model: OpenAI-compatible /chat/completions, streamed. Tokens are a safe guess
 * (no tokenizer here), and nothing is read ahead: the server keeps its own cache.
 */
export function serverLlm(s: Server, signal?: AbortSignal, fetchImpl: Fetch = fetch): Llm {
  return {
    contextSize: s.contextSize,
    count: async (texts) => texts.map(guess),
    chat: async (prompt, onToken, o) => {
      const messages = [...(o?.before ?? []).map((content, i) => ({ role: i % 2 ? 'assistant' : 'user', content })), { role: 'user', content: prompt }]
      const res = await fetchImpl(endpoint(s.url, 'chat/completions'), {
        method: 'POST', headers: headers(s.key), signal,
        body: JSON.stringify({ model: s.model, messages, stream: true, ...(o?.maxTokens ? { max_tokens: o.maxTokens + REASONING_ROOM } : {}), ...(o?.temperature !== undefined ? { temperature: o.temperature } : {}) }),
      })
      if (!res.ok || !res.body) throw await failure(res)
      let out = ''
      try {
        for await (const data of events(res.body)) {
          if (data === '[DONE]') break
          let event: { error?: { message?: string }; choices?: Array<{ delta?: { content?: unknown } }> }
          try { event = JSON.parse(data) } catch { continue }
          if (event.error) throw new Error(`the server stopped: ${String(event.error.message ?? '').slice(0, 200)}`)
          const text = event.choices?.[0]?.delta?.content
          // the answer starts with its first word, as the local model's does
          if (typeof text !== 'string' || (!out && !text.trim())) continue
          const piece = out ? text : text.trimStart()
          out += piece
          onToken(piece)
        }
      } catch (e) {
        // like the local model: a stopped answer ends where it is, no error
        if (signal?.aborted) return out
        throw e
      }
      return out
    },
  }
}
