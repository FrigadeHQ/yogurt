import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('a failed notes-model download explains waiting notes and answers, and retry leaves recording usable', async () => {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-model-recovery-')),
    YOGURT_FAKE_NOTES_MODEL_FAIL_ONCE: '1', YOGURT_FAKE_NOTES_MODEL_MS: '4000',
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    // The actual setup controller owns the failed download and all progress events.
    // Reject one Retry transport request, then let the real handler recover it.
    await app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as typeof ipcMain & { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers
      const retry = handlers.get('setup:retry')!
      let rejectOnce = true
      ipcMain.removeHandler('setup:retry')
      ipcMain.handle('setup:retry', (...args) => {
        if (rejectOnce) { rejectOnce = false; throw new Error('retry transport failed') }
        return retry(...args)
      })
    })
    await page.getByTestId('new-note').or(page.getByTestId('past-empty').getByRole('button')).first().click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    const id = (await page.evaluate(() => window.yogurt.nav.current())).slice('/note/'.length)
    await expect.poll(async () => (await page.evaluate((id) => window.yogurt.transcript.get(id), id)).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2)
    await page.getByTestId('chat-open').click()
    await page.getByTestId('chat-input').fill('What was decided?')
    await page.getByTestId('chat-input').press('Enter')
    const chatError = page.getByTestId('chat-turn').last().getByTestId('notes-model-error')
    await expect(chatError).toContainText('needs 4 GB more free space')
    await expect(chatError.getByTestId('notes-model-retry')).toHaveClass('text-action')
    await expect(chatError).toHaveAttribute('role', 'status')
    await expect(page.locator('.ask-conversation')).toHaveAttribute('aria-busy', 'false')
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    const cancel = page.getByTestId('chat-stop')
    await expect(cancel).toHaveAccessibleName('Cancel question')
    await expect(cancel).toHaveAttribute('title', 'Cancel question')
    await expect(cancel).not.toHaveCSS('background-color', 'rgb(111, 0, 255)')
    await cancel.click()
    await expect(page.getByTestId('chat-turn')).toHaveAttribute('data-status', 'stopped')
    await expect(page.getByTestId('chat-question')).toHaveText('What was decided?')
    await expect(page.getByTestId('chat-turn')).toContainText('Stopped before answering')
    await expect(cancel).toHaveCount(0)
    await page.getByTestId('chat-input').fill('What are my next steps?')
    await page.getByTestId('chat-input').press('Enter')
    await expect(page.getByTestId('chat-turn')).toHaveCount(2)
    await expect(chatError).toBeVisible()
    await expect(cancel).toHaveAccessibleName('Cancel question')
    await expect.poll(() => page.getByTestId('chat-panel').evaluate((panel) => {
      const reading = document.querySelector('.note-reading-area')!.getBoundingClientRect()
      return panel.getBoundingClientRect().top - reading.top
    })).toBeGreaterThanOrEqual(11)
    await page.getByTestId('note-stop').click()
    await page.getByTestId('note-summary-tab').click()
    await page.getByTestId('chat-close').click()
    await expect(page.getByTestId('chat-panel')).toHaveCount(0)
    await expect.poll(() => page.evaluate(id => window.yogurt.notes.get(id).then(notes => notes.status), id)).toBe('waiting')
    await expect(page.getByTestId('notes-model-error')).toHaveCount(1)
    await expect(page.getByTestId('notes-model-error')).toContainText('needs 4 GB more free space')
    await expect(page.getByTestId('notes-model-retry')).toHaveClass('text-action')
    await expect(page.getByTestId('note-enhanced-waiting')).toHaveCount(0)
    // A rejected Retry request remains visible and retryable instead of escaping the click handler.
    await page.getByTestId('notes-model-retry').click()
    await expect(page.getByTestId('notes-model-error')).toContainText("Yogurt couldn't restart the download.")
    await expect(page.getByTestId('notes-model-retry')).toBeEnabled()
    await page.getByTestId('chat-open').click()
    await expect(chatError).toBeVisible()
    await chatError.getByTestId('notes-model-retry').click()
    await expect(page.getByTestId('notes-model-error')).toHaveCount(0)
    await expect(page.getByTestId('note-enhanced-model-download').or(page.getByTestId('note-enhanced-waiting'))).toContainText(/waiting for Yogurt's AI to download|Reading the transcript/)
    await expect(page.getByTestId('note-enhanced')).toHaveAttribute('data-status', 'done', { timeout: 45_000 })
    await expect(page.getByTestId('chat-turn').last()).toContainText('Tuesday', { timeout: 30_000 })
    await expect(page.getByTestId('chat-turn').first()).toHaveAttribute('data-status', 'stopped')
    await expect(page.getByTestId('chat-turn').first().getByTestId('chat-question')).toHaveText('What was decided?')
  } finally { await app.close() }
})
