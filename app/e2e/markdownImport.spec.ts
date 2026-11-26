import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openFromCorner } from './cornerNavigation'

test('review Markdown files in Settings, supply a missing date, import and re-import', async () => {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-md-')),
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    await openFromCorner(page, 'settings-open')
    const section = page.getByTestId('markdown-import')
    const files = [
      { name: '2026-02-17 first.md', mimeType: 'text/markdown', buffer: Buffer.from('# Synthetic planning\n\nOriginal **text**.') },
      { name: 'Other.md', mimeType: 'text/markdown', buffer: Buffer.from('Another note.') },
    ]
    const review = async () => {
      await section.locator('input[type=file]').setInputFiles(files)
      await expect(section.getByLabel('Title').first()).toHaveValue('Synthetic planning')
      await expect(section.getByLabel('Date').first()).toHaveValue('2026-02-17')
      const confirm = section.getByRole('button', { name: 'Import notes', exact: true })
      await expect(confirm).toBeDisabled()
      await section.getByLabel('Date').nth(1).fill('2026-02-19')
      await confirm.click()
    }
    await review()
    await expect(section.getByRole('status')).toContainText('Added 2 meetings.')
    await review()
    await expect(section.getByRole('status')).toContainText('2 were already here.')
    await page.getByTestId('nav-home').click()
    await page.getByTestId('past-note').filter({ hasText: 'Synthetic planning' }).click()
    await page.getByTestId('note-summary-tab').click()
    await expect(page.getByTestId('note-enhanced-editor')).toContainText('Original text.')
  } finally { await app.close() }
})
