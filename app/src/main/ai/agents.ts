import { execFile, spawn } from 'node:child_process'
import { accessSync, constants, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Llm } from '../notes/enhance'
import { guess } from '../chat'
import { AGENTS, type AgentId } from '../../shared/ai'

/** what an agent's model reads at once, as far as Yogurt plans prompts: below what each one's own model takes */
export const AGENT_CONTEXT = 128_000

type Run = (o: { binary: string; prompt: string; cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; onToken: (text: string) => void }) => Promise<string>

/** a process's stdout line by line; stderr's last words kept for the error */
function lines(binary: string, args: string[], o: { input?: string; cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal }, onLine: (line: string, write: (s: string) => void) => void) {
  // npm installs on Windows are .cmd shims, which only start through the shell; the arguments are Yogurt's own
  const shell = /\.(cmd|bat)$/i.test(binary)
  // through the shell an empty argument would vanish
  const child = spawn(binary, shell ? args.map((a) => (a === '' ? '""' : a)) : args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell, signal: o.signal })
  let err = ''
  child.stderr.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-600) })
  const write = (s: string) => { if (child.stdin.writable) child.stdin.write(s) }
  createInterface({ input: child.stdout }).on('line', (l) => { if (l.trim()) onLine(l, write) })
  if (o.input !== undefined) child.stdin.end(o.input)
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', (e) => { if (o.signal?.aborted) resolve(); else reject(e) })
    child.on('close', (code) => { if (code === 0 || o.signal?.aborted) resolve(); else reject(new Error(`${binary} stopped (${code}): ${err.trim().split('\n').slice(-3).join(' ')}`)) })
  })
  return { child, done, write }
}

/** Codex: one turn of `codex exec`, read-only, in an empty folder; the answer comes whole when the turn ends */
const codex: Run = async ({ binary, prompt, cwd, env, signal, onToken }) => {
  let out = '', failed = ''
  const run = lines(binary, ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral', '--json', '-'], { input: prompt, cwd, env, signal }, (line) => {
    let e: { type?: string; message?: string; error?: { message?: string }; item?: { type?: string; text?: string } }
    try { e = JSON.parse(line) } catch { return }
    if (e.type === 'item.completed' && e.item?.type === 'agent_message' && e.item.text) {
      const piece = (out ? '\n\n' : '') + e.item.text
      out += piece
      onToken(piece)
    } else if (e.type === 'turn.failed' || e.type === 'error') failed ||= e.error?.message ?? e.message ?? 'failed'
  })
  // its own words for what went wrong (a usage limit, a sign-in) over the exit code
  await run.done.catch((e) => { if (!failed) throw e })
  if (failed && !out && !signal?.aborted) throw new Error(`Codex: ${failed.slice(0, 300)}`)
  return out
}

/**
 * Hermes: Agent Client Protocol over stdio (`hermes acp`). A new session in an empty folder, no MCP servers, one
 * prompt; every permission it asks for is turned down, so it can only write. Its thinking is not the answer.
 */
