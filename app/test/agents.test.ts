import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Llm } from '../src/main/notes/enhance'

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => any>())
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => handlers.set(channel, fn) } }))

import { asOne, createAgents, findIn } from '../src/main/ai/agents'
import { hookAi } from '../src/main/ai'

const dirs: string[] = []
afterEach(() => { dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })); handlers.clear(); vi.unstubAllEnvs() })
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'yogurt-agents-')); dirs.push(d); return d }
const AGENTS_DIR = join(__dirname, 'fixtures/agents')
const unix = process.platform !== 'win32'

describe('agent apps', () => {
  it.skipIf(!unix)('finds only runnable files, and joins earlier turns into one prompt', () => {
    const d = temp()
    writeFileSync(join(d, 'hermes'), 'not runnable', { mode: 0o644 })
    expect(findIn([d, AGENTS_DIR], 'hermes')).toBe(join(AGENTS_DIR, 'hermes'))
    expect(findIn([d], 'claude')).toBeUndefined()
    expect(asOne('Title?')).toBe('Title?')
    expect(asOne('Title?', ['Notes prompt', 'Notes'])).toBe('<earlier_request>\nNotes prompt\n</earlier_request>\n\n<your_earlier_answer>\nNotes\n</your_earlier_answer>\n\nNow, following on from that:\n\nTitle?')
  })
  it.skipIf(!unix)('asks Hermes over ACP in an empty folder, turns its permission down, and keeps its thinking out', async () => {
    const log = join(temp(), 'log.jsonl')
    vi.stubEnv('YOGURT_FAKE_AGENT_LOG', log)
    const agents = createAgents({ dirs: [AGENTS_DIR] })
    expect(agents.found('hermes')).toBe(true)
    const tokens: string[] = []
    const answer = await agents.llm('hermes')!.chat('Write the notes for this meeting', (t) => tokens.push(t))
    expect(answer).toBe('## Hermes notes\n- The site goes live on **Tuesday**.\n## Next steps\n- **You:** Share the plan.')
    expect(tokens.join('')).toBe(answer)
    const seen = JSON.parse(readFileSync(log, 'utf8').trim())
    expect(seen).toMatchObject({ prompt: 'Write the notes for this meeting', permission: 'cancelled' })
    expect(seen.cwd).toContain('yogurt-agent-')
    expect(existsSync(seen.cwd)).toBe(false)
  })
  it.skipIf(!unix)('asks Codex read-only, and says what Codex said when it fails', async () => {
    const log = join(temp(), 'log.jsonl')
    vi.stubEnv('YOGURT_FAKE_AGENT_LOG', log)
    const agents = createAgents({ dirs: [AGENTS_DIR] })
    expect(await agents.llm('codex')!.chat('<question>When?</question>', () => {})).toBe('Codex says: the site goes live on Tuesday.')
    expect(JSON.parse(readFileSync(log, 'utf8').trim()).args).toEqual(['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral', '--json', '-'])
    vi.stubEnv('FAKE_AGENT_FAIL', '1')
    await expect(agents.llm('codex')!.chat('q', () => {})).rejects.toThrow("Codex: You've hit your usage limit")
    await expect(agents.llm('hermes')!.chat('q', () => {})).rejects.toThrow(/hermes stopped|Hermes stopped/)
  })
  it.skipIf(!unix)('asks Claude Code with no tools and no MCP servers, streamed, and says what it said when it fails', async () => {
    const log = join(temp(), 'log.jsonl')
    vi.stubEnv('YOGURT_FAKE_AGENT_LOG', log)
    const agents = createAgents({ dirs: [AGENTS_DIR] })
    const tokens: string[] = []
    expect(await agents.llm('claude')!.chat('<question>When?</question>', (t) => tokens.push(t))).toBe('Claude says: the site goes live on Tuesday.')
    expect(tokens.length).toBeGreaterThan(1)
    expect(JSON.parse(readFileSync(log, 'utf8').trim()).args).toEqual(['-p', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands', '--output-format', 'stream-json', '--include-partial-messages', '--verbose'])
    vi.stubEnv('FAKE_AGENT_FAIL', '1')
    await expect(agents.llm('claude')!.chat('q', () => {})).rejects.toThrow('Claude Code: Claude usage limit reached.')
  })
  it('is never found where it is not', () => {
    const agents = createAgents({ dirs: [temp()] })
    expect(agents.found('hermes')).toBe(false)
    expect(agents.llm('codex')).toBeUndefined()
  })
})

describe('Settings → AI models: agent apps', () => {
  const hook = () => {
    const file = join(temp(), 'settings.json')
    const changed = vi.fn()
    const local: Llm = { contextSize: 8192, count: async (xs) => xs.map((x) => x.length), chat: async () => 'local' }
    const router = hookAi({ file, local: { llm: async () => local }, hasLocal: () => true, changed, seal: (p) => p, open: (s) => s, agents: createAgents({ dirs: [AGENTS_DIR] }) })
    const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args)
    return { file, changed, router, call, saved: () => JSON.parse(readFileSync(file, 'utf8')) }
  }
  it('saves a choice per task, and shows an agent only once it is found', async () => {
    const s = hook()
    const status = await s.call('ai:status')
    expect(status.tasks).toEqual({ notes: 'local', ask: 'local', folders: 'local' })
    expect(status.agents.map((a: { id: string; found: boolean }) => [a.id, a.found])).toEqual([['hermes', unix], ['codex', unix], ['claude', unix]])
    if (!unix) return
    expect((await s.call('ai:set-task', 'ask', 'hermes')).tasks.ask).toBe('hermes')
    expect(s.saved().ai).toEqual({ ask: 'hermes' })
    expect(s.changed).toHaveBeenCalled()
    expect(s.router.chosen('ask')).toBe('hermes')
    expect((await s.router.model('ask').llm()).contextSize).toBe(128_000)
    expect((await s.call('ai:set-task', 'ask', 'local')).tasks.ask).toBe('local')
    expect(s.saved().ai).toEqual({})
    await expect(async () => s.call('ai:set-task', 'ask', 'gpt')).rejects.toThrow()
  })
})
