import { openFromCorner } from './cornerNavigation'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')
const helper = join(import.meta.dirname, '../resources/bin/yogurt-mcp')

const fake = <T>(app: ElectronApplication, fn: string, arg?: unknown): Promise<T> =>
  app.evaluate((_e, [fn, arg]) => (globalThis as unknown as Record<string, Record<string, (a?: unknown) => unknown>>).__fake__[fn as string](arg), [fn, arg] as const) as Promise<T>

/** an AI app: starts yogurt-mcp as Claude would and talks MCP to it, one JSON message a line */
function aiApp(userData: string, env: Record<string, string> = {}) {
  const child: ChildProcessWithoutNullStreams = spawn(helper, [], { env: { ...process.env, YOGURT_USER_DATA: userData, YOGURT_MCP_NO_LAUNCH: '1', ...env } })
  const exited = new Promise<void>((r) => child.on('exit', () => r()))
  const replies = new Map<number, unknown>()
  let buf = '', next = 1
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (d: string) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); replies.set(m.id, m); buf = buf.slice(i + 1) } })
  const ask = async (method: string, params?: unknown) => {
    const id = next++
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    await expect.poll(() => replies.has(id)).toBe(true)
    return replies.get(id) as { result: { content?: Array<{ text: string }>; isError?: boolean; serverInfo?: { name: string } } }
  }
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await ask('tools/call', { name, arguments: args })
    return { text: r.result.content!.map((c) => c.text).join('\n'), isError: !!r.result.isError }
  }
  return { ask, tool, exited, close: () => child.stdin.end() }
}

/** what the page last put on the clipboard */
const copied = (page: import('@playwright/test').Page) => page.locator('html').getAttribute('data-copied')
const catchCopies = (page: import('@playwright/test').Page) => page.evaluate(() => {
  Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async (text: string) => { document.documentElement.dataset.copied = text } })
})