const hermes: Run = async ({ binary, prompt, cwd, env, signal, onToken }) => {
  let id = 0, out = ''
  const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  const run = lines(binary, ['acp'], { cwd, env, signal }, (line, write) => {
    let m: { id?: number; method?: string; params?: { update?: { sessionUpdate?: string; content?: { text?: string } } }; result?: unknown; error?: { message?: string } }
    try { m = JSON.parse(line) } catch { return }
    if (m.id !== undefined && !m.method) {
      const w = waiting.get(m.id)
      waiting.delete(m.id)
      if (m.error) w?.reject(new Error(`Hermes: ${String(m.error.message ?? 'failed').slice(0, 300)}`)); else w?.resolve(m.result)
    } else if (m.method === 'session/update') {
      const u = m.params?.update
      if (u?.sessionUpdate === 'agent_message_chunk' && u.content?.text) {
        const piece = out ? u.content.text : u.content.text.trimStart()
        if (piece) { out += piece; onToken(piece) }
      }
    } else if (m.method === 'session/request_permission') write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'cancelled' } } }) + '\n')
    else if (m.method && m.id !== undefined) write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Yogurt only reads answers' } }) + '\n')
  })
  const call = <T>(method: string, params: unknown) => new Promise<T>((resolve, reject) => {
    const n = id++
    waiting.set(n, { resolve: resolve as (v: unknown) => void, reject })
    run.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n')
  })
  // it stopping early answers every question still open
  const ended = run.done.then(() => { throw new Error('Hermes stopped before it answered') })
  ended.catch(() => {})
  try {
    await Promise.race([call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }), ended])
    const session = await Promise.race([call<{ sessionId: string }>('session/new', { cwd, mcpServers: [] }), ended])
    await Promise.race([call('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: prompt }] }), ended])
  } catch (e) {
    if (signal?.aborted) return out
    throw e
  } finally {
    run.child.stdin.end()
    if (run.child.exitCode === null) run.child.kill()
  }
  return out
}

/** Claude Code: `claude -p` with no tools and no MCP servers, nothing saved; the answer streamed as it is written */
const claude: Run = async ({ binary, prompt, cwd, env, signal, onToken }) => {
  let out = '', failed = ''
  const args = ['-p', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands', '--output-format', 'stream-json', '--include-partial-messages', '--verbose']
  const run = lines(binary, args, { input: prompt, cwd, env, signal }, (line) => {
    let e: { type?: string; subtype?: string; is_error?: boolean; result?: string; event?: { type?: string; delta?: { type?: string; text?: string } } }
    try { e = JSON.parse(line) } catch { return }
    const text = e.type === 'stream_event' && e.event?.type === 'content_block_delta' && e.event.delta?.type === 'text_delta' ? e.event.delta.text : undefined
    if (text) {
      const piece = out ? text : text.trimStart()
      if (piece) { out += piece; onToken(piece) }
    } else if (e.type === 'result' && (e.is_error || (e.subtype && e.subtype !== 'success'))) failed ||= e.result ?? e.subtype ?? 'failed'
  })
  await run.done.catch((err) => { if (!failed) throw err })
  if (failed && !out && !signal?.aborted) throw new Error(`Claude Code: ${String(failed).slice(0, 300)}`)
  return out
}

const RUNS: Record<AgentId, Run> = { hermes, codex, claude }
const BINARY: Record<AgentId, string> = { hermes: 'hermes', codex: 'codex', claude: 'claude' }

/** earlier turns (a title follows on from its notes) as one prompt: an agent takes one message at a time */
export function asOne(prompt: string, before: string[] = []): string {
  if (!before.length) return prompt
  const turns = before.map((t, i) => (i % 2 ? `<your_earlier_answer>\n${t}\n</your_earlier_answer>` : `<earlier_request>\n${t}\n</earlier_request>`))
  return [...turns, 'Now, following on from that:', prompt].join('\n\n')
}

/** where a program installed for this person may be: a Mac or Linux app opened from the Dock gets a short PATH */
export function searchDirs(env: NodeJS.ProcessEnv, home = homedir(), extra: string[] = []): string[] {
  const own = process.platform === 'win32'
    ? [join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'npm'), join(home, '.local', 'bin')]
    : [join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', join(home, '.npm-global', 'bin'), join(home, 'bin')]
  return [...new Set([...extra, ...(env.PATH ?? '').split(delimiter), ...own].filter(Boolean))]
}

/** the first runnable file by that name in those folders */
export function findIn(dirs: string[], name: string): string | undefined {
  const names = process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`] : [name]
  for (const dir of dirs) for (const n of names) {
    const path = join(dir, n)
    try { accessSync(path, constants.X_OK); return path } catch { /* not here */ }
  }
}

/** the PATH a terminal would have: where version managers and installers put things */
function loginPath(): Promise<string> {
  if (process.platform === 'win32') return Promise.resolve('')
  const mark = '__YOGURT_PATH__'
  return new Promise((resolve) => {
    execFile(process.env.SHELL || '/bin/zsh', ['-ilc', `printf '${mark}%s${mark}' "$PATH"`], { timeout: 4000, windowsHide: true }, (_e, stdout) => {
      resolve(new RegExp(`${mark}(.*?)${mark}`).exec(String(stdout ?? ''))?.[1] ?? '')
    })
  })
}

/**
 * The AI agent apps on this computer (shared/ai.ts AGENTS): found where the person's terminal would find them, and
 * asked one prompt at a time through their own sign-in, in an empty folder, with no tools. dirs: where to look only
 * (tests); otherwise the app's PATH, the usual install folders, and a login shell's PATH.
 */
export function createAgents(o: { dirs?: string[] } = {}) {
  let shellPath = ''
  let found = new Map<AgentId, string>()
  const env = (): NodeJS.ProcessEnv => {
    // the agent's own scripts look for node and friends on the PATH too (also when tests say where agents are)
    const path = searchDirs(process.env, homedir(), [...(o.dirs ?? []), ...shellPath.split(delimiter)]).join(delimiter)
    const e: NodeJS.ProcessEnv = { ...process.env, PATH: path }
    // never as a part of a Claude Code session Yogurt happens to be started from
    delete e.CLAUDECODE; delete e.CLAUDE_CODE_ENTRYPOINT; delete e.ELECTRON_RUN_AS_NODE
    return e
  }
  const look = () => {
    const dirs = o.dirs ?? searchDirs(process.env, homedir(), shellPath.split(delimiter))
    found = new Map(AGENTS.flatMap((a) => { const p = findIn(dirs, BINARY[a.id]); return p ? [[a.id, p] as const] : [] }))
  }
  look()
  let shell: Promise<void> | undefined = o.dirs ? Promise.resolve() : loginPath().then((p) => { shellPath = p; look() })
  return {
    found: (id: AgentId) => found.has(id),
    /** looks again (Settings opened): an agent installed meanwhile shows up */
    async refresh() {
      await shell
      if (!o.dirs) shell = loginPath().then((p) => { shellPath = p; look() })
      await shell
    },
    llm(id: AgentId, signal?: AbortSignal): Llm | undefined {
      const binary = found.get(id)
      if (!binary) return
      return {
        contextSize: AGENT_CONTEXT,
        count: async (texts) => texts.map(guess),
        chat: async (prompt, onToken, opts) => {
          const cwd = mkdtempSync(join(tmpdir(), 'yogurt-agent-'))
          try { return await RUNS[id]({ binary, prompt: asOne(prompt, opts?.before), cwd, env: env(), signal, onToken }) } finally { rmSync(cwd, { recursive: true, force: true }) }
        },
      }
    },
  }
}
export type Agents = ReturnType<typeof createAgents>
