import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Llm } from '../src/main/notes/enhance'

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => any>())
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => handlers.set(channel, fn) } }))

import { REASONING_ROOM, serverLlm, serverModels, serverUrl } from '../src/main/ai/server'
import { createRouter } from '../src/main/ai/router'
import { hookAi } from '../src/main/ai'
import { createQueue } from '../src/main/notes/queue'

const dirs: string[] = []
afterEach(() => { dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })); handlers.clear(); vi.unstubAllEnvs() })
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'yogurt-ai-')); dirs.push(d); return d }

/** a server that streams these pieces as server-sent events; the request it got is kept */
function sse(pieces: string[], o: { status?: number; body?: string; stall?: boolean } = {}) {
  const requests: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    requests.push({ url, init })
    if (o.status) return new Response(o.body ?? '', { status: o.status })
    const enc = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      async start(c) {
        for (const p of pieces) c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`))
        if (o.stall) { await new Promise((_r, reject) => init.signal?.addEventListener('abort', () => { c.error(new DOMException('aborted', 'AbortError')); reject(new Error('aborted')) })) ; return }
        c.enqueue(enc.encode('data: [DONE]\n\n'))
        c.close()
      },
    })
    return new Response(body, { status: 200 })
  }) as unknown as typeof fetch
  return { fetchImpl, requests }
}

describe('your server', () => {
  it('takes only http and https addresses', () => {
    expect(serverUrl('http://localhost:1234/v1/')).toBe('http://localhost:1234/v1')
    expect(serverUrl(' https://api.example.com/v1 ')).toBe('https://api.example.com/v1')
    for (const bad of ['ftp://x', 'file:///etc/passwd', 'localhost:1234', '', 42, null]) expect(serverUrl(bad)).toBeUndefined()
  })
  it('streams an answer, with earlier turns, room to think, the key, and no leading blank', async () => {
    const s = sse(['\n ', 'Hello', ' there'])
    const llm = serverLlm({ url: 'http://localhost:1234/v1', model: 'qwen', contextSize: 65_536, key: 'secret' }, undefined, s.fetchImpl)
    const tokens: string[] = []
    expect(await llm.chat('Title?', (t) => tokens.push(t), { maxTokens: 40, temperature: 0.3, before: ['Notes prompt', 'Notes'] })).toBe('Hello there')
    expect(tokens).toEqual(['Hello', ' there'])
    expect(s.requests[0].url).toBe('http://localhost:1234/v1/chat/completions')
    expect((s.requests[0].init.headers as Record<string, string>).authorization).toBe('Bearer secret')
    expect(JSON.parse(String(s.requests[0].init.body))).toEqual({ model: 'qwen', stream: true, max_tokens: 40 + REASONING_ROOM, temperature: 0.3, messages: [
      { role: 'user', content: 'Notes prompt' }, { role: 'assistant', content: 'Notes' }, { role: 'user', content: 'Title?' }] })
    // no tokenizer: a guess that never undercounts plain text
    expect(llm.contextSize).toBe(65_536)
    expect((await llm.count(['abcdef', '会議']))).toEqual([2, 2])
  })
  it("says what the server said when it fails, never the key, and ends a stopped answer where it is", async () => {
    const bad = serverLlm({ url: 'http://x', model: 'm', contextSize: 8192, key: 'secret' }, undefined, sse([], { status: 401, body: '{"error":{"message":"invalid api key"}}' }).fetchImpl)
    const e = await bad.chat('q', () => {}).catch((x: Error) => x)
    expect(String(e)).toContain('401: invalid api key')
    expect(String(e)).not.toContain('secret')
    const stop = new AbortController()
    const slow = serverLlm({ url: 'http://x', model: 'm', contextSize: 8192 }, stop.signal, sse(['Half'], { stall: true }).fetchImpl)
    const answer = slow.chat('q', () => stop.abort())
    expect(await answer).toBe('Half')
  })
  it('lists its models for Test connection', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ data: [{ id: 'b' }, { id: 'a' }, { id: 'b' }, {}] }))) as unknown as typeof fetch
    expect(await serverModels({ url: 'http://x/v1' }, fetchImpl)).toEqual(['a', 'b'])
  })
})

describe('each task its model', () => {
  const answering = (text: string, o: { fail?: 'before' | 'after'; context?: number } = {}): Llm & { asked: string[] } => {
    const asked: string[] = []
    return {
      asked, contextSize: o.context ?? 32_000, count: async (xs) => xs.map((x) => x.length),
      chat: async (prompt, onToken) => { asked.push(prompt); if (o.fail === 'before') throw new Error('down'); onToken(text); if (o.fail === 'after') throw new Error('cut'); return text },
    }
  }
  const setup = (o: { choice?: string; remote?: Llm; hasLocal?: boolean; localContext?: number }) => {
    const local = answering('local', { context: o.localContext })
    const router = createRouter({
      local: { llm: async () => local, needsLoad: () => true }, hasLocal: () => o.hasLocal ?? true,
      choice: () => (o.choice ?? 'local') as 'local', remote: () => o.remote,
    })
    return { router, local }
  }
  it('uses the choice while it can be used, the model on this computer otherwise', async () => {
    const remote = answering('remote')
    const s = setup({ choice: 'server', remote })
    expect(s.router.chosen('notes')).toBe('server')
    expect(s.router.model('notes').needsLoad?.()).toBe(false)
    expect(await (await s.router.model('notes').llm()).chat('q', () => {})).toBe('remote')
    // chosen, then not set up (the server was removed): this computer's model again
    const gone = setup({ choice: 'server' })
    expect(gone.router.chosen('ask')).toBe('local')
    expect(gone.router.model('ask').needsLoad?.()).toBe(true)
    expect(await (await gone.router.model('ask').llm()).chat('q', () => {})).toBe('local')
  })
  it('is ready for a task with no model on this computer only when something else takes it', () => {
    expect(setup({ choice: 'server', remote: answering('r'), hasLocal: false }).router.ready('notes')).toBe(true)
    expect(setup({ hasLocal: false }).router.ready('notes')).toBe(false)
    expect(setup({}).router.ready('folders')).toBe(true)
  })
  it('hands a question that failed before its first word to this computer, when there is a model and it fits', async () => {
    const s = setup({ choice: 'server', remote: answering('', { fail: 'before' }) })
    const tokens: string[] = []
    expect(await (await s.router.model('notes').llm()).chat('q', (t) => tokens.push(t))).toBe('local')
    expect(tokens).toEqual(['local'])
    expect(s.local.asked).toEqual(['q'])
    const cut = setup({ choice: 'server', remote: answering('part', { fail: 'after' }) })
    await expect((await cut.router.model('notes').llm()).chat('q', () => {})).rejects.toThrow('cut')
    expect(cut.local.asked).toEqual([])
    const none = setup({ choice: 'server', remote: answering('', { fail: 'before' }), hasLocal: false })
    await expect((await none.router.model('notes').llm()).chat('q', () => {})).rejects.toThrow('down')
    // too long for this computer's model: the job fails as it would have
    const long = setup({ choice: 'server', remote: answering('', { fail: 'before' }), localContext: 100 })
    await expect((await long.router.model('notes').llm()).chat('x'.repeat(50), () => {}, { maxTokens: 60 })).rejects.toThrow('down')
    expect(long.local.asked).toEqual([])
  })
})

describe('Settings → AI models', () => {
  const hook = () => {
    const file = join(temp(), 'settings.json')
    const changed = vi.fn()
    const local: Llm = { contextSize: 8192, count: async (xs) => xs.map((x) => x.length), chat: async () => 'local' }
    const router = hookAi({ file, local: { llm: async () => local }, hasLocal: () => true, changed, seal: (p) => `sealed:${p}`, open: (s) => s.replace(/^sealed:/, '') })
    const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args)
    return { file, changed, router, call, saved: () => JSON.parse(readFileSync(file, 'utf8')) }
  }
  it('saves a choice per task, and only ones that exist', async () => {
    const s = hook()
    const status = await s.call('ai:status')
    expect(status).toMatchObject({ tasks: { notes: 'local', ask: 'local', folders: 'local' }, server: null, local: true })
    // the server picked before it is saved: this computer's model, until it is
    expect((await s.call('ai:set-task', 'ask', 'server')).tasks.ask).toBe('local')
    expect(s.saved().ai).toEqual({ ask: 'server' })
    expect(s.changed).toHaveBeenCalled()
    await s.call('ai:set-server', { url: 'http://localhost:1234/v1', model: 'qwen', contextSize: 32_768 })
    expect((await s.call('ai:status')).tasks).toEqual({ notes: 'local', ask: 'server', folders: 'local' })
    expect((await s.call('ai:set-task', 'ask', 'local')).tasks.ask).toBe('local')
    expect(s.saved().ai).toEqual({})
    await expect(async () => s.call('ai:set-task', 'ask', 'gpt')).rejects.toThrow()
    await expect(async () => s.call('ai:set-task', 'titles', 'local')).rejects.toThrow()
  })
  it('keeps the key sealed, never shows it, and never sends it to another address', async () => {
    const s = hook()
    const status = await s.call('ai:set-server', { url: 'http://localhost:1234/v1/', model: 'qwen', contextSize: 65_536, key: 'secret' })
    expect(status.server).toEqual({ url: 'http://localhost:1234/v1', model: 'qwen', contextSize: 65_536, hasKey: true })
    expect(JSON.stringify(status)).not.toContain('secret')
    expect(s.saved().aiServer.key).toBe('sealed:secret')
    // the same address again, no key typed: the saved one stays
    await s.call('ai:set-server', { url: 'http://localhost:1234/v1', model: 'llama', contextSize: 1 })
    expect(s.saved().aiServer).toEqual({ url: 'http://localhost:1234/v1', model: 'llama', contextSize: 32_768, key: 'sealed:secret' })
    // another address: the key doesn't follow
    await s.call('ai:set-server', { url: 'https://elsewhere.example/v1', model: 'llama', contextSize: 32_768 })
    expect(s.saved().aiServer.key).toBeUndefined()
    await expect(async () => s.call('ai:set-server', { url: 'file:///etc', model: 'x', contextSize: 32_768 })).rejects.toThrow()
    expect((await s.call('ai:set-server', null)).server).toBeNull()
    expect((await s.call('ai:server-models', { url: 'nope' }))).toEqual({ error: 'address' })
  })
  it("picks the server once it is saved; a task left on it without one is back on this computer", async () => {
    const s = hook()
    await s.call('ai:set-task', 'notes', 'server')
    expect(s.router.chosen('notes')).toBe('local')
    await s.call('ai:set-server', { url: 'http://localhost:1234/v1', model: 'qwen', contextSize: 32_768 })
    expect(s.router.chosen('notes')).toBe('server')
    expect((await s.router.model('notes').llm()).contextSize).toBe(32_768)
  })
})

describe('the queue', () => {
  it('runs a job once a model can take its kind', async () => {
    let notes = false
    const ran: string[] = []
    const queue = createQueue({ recording: () => false, smallMac: false, modelReady: (kind) => kind === 'chat' || notes })
    const enhance = queue.enqueue(async () => { ran.push('enhance') }, 'enhance')
    await queue.enqueue(async () => { ran.push('chat') }, 'chat')
    expect(ran).toEqual(['chat'])
    notes = true
    queue.modelArrived()
    await enhance
    expect(ran).toEqual(['chat', 'enhance'])
  })
})