test('an AI app reads meetings only once Settings allows it and it was added there with its own key; removing it ends its session', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-mcp-'))
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData } })
  const page = await app.firstWindow()
  const stranger = aiApp(userData)
  let added: ReturnType<typeof aiApp> | undefined
  try {
    await expect(page.getByTestId('home')).toBeVisible()
    await fake(app, 'manyMeetings', { n: 2, clean: true })
    const hello = await stranger.ask('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Test client', version: '1' } })
    expect(hello.result.serverInfo!.name).toBe('yogurt')
    // off by default: nothing is read
    const off = await stranger.tool('list_meetings')
    expect(off.isError).toBe(true)
    expect(off.text).toContain('Settings')

    await openFromCorner(page, 'settings-open')
    const toggle = page.getByTestId('ai-apps-toggle')
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('ai-apps-clients')).toHaveText('Connected apps · Test client')
    await expect(page.getByTestId('ai-apps-command')).toHaveValue(/yogurt-mcp$/)
    await expect(page.getByTestId('ai-apps')).toContainText('Add each app here, then paste its setup into the app as a local MCP server.')
    // a new profile: only apps added here, and none is yet
    const keys = page.getByTestId('ai-apps-keys-toggle')
    await expect(keys).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('ai-apps-empty')).toHaveText('No apps added yet.')
    const refused = await stranger.tool('list_meetings')
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('Settings, AI apps')

    await catchCopies(page)
    await page.getByTestId('ai-apps-copy').click()
    await expect(page.getByTestId('ai-apps-copy')).toHaveText('Copied')
    expect(await copied(page)).toBe(await page.getByTestId('ai-apps-command').inputValue())

    await expect(page.getByTestId('ai-apps-add')).toBeDisabled()
    await page.getByTestId('ai-apps-name').fill('Claude')
    await page.getByTestId('ai-apps-name').press('Enter')
    await expect(page.getByTestId('ai-apps-app-name')).toHaveText(['Claude'])
    await expect(page.getByTestId('ai-apps-added')).toContainText('Paste this setup into Claude.')
    await page.getByTestId('ai-apps-added-copy').click()
    await expect(page.getByTestId('ai-apps-added-copy')).toHaveText('Copied')
    const setup = JSON.parse((await copied(page))!) as { mcpServers: { yogurt: { command: string; env: { YOGURT_MCP_TOKEN: string } } } }
    expect(setup.mcpServers.yogurt.command).toBe(await page.getByTestId('ai-apps-command').inputValue())
    const key = setup.mcpServers.yogurt.env.YOGURT_MCP_TOKEN
    expect(key).toMatch(/^yog_[\w-]{40,}$/)
    // the setup can be copied again later, with the same key
    await page.getByTestId('ai-apps-app-setup').click()
    await expect.poll(() => copied(page).then((c) => JSON.parse(c!).mcpServers.yogurt.env.YOGURT_MCP_TOKEN)).toBe(key)

    added = aiApp(userData, { YOGURT_MCP_TOKEN: key })
    await added.ask('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '1' } })
    // shown by the name it was added with, not the one it reports
    await expect(page.getByTestId('ai-apps-clients')).toHaveText(/Connected apps · (Test client, Claude|Claude, Test client)$/)
    const meetings = JSON.parse((await added.tool('list_meetings')).text) as Array<{ id: string; title: string }>
    expect(meetings).toHaveLength(2)
    const transcript = await added.tool('get_transcript', { id: meetings[0].id })
    expect(transcript.isError).toBe(false)
    expect(transcript.text).toMatch(/^\[\d\d:\d\d\] /)
    expect((await stranger.tool('list_meetings')).isError).toBe(true)

    // a key says who may connect; "Let AI apps make changes" still decides whether any connected app may change things
    const changes = page.getByTestId('ai-apps-changes-toggle')
    await expect(changes).toHaveAttribute('aria-checked', 'false')
    expect(await added.tool('create_folder', { name: 'Sales' })).toMatchObject({ isError: true, text: expect.stringContaining('Let AI apps make changes') })
    await changes.click()
    await expect(changes).toHaveAttribute('aria-checked', 'true')
    expect((await added.tool('create_folder', { name: 'Sales' })).isError).toBe(false)
    // with changes on, an app without a key is still turned away, and nothing is made
    expect(await stranger.tool('create_folder', { name: 'Hiring' })).toMatchObject({ isError: true, text: expect.stringContaining('Add an app') })
    expect(JSON.parse((await added.tool('list_folders')).text).map((f: { name: string }) => f.name)).toEqual(['Sales'])
    await changes.click()
    await expect(changes).toHaveAttribute('aria-checked', 'false')

    // removed: its session ends at once, and its key reads nothing any more
    await page.getByRole('button', { name: 'Remove Claude' }).click()
    await added.exited
    await expect(page.getByTestId('ai-apps-empty')).toBeVisible()
    await expect(page.getByTestId('ai-apps-clients')).toHaveText('Connected apps · Test client')

    // keys off: any app on this Mac reads again, as before keys
    await keys.click()
    await expect(keys).toHaveAttribute('aria-checked', 'false')
    await expect(page.getByTestId('ai-apps')).toContainText('Copy this command and add it as a local MCP server in your AI app.')
    expect((await stranger.tool('list_meetings')).isError).toBe(false)

    // Block the temporary write in this disposable profile while leaving the saved permission readable.
    const tempSettings = join(userData, 'settings.json.tmp')
    mkdirSync(tempSettings)
    try {
      await toggle.click()
      const toast = page.getByTestId('ai-apps-retry-error')
      await expect(toast).toHaveClass(/app-toast/)
      await toast.getByRole('button', { name: 'Close' }).click()
      await expect(toast).toHaveCount(0)
      await expect(toggle).toHaveAttribute('aria-checked', 'true')
      await toggle.click()
      await expect(page.getByTestId('ai-apps-retry')).toBeVisible()
      await expect(toggle).toHaveAttribute('aria-checked', 'true')
      expect((await stranger.tool('list_meetings')).isError).toBe(false)
    } finally { rmdirSync(tempSettings) }
    await page.getByTestId('nav-home').click()
    await expect(page.getByTestId('home')).toBeVisible()
    await openFromCorner(page, 'settings-open')
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await page.getByTestId('ai-apps-retry').click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect(toggle).toBeEnabled()
    expect((await stranger.tool('list_meetings')).isError).toBe(true)
    stranger.close()
    await toggle.click()
    await expect(page.getByTestId('ai-apps-clients')).toHaveCount(0)
  } finally { stranger.close(); added?.close(); await app.close() }
})

test('a profile that let AI apps in before keys existed keeps reading without a key until keys are turned on', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-mcp-earlier-'))
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({ aiApps: true }))
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData } })
  const page = await app.firstWindow()
  const earlier = aiApp(userData)
  try {
    await expect(page.getByTestId('home')).toBeVisible()
    await fake(app, 'manyMeetings', { n: 1, clean: true })
    await earlier.ask('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Old client', version: '1' } })
    expect((await earlier.tool('list_meetings')).isError).toBe(false)
    await openFromCorner(page, 'settings-open')
    const keys = page.getByTestId('ai-apps-keys-toggle')
    await expect(keys).toHaveAttribute('aria-checked', 'false')
    await keys.click()
    await expect(keys).toHaveAttribute('aria-checked', 'true')
    const refused = await earlier.tool('list_meetings')
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('Settings, AI apps')
  } finally { earlier.close(); await app.close() }
})
