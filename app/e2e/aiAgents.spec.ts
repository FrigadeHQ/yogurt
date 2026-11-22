import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('Settings → AI models: Ask from an agent app that may only write', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-ai-agents-'))
  const log = join(userData, 'agents.jsonl')
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData, YOGURT_FAKE_LLM_MS: '2',
    YOGURT_FAKE_AGENTS: join(import.meta.dirname, '../test/fixtures/agents'), YOGURT_FAKE_AGENT_LOG: log,
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    await app.evaluate(() => (globalThis as unknown as { __fake__: { manyMeetings(o: { n: number; clean: boolean }): void } }).__fake__.manyMeetings({ n: 1, clean: true }))
    await page.reload()
    await expect(page.getByTestId('past-note')).toBeVisible()
    await page.evaluate(() => window.yogurt.nav.go('/settings'))
    // this computer first, then each agent app found
    await expect(page.getByTestId('ai-task-ask').locator('option')).toHaveText(['Yogurt AI on this Mac', 'Hermes', 'Codex', 'Claude Code'])
    await page.getByTestId('ai-task-ask').selectOption('hermes')
    await expect(page.getByTestId('ai-models-elsewhere')).toHaveText('Meeting text goes to Hermes for these. What happens to it there is up to them.')

    // Ask goes to Hermes, which may only write
    await page.getByTestId('nav-home').click()
    await page.getByTestId('past-note').click()
    await page.getByTestId('chat-open').click()
    await page.getByTestId('chat-input').fill('When does the site go live?')
    await page.getByTestId('chat-input').press('Enter')
    await expect(page.getByTestId('chat-turn')).toHaveAttribute('data-status', 'done', { timeout: 15_000 })
    await expect(page.getByTestId('chat-answer')).toContainText('Hermes says: the site goes live on Tuesday.')
    const asked = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(asked.at(-1)).toMatchObject({ agent: 'hermes', permission: 'cancelled' })
    expect(asked.at(-1).prompt).toContain('When does the site go live?')
  } finally { await app.close() }
})
