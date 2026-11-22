import { describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { MCP_TOOLS, type Mcp } from '../src/main/mcp/server'
import { setup, call, json } from './mcpRig'
import { serveMcp } from '../src/main/mcp/socket'
import { mcpAddress } from '../src/main/mcp/paths'
import { randomBytes } from 'node:crypto'

describe('the MCP server', () => {
  it('says who it is and that it has tools, in the protocol version the app asked for when it knows it', async () => {
    const { mcp } = setup()
    const r = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-ai', version: '1' } } })
    expect(r).toMatchObject({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'yogurt', version: '0.1.0' } } })
    const odd = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } }) as { result: { protocolVersion: string } }
    expect(odd.result.protocolVersion).toBe('2025-06-18')
  })
  it('lists its tools: the reading ones read only, the rest marked as changes, and removing or replacing ones as destructive', async () => {
    const { mcp } = setup()
    const r = await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' }) as { result: { tools: Array<{ name: string; annotations: { readOnlyHint: boolean; destructiveHint: boolean } }> } }
    const tools = r.result.tools
    const reading = ['list_folders', 'list_meetings', 'get_meeting', 'get_transcript', 'search', 'ask', 'list_people', 'upcoming_meetings', 'calendar_day', 'list_trash', 'get_settings', 'export_meeting', 'get_audio']
    expect(tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name)).toEqual(reading)
    expect(tools.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name)).toEqual(['create_folder', 'rename_folder', 'delete_folder', 'add_to_folder', 'remove_from_folder',
      'accept_folder_suggestion', 'dismiss_folder_suggestion', 'rename_meeting', 'set_attendees', 'link_calendar_event', 'unlink_calendar_event', 'trash_meeting', 'restore_meeting',
      'set_my_notes', 'set_summary', 'rewrite_summary', 'start_recording', 'pause_recording', 'resume_recording', 'stop_recording', 'set_custom_words', 'set_spoken_language',
      'set_summary_language', 'create_meeting', 'import_meetings'])
    expect(tools.filter((t) => t.annotations.destructiveHint).map((t) => t.name)).toEqual(['delete_folder', 'set_attendees', 'trash_meeting', 'set_my_notes', 'set_summary', 'rewrite_summary', 'stop_recording', 'set_custom_words'])
    // never anything that deletes for good
    expect(tools.map((t) => t.name).filter((n) => /empty|purge|delete_meeting|delete_audio|forever/.test(n))).toEqual([])
    expect(MCP_TOOLS).toEqual(tools)
  })
  it("tells other apps' models about the Mac on a Mac, and about Ogg files on Windows and Linux", async () => {
    const audioText = async (platform?: string) => {
      const { mcp } = setup({ platform })
      const init = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) as { result: { instructions: string } }
      const list = await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' }) as { result: { tools: Array<{ name: string; description: string }> } }
      return [init.result.instructions, list.result.tools.find((t) => t.name === 'get_audio')!.description]
    }
    const mac = "A meeting's recording as files on this Mac: one per side (track me: the person's microphone; them: the other side of the call), AAC in .m4a. Gives paths, which apps on this Mac can open."
    const here = await audioText()
    expect(here).toEqual([expect.stringMatching(/^Yogurt holds the person's meeting notes, transcripts and recordings on this Mac\. Use list_meetings or search to find a meeting, then get_meeting, get_transcript or get_audio\./), mac])
    expect(await audioText('darwin')).toEqual(here)
    for (const p of ['win32', 'linux']) {
      const [instructions, audio] = await audioText(p)
      expect(instructions).toContain('on this computer.')
      expect(audio).toContain('Ogg Opus in .ogg')
      expect(`${instructions} ${audio}`).not.toMatch(/this Mac/)
    }
  }, 120_000) // four databases: under a second on a Mac, but up to ~40 s on GitHub's Windows runners
  it('answers notifications with nothing, pings with an empty result, and anything else with method not found', async () => {
    const { mcp } = setup()
    expect(await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull()
    expect(await mcp.handle({ jsonrpc: '2.0', id: 4, method: 'ping' })).toEqual({ jsonrpc: '2.0', id: 4, result: {} })
    expect(await mcp.handle({ jsonrpc: '2.0', id: 5, method: 'resources/write' })).toMatchObject({ id: 5, error: { code: -32601 } })
    expect(await mcp.handle('not json-rpc')).toMatchObject({ error: { code: -32600 } })
  })
  it('gives nothing while it is turned off in Settings, and says where to turn it on', async () => {
    const { mcp } = setup({ enabled: false })
    const r = await call(mcp, 'list_meetings')
    expect(r.isError).toBe(true)
    expect(r.text).toContain('Settings')
    expect(r.text).not.toContain('Budget')
  })
  it('with keys required, reads only for an app added in Settings, and tells any other app where to add it', async () => {
    const { mcp } = setup({ requiresKey: true })
    const stranger = await call(mcp, 'list_meetings')
    expect(stranger.isError).toBe(true)
    expect(stranger.text).toContain('Settings, AI apps')
    expect(stranger.text).not.toContain('Budget')
    // listing the tools says nothing about meetings, so any app may still see them
    expect(await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' })).toMatchObject({ result: { tools: expect.any(Array) } })
    const added = await call(mcp, 'list_meetings', {}, { name: 'Claude' })
    expect(added.isError).toBe(false)
    expect(added.text).toContain('Budget review')
  })
  it('lists meetings newest first, with who was in them, and finds them by words', async () => {
    const { mcp, older, newer } = setup()
    const all = await json(mcp, 'list_meetings')
    expect(all.map((m: { id: string }) => m.id)).toEqual([newer.id, older.id])
    expect(all[1]).toMatchObject({ title: 'Budget review', start: '2026-11-01T17:00:00.000Z', end: '2026-11-01T17:25:00.000Z', people: ['Ann Lee'], app: 'Zoom' })
    expect((await json(mcp, 'list_meetings', { limit: 1 })).map((m: { id: string }) => m.id)).toEqual([newer.id])
    expect((await json(mcp, 'list_meetings', { query: 'travel' })).map((m: { id: string }) => m.id)).toEqual([older.id])
  })
  it("shares each meeting's calendar people with their emails", async () => {
    const { mcp, older, newer } = setup()
    const all = await json(mcp, 'list_meetings')
    expect(all.find((m: { id: string }) => m.id === older.id).attendees).toEqual([{ name: 'Ann Lee', email: 'ann@acme.com' }])
    expect(all.find((m: { id: string }) => m.id === newer.id).attendees).toEqual([])
    expect((await json(mcp, 'get_meeting', { id: older.id })).attendees).toEqual([{ name: 'Ann Lee', email: 'ann@acme.com' }])
  })
  it('gives the calendar event a meeting is linked to: its title, times and calendar; null when it has none', async () => {
    const { mcp, store, older } = setup()
    const linked = store.createMeeting({ title: 'Weekly sync', startedAt: Date.parse('2026-11-03T15:02:00Z'), endedAt: Date.parse('2026-11-03T15:31:00Z'), eventId: 'evt-1',
      eventStartedAt: Date.parse('2026-11-03T15:00:00Z'), eventEndedAt: Date.parse('2026-11-03T15:30:00Z'), eventTitle: 'Weekly sync with Acme', eventCalendarName: 'Work',
      app: 'Meet', state: 'done', attendees: [{ name: 'Dana Smith', email: 'dana@acme.com' }, { name: 'Bo Park', email: null }] })
    const m = await json(mcp, 'get_meeting', { id: linked.id })
    expect(m.calendar_event).toEqual({ title: 'Weekly sync with Acme', start: '2026-11-03T15:00:00.000Z', end: '2026-11-03T15:30:00.000Z', calendar: 'Work' })
    expect(m.attendees).toEqual([{ name: 'Dana Smith', email: 'dana@acme.com' }, { name: 'Bo Park', email: null }])
    expect((await json(mcp, 'get_meeting', { id: older.id })).calendar_event).toBeNull()
  })
  it('gives a meeting with its own notes and the written summary', async () => {
    const { mcp, older } = setup()
    expect(await json(mcp, 'get_meeting', { id: older.id })).toMatchObject({ id: older.id, title: 'Budget review', myNotes: 'travel flat', summary: '## Budget\n- Travel stays flat.' })
  })
  it('gives the transcript as timed lines with who said them, the person by name, without hidden echo lines', async () => {
    const { mcp, older } = setup()
    expect((await call(mcp, 'get_transcript', { id: older.id })).text).toBe('[00:05] Sam Rivera: Can we keep travel flat?\n[01:05] Ann Lee: Travel spend is down a little.\n[01:10] Them: Sure.')
    const lines = await json(mcp, 'get_transcript', { id: older.id, format: 'lines' })
    expect(lines[0]).toEqual({ start_ms: 5000, end_ms: 7000, speaker: 'Sam Rivera', is_me: true, text: 'Can we keep travel flat?' })
    expect(lines).toHaveLength(3)
  })
  it('searches every meeting, with the matched words marked', async () => {
    const { mcp, older } = setup()
    const hits = await json(mcp, 'search', { query: 'travel' })
    expect(hits[0]).toMatchObject({ meeting_id: older.id, title: 'Budget review' })
    expect(hits[0].snippet).toMatch(/\*\*travel\*\*/i)
  })
  it("gives the audio files' paths on this Mac", async () => {
    const { mcp, older, dir } = setup()
    expect(await json(mcp, 'get_audio', { id: older.id })).toEqual({ files: [
      { track: 'me', who: 'Sam Rivera (the microphone)', path: join(dir, 'meetings', older.id, 'me.m4a') },
      { track: 'them', who: 'the other side of the call', path: join(dir, 'meetings', older.id, 'them.m4a') },
    ] })
  })
  it('says plainly when a meeting is not there or an argument is wrong', async () => {
    const { mcp } = setup()
    expect(await call(mcp, 'get_meeting', { id: 'nope' })).toMatchObject({ isError: true, text: expect.stringContaining('No meeting') })
    expect(await call(mcp, 'get_transcript', {})).toMatchObject({ isError: true })
    expect(await call(mcp, 'delete_everything')).toMatchObject({ isError: true })
  })
  it('a meeting in the Trash is not there for AI apps', async () => {
    const { mcp, store, older, newer } = setup()
    store.trashMeeting(older.id, 1)
    expect((await json(mcp, 'list_meetings')).map((m: { id: string }) => m.id)).toEqual([newer.id])
    expect(await json(mcp, 'search', { query: 'travel' })).toEqual([])
    for (const tool of ['get_meeting', 'get_transcript', 'get_audio']) expect(await call(mcp, tool, { id: older.id })).toMatchObject({ isError: true, text: expect.stringContaining('No meeting') })
  })
})

// a Unix socket on a Mac and Linux, a named pipe on Windows
describe('the MCP socket', () => {
  it('speaks one JSON message a line, and knows which apps are connected', async () => {
    const { mcp, dir } = setup()
    const path = mcpAddress(process.platform, dir, randomBytes(8).toString('hex'))
    const seen: string[][] = []
    const server = await serveMcp(path, mcp, (names) => seen.push(names))
    try {
      const sock = connect(path)
      const replies: unknown[] = []
      let buf = ''
      sock.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { replies.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1) } })
      // two messages in one write, the second split across writes
      sock.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'Claude' } } }) + '\n' + '{"jsonrpc":"2.0","id":2,')
      sock.write('"method":"ping"}\n')
      await expect.poll(() => replies.length).toBe(2)
      expect(replies[1]).toEqual({ jsonrpc: '2.0', id: 2, result: {} })
      expect(server.clients()).toEqual(['Claude'])
      sock.end()
      await expect.poll(() => server.clients()).toEqual([])
      expect(seen).toEqual([['Claude'], []])
    } finally { await server.close() }
  })
  it('knows an app by the key it sends first, shows it by its Settings name, and closes it when it is removed', async () => {
    const { dir } = setup()
    const seenBy: Array<string | undefined> = []
    const mcp: Mcp = { handle: async (msg, caller) => { seenBy.push(caller?.name); return (msg as { id?: number }).id === undefined ? null : { jsonrpc: '2.0', id: (msg as { id: number }).id, result: {} } } }
    const path = mcpAddress(process.platform, dir, randomBytes(8).toString('hex'))
    const key = 'yog_' + 'a'.repeat(43)
    const server = await serveMcp(path, mcp, () => {}, (t) => (t === key ? { id: 'app-1', name: 'Hermes' } : undefined))
    try {
      const open = (first: string) => {
        const sock = connect(path)
        const replies: unknown[] = []
        let buf = ''
        sock.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { replies.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1) } })
        sock.write(first + JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'claude-code' } } }) + '\n')
        return { sock, replies, closed: new Promise<void>((r) => sock.on('close', () => r())) }
      }
      const added = open(JSON.stringify({ jsonrpc: '2.0', method: 'yogurt/auth', params: { token: key } }) + '\n')
      const wrong = open(JSON.stringify({ jsonrpc: '2.0', method: 'yogurt/auth', params: { token: 'yog_' + 'b'.repeat(43) } }) + '\n')
      await expect.poll(() => added.replies.length + wrong.replies.length).toBe(2)
      // the key line itself is never answered and never reaches the server
      expect(seenBy.sort()).toEqual(['Hermes', undefined].sort())
      expect(server.clients().sort()).toEqual(['Hermes', 'claude-code'])
      server.drop('app-1')
      // right away, not once the socket has closed: Settings reads this list in the reply to the removal
      expect(server.clients()).toEqual(['claude-code'])
      await added.closed
      await expect.poll(() => server.clients()).toEqual(['claude-code'])
      wrong.sock.end()
    } finally { await server.close() }
  })
  it.skipIf(process.platform === 'win32')('replaces a socket file left by a crash', async () => {
    const { mcp, dir } = setup()
    const path = join(dir, 'mcp.sock')
    writeFileSync(path, '')
    const server = await serveMcp(path, mcp, () => {})
    await server.close()
  })
})

