import { describe, expect, it } from 'vitest'
import { connect } from 'node:net'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { MCP_TOOLS } from '../src/main/mcp/server'
import { createAiApps } from '../src/main/mcp/tokens'
import { serveMcp } from '../src/main/mcp/socket'
import { mcpAddress } from '../src/main/mcp/paths'
import { setup, call } from './mcpRig'

const reading = MCP_TOOLS.filter((t) => (t.annotations as { readOnlyHint: boolean }).readOnlyHint).map((t) => t.name)
const changing = MCP_TOOLS.map((t) => t.name).filter((n) => !reading.includes(n))
/** arguments that fit any tool, so a refusal can only come from a gate and never from a bad argument */
const args = (id: string) => ({ id, query: 'travel', question: 'What did we decide?', date: '2026-11-21', folder: 'x', name: 'x', title: 'x', markdown: 'x', started_at: '2026-11-01T00:00:00Z', summary: 'x', meetings: [] })
const ADD = 'Settings, AI apps, Add an app'
const ALLOW = '"Let AI apps make changes"'
const claude = { name: 'Claude' }

describe('keys required: every tool, reading and changing, is behind the key first', () => {
  it('covers both kinds of tool', () => {
    expect(reading).toContain('ask')
    expect(reading).toContain('list_trash')
    expect(changing).toContain('create_folder')
    expect(changing).toContain('import_meetings')
  })
  it.each(MCP_TOOLS.map((t) => t.name))('%s: an app without a key gets nothing and changes nothing, even with changes allowed', async (name) => {
    const { mcp, store, older, calls, logs } = setup({ requiresKey: true, changes: true })
    const before = JSON.stringify([store.meetings({ limit: 10 }), store.folders(), store.notes(older.id)])
    const r = await call(mcp, name, args(older.id))
    expect(r).toEqual({ isError: true, text: expect.stringContaining(ADD) })
    expect(r.text).not.toMatch(/Budget|Launch|travel|Ann Lee/)
    expect(JSON.stringify([store.meetings({ limit: 10 }), store.folders(), store.notes(older.id)])).toBe(before)
    // the app's own functions never ran, and an attempt to change is in main.log by id
    expect(calls).toEqual([])
    expect(logs).toEqual(reading.includes(name) ? [] : [`${name} refused: no key ${older.id}`])
  })
  it.each(changing)('%s: a key does not unlock a change while "Let AI apps make changes" is off', async (name) => {
    const { mcp, store, older, calls, logs } = setup({ requiresKey: true, changes: false })
    const before = JSON.stringify([store.meetings({ limit: 10 }), store.folders(), store.notes(older.id)])
    expect(await call(mcp, name, args(older.id), claude)).toEqual({ isError: true, text: expect.stringContaining(ALLOW) })
    expect(JSON.stringify([store.meetings({ limit: 10 }), store.folders(), store.notes(older.id)])).toBe(before)
    expect(calls).toEqual([])
    expect(logs).toEqual([`${name} refused: changes off ${older.id}`])
  })
  it.each(reading)('%s: a key is enough to read, with changes off', async (name) => {
    const { mcp, older } = setup({ requiresKey: true, changes: false })
    const r = await call(mcp, name, args(older.id), claude)
    expect(r.text).not.toContain(ADD)
    expect(r.text).not.toContain(ALLOW)
  })
  it('a key with changes allowed reads and changes, and the log says what was done by id only', async () => {
    const { mcp, store, older, logs } = setup({ requiresKey: true, changes: true })
    expect((await call(mcp, 'list_meetings', {}, claude)).isError).toBe(false)
    const made = await call(mcp, 'create_folder', { name: 'Sales' }, claude)
    expect(made.isError).toBe(false)
    expect(store.folders().map((f) => f.name)).toEqual(['Sales'])
    expect((await call(mcp, 'rename_meeting', { id: older.id, title: 'Renamed' }, claude)).isError).toBe(false)
    expect(store.meeting(older.id)!.title).toBe('Renamed')
    expect(logs).toContain(`rename_meeting ok ${older.id}`)
    expect(logs.join('\n')).not.toMatch(/Sales|Renamed|Claude/)
  })
  it('initialize, ping and the list of tools still answer without a key, so an app can tell the person what to do', async () => {
    const { mcp } = setup({ requiresKey: true })
    expect(await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).toMatchObject({ result: { serverInfo: { name: 'yogurt' } } })
    expect(await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'ping' })).toEqual({ jsonrpc: '2.0', id: 2, result: {} })
    expect(await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' })).toMatchObject({ result: { tools: expect.any(Array) } })
  })
  it('with AI apps turned off altogether, the off message comes before the key one', async () => {
    const { mcp } = setup({ enabled: false, requiresKey: true, changes: true })
    expect((await call(mcp, 'list_meetings')).text).toContain('connecting AI apps turned off')
    expect((await call(mcp, 'create_folder', { name: 'Sales' })).text).toContain('connecting AI apps turned off')
  })
})

