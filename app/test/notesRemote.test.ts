import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Llm } from '../src/main/notes/enhance'
import type { NotesModel } from '../src/main/notes/model'
import { remoteChat, remoteFirst, roughTokens, type NotesServer } from '../src/main/notes/remote'

const server: NotesServer = { url: 'http://notes.test/v1/', model: 'qwen' }

/** an OpenAI-style stream: each piece is one data line, split across chunks as a network would */
const sse = (pieces: Array<{ content?: string; reasoning_content?: string }>, cut = 7) => {
  const text = pieces.map((d) => `data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`).join('') + 'data: [DONE]\n\n'
  const bytes = new TextEncoder().encode(text)
  const chunks: Uint8Array[] = []
  for (let i = 0; i < bytes.length; i += cut) chunks.push(bytes.slice(i, i + cut))
  return new Response(new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(x); c.close() } }))
}

type Call = { url: string; init?: RequestInit }
const fakeFetch = (handle: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
  const calls: Call[] = []
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(url), init }); return handle(String(url), init) })
  return { f: f as unknown as typeof fetch, calls }
}

const localLlm = (answer = 'local answer'): Llm => ({
  contextSize: 32_768,
  count: async (t) => t.map((x) => x.length),
  chat: async (_p, onToken) => { onToken(answer); return answer },
  readAhead: async () => {},
})
const localModel = (llm = localLlm()) => {
  const m = { llm: vi.fn(async () => llm), unload: vi.fn(async () => {}), loaded: () => undefined, needsLoad: () => true }
  return m as unknown as NotesModel & { llm: ReturnType<typeof vi.fn> }
}

describe('remoteChat', () => {
  it('streams only the answer, without the reasoning or the blank lines after it', async () => {
    const { f, calls } = fakeFetch(() => sse([{ reasoning_content: 'thinking…' }, { content: '\n\n' }, { content: 'Hello' }, { content: ', world' }]))
    const got: string[] = []
    const text = await remoteChat(server, [{ role: 'user', content: 'hi' }], (t) => got.push(t), { maxTokens: 50, temperature: 0 }, f)
    expect(text).toBe('Hello, world')
    expect(got.join('')).toBe('Hello, world')
    expect(calls[0].url).toBe('http://notes.test/v1/chat/completions')
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({ model: 'qwen', stream: true, max_tokens: 50, temperature: 0 })
  })

  it('sends the key from its file, never from settings', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yogurt-key-'))
    writeFileSync(join(dir, 'key'), 'sk-test\n')
    const { f, calls } = fakeFetch(() => sse([{ content: 'ok' }]))
    await remoteChat({ ...server, keyFile: join(dir, 'key') }, [{ role: 'user', content: 'hi' }], () => {}, {}, f)
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-test')
  })

  it('fails on an error status', async () => {
    const { f } = fakeFetch(() => new Response('no', { status: 403 }))
    await expect(remoteChat(server, [{ role: 'user', content: 'hi' }], () => {}, {}, f)).rejects.toThrow('403')
  })
})

describe('remoteFirst', () => {
  const up = (answer: string) => fakeFetch((url) => (url.endsWith('/models') ? new Response('{}') : sse([{ content: answer }])))

  it('uses the model on this computer when no server is set', async () => {
    const local = localModel()
    const m = remoteFirst(local, () => undefined, { log: () => {} })
    expect(await (await m.llm()).chat('q', () => {})).toBe('local answer')
  })

  it('uses the server while it answers, with a rough count and no read ahead', async () => {
    const local = localModel()
    const { f } = up('from the server')
    const m = remoteFirst(local, () => server, { fetch: f, log: () => {} })
    const llm = await m.llm()
    expect(await llm.chat('q', () => {})).toBe('from the server')
    expect(llm.contextSize).toBe(32_768)
    expect(llm.readAhead).toBeUndefined()
    expect(await llm.count(['abcdef'])).toEqual([roughTokens('abcdef')])
    expect(local.llm).not.toHaveBeenCalled()
    expect(m.needsLoad()).toBe(false)
  })

  it('uses the model on this computer when the server is not answering, and checks again only after a minute', async () => {
    let t = 0
    const local = localModel()
    const { f, calls } = fakeFetch(() => { throw new Error('ECONNREFUSED') })
    const m = remoteFirst(local, () => server, { fetch: f, now: () => t, log: () => {} })
    expect(await (await m.llm()).chat('q', () => {})).toBe('local answer')
    await m.llm()
    expect(calls.filter((c) => c.url.endsWith('/models'))).toHaveLength(1)
    t = 61_000
    await m.llm()
    expect(calls.filter((c) => c.url.endsWith('/models'))).toHaveLength(2)
  })

  it('asks the model on this computer when the server fails before its first word', async () => {
    const local = localModel()
    const { f } = fakeFetch((url) => (url.endsWith('/models') ? new Response('{}') : new Response('busy', { status: 503 })))
    const logs: string[] = []
    const m = remoteFirst(local, () => server, { fetch: f, log: (l) => logs.push(l) })
    const got: string[] = []
    expect(await (await m.llm()).chat('q', (x) => got.push(x))).toBe('local answer')
    expect(got).toEqual(['local answer'])
    expect(logs.at(-1)).toMatch(/failed .*503.*this computer/)
    // marked down: the next job goes straight to this computer
    await m.llm()
    expect(local.llm).toHaveBeenCalledTimes(2)
  })

  it('does not start over on this computer once the server has written words', async () => {
    const local = localModel()
    // the first read gets a word, the next one finds the connection gone
    const broken = () => {
      let reads = 0
      return new Response(new ReadableStream({
        pull(c) {
          if (reads++ === 0) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Half' } }] })}\n\n`))
          else c.error(new Error('connection reset'))
        },
      }))
    }
    const { f } = fakeFetch((url) => (url.endsWith('/models') ? new Response('{}') : broken()))
    const m = remoteFirst(local, () => server, { fetch: f, log: () => {} })
    await expect((await m.llm()).chat('q', () => {})).rejects.toThrow('connection reset')
    expect(local.llm).not.toHaveBeenCalled()
  })

  it('passes the earlier turns of a conversation to the server', async () => {
    const { f, calls } = up('ok')
    const m = remoteFirst(localModel(), () => server, { fetch: f, log: () => {} })
    await (await m.llm()).chat('third', () => {}, { before: ['first', 'second'] })
    const body = JSON.parse(String(calls.find((c) => c.url.endsWith('/chat/completions'))?.init?.body))
    expect(body.messages).toEqual([
      { role: 'user', content: 'first' }, { role: 'assistant', content: 'second' }, { role: 'user', content: 'third' },
    ])
  })
})
