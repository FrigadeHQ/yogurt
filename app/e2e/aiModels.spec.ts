import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** an OpenAI-compatible server on 127.0.0.1: one model, notes streamed as server-sent events */
async function openAiServer() {
  const requests: Array<{ path: string; auth?: string; body?: { model?: string; messages?: Array<{ content: string }> } }> = []
  const read = (req: IncomingMessage) => new Promise<string>((resolve) => { let b = ''; req.on('data', (d) => { b += d }); req.on('end', () => resolve(b)) })
  const server = createServer(async (req, res) => {
    const body = await read(req)
    requests.push({ path: req.url ?? '', auth: req.headers.authorization, ...(body ? { body: JSON.parse(body) } : {}) })
    if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'test-model' }] })); return }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const piece of ['## From your server\n', '- The site goes live on **Tuesday**.']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests, close: () => server.close() }
}

test('Settings → AI models: summaries and Ask from your own server, with the key kept out of sight', async () => {
  const server = await openAiServer()
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-ai-models-'))
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData, YOGURT_FAKE_LLM_MS: '2',
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    await app.evaluate(() => (globalThis as unknown as { __fake__: { manyMeetings(o: { n: number; clean: boolean }): void } }).__fake__.manyMeetings({ n: 1, clean: true }))
    await page.reload()
    await expect(page.getByTestId('past-note')).toBeVisible()
    await page.evaluate(() => window.yogurt.nav.go('/settings'))
    const notes = page.getByTestId('ai-task-notes')
    await expect(page.getByTestId('ai-models')).toBeVisible()
    // this computer only, until a server is saved
    await expect(notes.locator('option')).toHaveText(['Yogurt AI on this Mac'])
    await expect(page.getByTestId('ai-models-elsewhere')).toHaveCount(0)

    await page.getByTestId('ai-server-url').fill(server.url)
    await page.getByTestId('ai-server-key').fill('secret-key')
    await page.getByTestId('ai-server-test').click()
    await expect(page.getByTestId('ai-server-status')).toHaveText('Connected')
    await expect(page.getByTestId('ai-server-model')).toHaveValue('test-model')
    await page.getByTestId('ai-server-save').click()
    await expect(notes.locator('option')).toHaveText(['Yogurt AI on this Mac', 'Your server · test-model'])
    await expect(page.getByTestId('ai-server-key')).toHaveValue('')
    await expect(page.getByTestId('ai-server-key')).toHaveAttribute('placeholder', 'Saved')
    expect(readFileSync(join(userData, 'settings.json'), 'utf8')).not.toContain('secret-key')

    await notes.selectOption('server')
    await page.getByTestId('ai-task-ask').selectOption('server')
    await expect(page.getByTestId('ai-models-elsewhere')).toHaveText('Meeting text goes to your server for these. What happens to it there is up to them.')

    // the summary written again comes from the server, with its key
    await page.getByTestId('nav-home').click()
    await page.getByTestId('past-note').click()
    await page.getByTestId('note-menu-button').click()
    await page.getByTestId('note-write-again').click()
    await page.getByTestId('note-write-again-confirm').click()
    await expect(page.getByTestId('note-enhanced-editor')).toContainText('From your server')
    const chat = server.requests.find((r) => r.path === '/v1/chat/completions')!
    expect(chat.auth).toBe('Bearer secret-key')
    expect(chat.body?.model).toBe('test-model')
    expect(chat.body?.messages?.at(-1)?.content).toContain('Write the notes for this meeting')

    // Ask goes to the server too
    const before = server.requests.filter((r) => r.path === '/v1/chat/completions').length
    await page.getByTestId('chat-open').click()
    await page.getByTestId('chat-input').fill('When does the site go live?')
    await page.getByTestId('chat-input').press('Enter')
    await expect(page.getByTestId('chat-turn')).toHaveAttribute('data-status', 'done', { timeout: 15_000 })
    await expect(page.getByTestId('chat-answer')).toContainText('The site goes live on Tuesday.')
    const asked = server.requests.filter((r) => r.path === '/v1/chat/completions').slice(before)
    expect(asked.at(-1)?.auth).toBe('Bearer secret-key')
    expect(asked.at(-1)?.body?.messages?.at(-1)?.content).toContain('When does the site go live?')
  } finally { await app.close(); server.close() }
})
