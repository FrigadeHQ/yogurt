import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const launch = async (env: Record<string, string> = {}) => {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-ai-local-'))
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData, YOGURT_FAKE_LLM_MS: '2', ...env,
  } })
  return { app, userData, page: await app.firstWindow() }
}
const meeting = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __fake__: { manyMeetings(o: { n: number; clean: boolean }): void } }).__fake__.manyMeetings({ n: 1, clean: true }))
const files = (dir: string) => existsSync(dir) ? readdirSync(dir) : []

/** an OpenAI-compatible server on 127.0.0.1 that writes one summary */
async function openAiServer() {
  const server = createServer((req, res) => {
    req.resume()
    if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'test-model' }] })); return }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '## From your server\n- The site goes live on **Tuesday**.' } }] })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, close: () => server.close() }
}

test('a Mac no notes model fits goes on without Yogurt AI, and its summaries wait for the AI picked for them', async () => {
  const server = await openAiServer()
  const { app, userData, page } = await launch({ YOGURT_FAKE_RAM_GB: '4' })
  try {
    await expect(page.getByTestId('setup-error')).toHaveText('Yogurt needs a Mac with at least 8 GB of memory.', { timeout: 15_000 })
    await expect(page.getByTestId('setup-skip-local-text')).toBeVisible()
    await page.getByTestId('setup-skip-local').click()
    await expect(page.getByTestId('home')).toBeVisible({ timeout: 15_000 })
    expect(JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')).localNotes).toBe(false)
    expect(files(join(userData, 'models', 'llm'))).toEqual([])

    await meeting(app)
    await page.reload()
    await page.getByTestId('past-note').click()
    await page.getByTestId('note-menu-button').click()
    // nothing can write a summary: Regenerate says what to do instead of waiting forever
    await expect(page.getByTestId('note-write-again')).toHaveAttribute('aria-disabled', 'true')
    await expect(page.getByTestId('note-write-again')).toHaveAttribute('aria-description', 'Pick an AI model for summaries in Settings')
    await page.keyboard.press('Escape')

    await page.evaluate(() => window.yogurt.nav.go('/settings'))
    await expect(page.getByTestId('ai-local-status')).toHaveText('No notes model fits this computer: pick another AI above for each task.')
    await expect(page.getByTestId('ai-local-download')).toHaveCount(0)
    await expect(page.getByTestId('ai-task-notes').locator('option').first()).toHaveText('Yogurt AI (not on this computer)')
    // a server saved and picked: the summary that waited is written by it
    await page.getByTestId('ai-server-url').fill(server.url)
    await page.getByTestId('ai-server-test').click()
    await expect(page.getByTestId('ai-server-status')).toHaveText('Connected')
    await page.getByTestId('ai-server-save').click()
    await page.getByTestId('ai-task-notes').selectOption('server')
    await page.getByTestId('nav-home').click()
    await page.getByTestId('past-note').click()
    await page.getByTestId('note-menu-button').click()
    await page.getByTestId('note-write-again').click()
    await page.getByTestId('note-write-again-confirm').click()
    await expect(page.getByTestId('note-enhanced-editor')).toContainText('From your server', { timeout: 15_000 })
  } finally { await app.close(); server.close() }
})

test('Settings → AI models: Yogurt AI removed and downloaded again', async () => {
  const { app, userData, page } = await launch()
  try {
    await expect(page.getByTestId('home')).toBeVisible({ timeout: 15_000 })
    await page.evaluate(() => window.yogurt.nav.go('/settings'))
    const status = page.getByTestId('ai-local-status')
    await expect(status).toHaveText('On this computer, so it works offline. Remove it to free its space.', { timeout: 15_000 })
    const llm = join(userData, 'models', 'llm')
    expect(files(llm).length).toBeGreaterThan(0)
    // the bigger notes model's own row is there until Yogurt AI goes
    await expect(page.getByTestId('settings-notes-model')).toBeVisible()
    await page.getByTestId('ai-local-remove').click()
    await expect(status).toHaveText('Not on this computer. Tasks set to it wait until you download it.')
    await expect(page.getByTestId('settings-notes-model')).toHaveCount(0)
    await expect.poll(() => files(llm).filter((f) => !f.endsWith('.part'))).toEqual([])
    await expect(page.getByTestId('ai-task-notes').locator('option').first()).toHaveText('Yogurt AI (not on this computer)')
    expect(JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')).localNotes).toBe(false)
    await page.getByTestId('ai-local-download').click()
    await expect(status).toHaveText('On this computer, so it works offline. Remove it to free its space.', { timeout: 15_000 })
    await expect(page.getByTestId('ai-task-notes').locator('option').first()).toHaveText('Yogurt AI on this Mac')
  } finally { await app.close() }
})