describe('folders in the MCP server', () => {
  it('lists the folders, names each meeting\'s folders, and narrows list_meetings and search to a folder by id or name', async () => {
    const { store, mcp, older, newer } = setup()
    const finance = store.createFolder('Finance')
    store.createFolder('Hiring')
    store.addToFolder(finance.id, older.id)

    const folders = await json(mcp, 'list_folders')
    expect(folders).toEqual([{ id: finance.id, name: 'Finance', meetings: 1 }, expect.objectContaining({ name: 'Hiring', meetings: 0 })])

    expect((await json(mcp, 'get_meeting', { id: older.id })).folders).toEqual([{ id: finance.id, name: 'Finance' }])
    expect((await json(mcp, 'get_meeting', { id: newer.id })).folders).toEqual([])

    expect((await json(mcp, 'list_meetings', { folder: finance.id })).map((m: { id: string }) => m.id)).toEqual([older.id])
    expect((await json(mcp, 'list_meetings', { folder: 'finance' })).map((m: { id: string }) => m.id)).toEqual([older.id])
    expect((await json(mcp, 'list_meetings', { folder: 'Hiring' }))).toEqual([])
    expect((await json(mcp, 'search', { query: 'travel', folder: 'Hiring' }))).toEqual([])
    expect((await json(mcp, 'search', { query: 'travel', folder: 'Finance' })).map((h: { meeting_id: string }) => h.meeting_id)).toEqual([older.id])
  })
  it('an unknown folder says which folders there are', async () => {
    const { store, mcp } = setup()
    store.createFolder('Finance')
    const r = await call(mcp, 'list_meetings', { folder: 'Sales' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('Finance')
  })
})

