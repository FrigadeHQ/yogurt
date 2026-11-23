import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('Edit summary applies a note to the summary as it is, keeps hand edits, reads the transcript only when ticked, and Undo puts it back', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-edit-summary-'))
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData, YOGURT_FAKE_LLM_MS: '2',
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    await app.evaluate(() => (globalThis as unknown as { __fake__: { manyMeetings(o: { n: number; clean: boolean }): void } }).__fake__.manyMeetings({ n: 1, clean: true }))
    await page.reload()
    await page.getByTestId('past-note').click()
    const editor = page.getByTestId('note-enhanced-editor')
    const mine = 'Ann owns QA for the launch.'
    await editor.fill(mine)
    await expect(page.getByTestId('note-save-status')).toHaveAttribute('data-state', 'saved')

    const open = async () => {
      await page.getByTestId('note-menu-button').click()
      await page.getByTestId('note-write-again').click()
      await expect(page.getByRole('dialog', { name: 'Edit or regenerate summary' })).toBeVisible()
    }
    await open()
    // only Regenerate replaces their edits; Edit needs a note
    await expect(page.getByTestId('note-confirm')).toHaveText('Regenerate replaces your edits to the summary. Edit keeps them.')
    await expect(page.getByTestId('note-edit-confirm')).toBeDisabled()
    await expect(page.getByTestId('note-edit-transcript-warning')).toHaveCount(0)
    await page.getByTestId('note-regenerate-input').fill('add the budget')
    await page.getByTestId('note-edit-confirm').click()
    await expect(page.getByTestId('note-regenerate')).toHaveCount(0)
    await expect(editor).toContainText('Edited without the transcript: add the budget.')
    await expect(editor).toContainText(mine)
    await expect(page.getByTestId('note-enhanced')).toHaveAttribute('data-status', 'done')

    // Undo: the summary as it was before the edit, their own edit included
    await expect(page.getByTestId('summary-edited-toast')).toBeVisible()
    await page.getByTestId('summary-edit-undo').click()
    await expect(editor).toHaveText(mine)
    await expect(page.getByTestId('summary-edited-toast')).toHaveCount(0)

    await open()
    await page.getByTestId('note-regenerate-input').fill('add the budget')
    await page.getByTestId('note-edit-transcript').check()
    await expect(page.getByTestId('note-edit-transcript-warning')).toContainText('a long meeting may not fit it')
    await page.getByTestId('note-edit-confirm').click()
    await expect(editor).toContainText('Edited with the transcript: add the budget.')
    await expect(editor).toContainText(mine)
    // the edit is saved: it is there after the window loads the note again
    await page.reload()
    await expect(page.getByTestId('note')).toBeVisible()
    await page.getByTestId('note-summary-tab').click()
    await expect(page.getByTestId('note-enhanced-editor')).toContainText('Edited with the transcript: add the budget.')
  } finally { await app.close() }
})
