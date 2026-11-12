import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')

async function launch(o: { settings?: object; env?: Record<string, string> } = {}) {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  if (o.settings) writeFileSync(join(userData, 'settings.json'), JSON.stringify(o.settings))
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData, ...o.env } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  await page.getByTestId('settings-open').click()
  return { app, page, userData }
}
const saved = (userData: string) => JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')).betterNotes

test('Settings shows the bigger notes model downloading, then in use; off and on again keeps the choice', async () => {
  const { app, page, userData } = await launch({ env: { YOGURT_FAKE_NOTES_MODEL_MS: '2000' } })
  try {
    const row = page.getByTestId('better-notes')
    await expect(row).toHaveAttribute('data-status', 'downloading', { timeout: 15_000 })
    await expect(page.getByTestId('better-notes-status')).toContainText(/GB/)
    await expect(row).toHaveAttribute('data-status', 'ready', { timeout: 15_000 })
    await expect(page.getByTestId('better-notes-status')).toHaveText('In use for notes')

    const toggle = page.getByTestId('better-notes-toggle')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect(row).toHaveAttribute('data-status', 'off')
    await expect.poll(() => saved(userData)).toBe(false)

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect(row).toHaveAttribute('data-status', 'ready')
    await expect.poll(() => saved(userData)).toBeUndefined()
  } finally { await app.close() }
})

test('turned off before: it stays off and nothing bigger downloads', async () => {
  const { app, page } = await launch({ settings: { betterNotes: false } })
  try {
    await expect(page.getByTestId('better-notes')).toHaveAttribute('data-status', 'off')
    await expect(page.getByTestId('better-notes-toggle')).toHaveAttribute('aria-checked', 'false')
    await expect(page.getByTestId('better-notes-status')).toHaveText('Notes use the smaller model.')
  } finally { await app.close() }
})
