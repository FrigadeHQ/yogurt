import { settingsSections } from '../src/shared/routes'
import { openFromCorner } from './cornerNavigation'
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Each computer's own words (forOs): a Mac keeps its text; Windows and Linux never read "Mac".
const main = join(import.meta.dirname, '../out/main/index.js')
const launch = (env: Record<string, string> = {}) =>
  electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-e2e-')), ...env } })

const WORDS = {
  win32: { theme: 'Match Windows', login: 'Open Yogurt when Windows starts', tray: 'Show Yogurt in the notification area' },
  linux: { theme: 'Match my system', login: 'Open Yogurt when you log in', tray: 'Show Yogurt in the tray' },
  darwin: { theme: 'Match my Mac', login: 'Open Yogurt when your Mac starts', tray: 'Show Yogurt in' },
}

for (const platform of ['win32', 'linux', 'darwin'] as const) {
  test(`@everywhere on ${platform}: the first run and Settings say this computer's own words`, async () => {
    const app = await launch({ YOGURT_FAKE_PLATFORM: platform, YOGURT_FAKE_PERMISSIONS: platform === 'darwin' ? 'granted' : 'unknown' })
    try {
      const page = await app.firstWindow()
      const mac = platform === 'darwin'
      await expect(page.getByText('Yogurt records calls without joining them and writes summaries on your computer afterward.')).toBeVisible({ timeout: 15_000 })
      await page.getByTestId('intro-next').click()
      // Windows and Linux ask for a calendar link in the first run (the Mac asks for its own calendar, granted here)
      if (!mac) await page.locator('[data-testid="onboarding-step"][data-step="calendar"]').getByTestId('step-later').click({ timeout: 15_000 })
      await expect(page.getByTestId('home')).toBeVisible({ timeout: 15_000 })
      await openFromCorner(page, 'settings-open')
      const settings = page.getByTestId('settings')
      const w = WORDS[platform]
      await expect(page.getByTestId('settings-theme').locator('option[value="system"]')).toHaveText(w.theme)
      await expect(page.getByTestId(mac ? 'settings-visibility' : 'menu-bar-toggle')).toHaveAccessibleName(w.tray)
      await expect(page.getByTestId(mac ? 'menu-bar-toggle' : 'settings-visibility')).toHaveCount(0)
      await expect(page.getByTestId('login-toggle')).toHaveAccessibleName(w.login)
      await page.getByTestId('settings-nav-storage').click()
      await expect(settings.getByText('Yogurt stores your meetings, notes and audio on this computer.')).toBeVisible()
      if (!mac) {
        for (const section of settingsSections) {
          await page.getByTestId('settings-nav-' + section).click()
          const panel = page.getByTestId('settings-page-' + section)
          await expect(panel).toBeVisible()
          await expect(panel).not.toContainText(/\bMac\b|menu bar|Finder|System Settings/)
        }
      }
    } finally { await app.close() }
  })
}
