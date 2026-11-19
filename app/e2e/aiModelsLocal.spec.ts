import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const launch = async (env: Record<string, string> = {}) => {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-ai-local-'))
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData, YOGURT_FAKE_LLM_MS: '2', YOGURT_FAKE_AGENTS: join(import.meta.dirname, '../test/fixtures/agents'), ...env,
  } })
  return { app, userData, page: await app.firstWindow() }
}
const meeting = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __fake__: { manyMeetings(o: { n: number; clean: boolean }): void } }).__fake__.manyMeetings({ n: 1, clean: true }))
const files = (dir: string) => existsSync(dir) ? readdirSync(dir) : []

test('a Mac no notes model fits goes on without Yogurt AI, and its summaries wait for the AI picked for them', async () => {
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
    // picked: the summary that waited is written by it
    await page.getByTestId('ai-task-notes').selectOption('hermes')
    await page.getByTestId('nav-home').click()
    await page.getByTestId('past-note').click()
    await page.getByTestId('note-menu-button').click()
    await page.getByTestId('note-write-again').click()
    await page.getByTestId('note-write-again-confirm').click()
    await expect(page.getByTestId('note-enhanced-editor')).toContainText('Hermes notes', { timeout: 15_000 })
  } finally { await app.close() }
})

test('Settings → AI models: Yogurt AI removed and downloaded again; another speech model downloads and takes over', async () => {
  const { app, userData, page } = await launch()
  try {
    await expect(page.getByTestId('home')).toBeVisible({ timeout: 15_000 })
    await page.evaluate(() => window.yogurt.nav.go('/settings'))
    const status = page.getByTestId('ai-local-status')
    await expect(status).toHaveText('On this computer, so it works offline. Remove it to free its space.', { timeout: 15_000 })
    const llm = join(userData, 'models', 'llm')
    expect(files(llm).length).toBeGreaterThan(0)
    await page.getByTestId('ai-local-remove').click()
    await expect(status).toHaveText('Not on this computer. Tasks set to it wait until you download it.')
    await expect.poll(() => files(llm).filter((f) => !f.endsWith('.part'))).toEqual([])
    await expect(page.getByTestId('ai-task-notes').locator('option').first()).toHaveText('Yogurt AI (not on this computer)')
    expect(JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')).localNotes).toBe(false)
    await page.getByTestId('ai-local-download').click()
    await expect(status).toHaveText('On this computer, so it works offline. Remove it to free its space.', { timeout: 15_000 })
    await expect(page.getByTestId('ai-task-notes').locator('option').first()).toHaveText('Yogurt AI on this Mac')

    const speech = page.getByTestId('ai-speech')
    await expect(speech.locator('option')).toHaveText(['Auto (Whisper large-v3-turbo)', 'Whisper large-v3-turbo · 574 MB', 'Whisper small · 190 MB', 'Whisper base · 60 MB', 'Whisper tiny · 32 MB'])
    await expect(page.getByTestId('ai-speech-status')).toHaveText('Always on this computer. Transcribing with Whisper large-v3-turbo.')
    await speech.selectOption('whisper-small-q5_1')
    await expect(page.getByTestId('ai-speech-status')).toHaveText('Always on this computer. Transcribing with Whisper small.', { timeout: 15_000 })
    const asr = files(join(userData, 'models', 'asr'))
    expect(asr.some((f) => f.includes('small'))).toBe(true)
    expect(asr.some((f) => f.includes('turbo'))).toBe(false)
    expect(JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')).speechModel).toBe('whisper-small-q5_1')
  } finally { await app.close() }
})