describe('keys not required (Only apps added here is off): only the changes switch holds', () => {
  it('any app reads, and changes only once the switch is on', async () => {
    const { mcp, store, allowChanges } = setup({ requiresKey: false, changes: false })
    expect((await call(mcp, 'list_meetings')).isError).toBe(false)
    expect(await call(mcp, 'create_folder', { name: 'Sales' })).toMatchObject({ isError: true, text: expect.stringContaining(ALLOW) })
    allowChanges(true)
    expect((await call(mcp, 'create_folder', { name: 'Sales' })).isError).toBe(false)
    expect(store.folders().map((f) => f.name)).toEqual(['Sales'])
  })
})

// the whole chain: a connection, its key line, Settings' apps, the server's gates
describe('over the socket, keys and the changes switch work together', () => {
  it('no key, a wrong key, a malformed key and a removed key are refused for reading and changing; a valid key follows the switch', async () => {
    const { mcp, dir, store, allowChanges } = setup({ requiresKey: true, changes: true })
    // a stand-in keychain, like the one in mcpTokens.test.ts
    const apps = createAiApps({ file: join(dir, 'settings.json'), seal: (p) => `s:${p}`, open: (s) => s.slice(2) })
    const hermes = apps.add('Hermes')!
    const path = mcpAddress(process.platform, dir, randomBytes(8).toString('hex'))
    const server = await serveMcp(path, mcp, () => {}, (t) => apps.check(t))
    const socks: Array<ReturnType<typeof connect>> = []
    const open = (token?: string) => {
      const sock = connect(path); socks.push(sock)
      const replies = new Map<number, { result: { content: Array<{ text: string }>; isError?: boolean } }>()
      let buf = '', next = 1
      sock.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); replies.set(m.id, m); buf = buf.slice(i + 1) } })
      if (token !== undefined) sock.write(JSON.stringify({ jsonrpc: '2.0', method: 'yogurt/auth', params: { token } }) + '\n')
      const tool = async (name: string, a: Record<string, unknown> = {}) => {
        const id = next++
        sock.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: a } }) + '\n')
        await expect.poll(() => replies.has(id)).toBe(true)
        const r = replies.get(id)!.result
        return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError }
      }
      return { tool, closed: new Promise<void>((r) => sock.on('close', () => r())) }
    }
    try {
      const strangers = [open(), open('yog_' + 'z'.repeat(43)), open('not a key')]
      for (const s of strangers) {
        expect(await s.tool('list_meetings')).toMatchObject({ isError: true, text: expect.stringContaining(ADD) })
        expect(await s.tool('ask', { question: 'What did we decide?' })).toMatchObject({ isError: true, text: expect.stringContaining(ADD) })
        expect(await s.tool('create_folder', { name: 'Sales' })).toMatchObject({ isError: true, text: expect.stringContaining(ADD) })
      }
      expect(store.folders()).toEqual([])

      const app = open(hermes.token)
      expect((await app.tool('list_meetings')).isError).toBe(false)
      expect((await app.tool('create_folder', { name: 'Sales' })).isError).toBe(false)
      expect(store.folders().map((f) => f.name)).toEqual(['Sales'])
      // the switch decides for a connected app: reading stays, changing stops
      allowChanges(false)
      expect((await app.tool('list_meetings')).isError).toBe(false)
      expect(await app.tool('create_folder', { name: 'Hiring' })).toMatchObject({ isError: true, text: expect.stringContaining(ALLOW) })
      expect(store.folders().map((f) => f.name)).toEqual(['Sales'])
      allowChanges(true)

      // removed in Settings: the open session ends, and the same key is a stranger's from then on
      expect(apps.remove(hermes.app.id)).toBe(true)
      server.drop(hermes.app.id)
      await app.closed
      const again = open(hermes.token)
      expect(await again.tool('list_meetings')).toMatchObject({ isError: true, text: expect.stringContaining(ADD) })
      expect(await again.tool('create_folder', { name: 'Hiring' })).toMatchObject({ isError: true, text: expect.stringContaining(ADD) })
      expect(store.folders().map((f) => f.name)).toEqual(['Sales'])
    } finally { socks.forEach((s) => s.end()); await server.close() }
  })
})
