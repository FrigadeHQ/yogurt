import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MARK } from '../src/shared/logo'

const main = join(import.meta.dirname, '../out/main/index.js')

test('@everywhere opens a window called Yogurt with the app shell', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await expect(page).toHaveTitle('Yogurt')
    // the bridge is there, and knows it's a test run
    expect(await page.evaluate(() => window.yogurt.fake)).toBe(true)
  } finally { await app.close() }
})

test('@everywhere shows the Yogurt mark at launch and on the sidebar menu button', async ({}, info) => {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const app = await electron.launch({ args: [main], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData, YOGURT_FAKE_BOOT_MS: '8000',
  } })
  try {
    const page = await app.firstWindow()
    const launch = page.getByRole('status', { name: 'Yogurt', exact: true })
    const launchMark = launch.locator('svg')
    await expect(launchMark).toBeVisible()
    await expect(launchMark.locator('path')).toHaveAttribute('d', MARK)
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await page.screenshot({ path: info.outputPath(`brand-launch-${colorScheme}.png`) })
    }

    await expect(page.getByTestId('home')).toBeVisible({ timeout: 15_000 })
    await expect(launch).toHaveCount(0)
    const sidebar = page.getByRole('complementary', { name: 'Main navigation', exact: true })
    const button = sidebar.getByRole('button', { name: 'Help and settings', exact: true })
    await expect(button).toBeVisible()
    const cornerMark = button.locator('svg path')
    await expect(cornerMark).toBeVisible()
    await expect(cornerMark).toHaveAttribute('d', MARK)
    await expect(button.locator('svg')).toHaveAttribute('width', '18')
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await page.screenshot({ path: info.outputPath(`brand-corner-${colorScheme}.png`) })
      await button.click()
      await expect(page.getByTestId('corner-menu')).toBeVisible()
      await page.screenshot({ path: info.outputPath(`brand-corner-menu-${colorScheme}.png`) })
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('corner-menu')).toBeHidden()
    }
  } finally { await app.close() }
})
