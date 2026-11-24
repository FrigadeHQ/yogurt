import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { settingsSections } from '../src/shared/routes'
import { notificationEvents } from '../src/shared/notificationDelivery'
import { openFromCorner } from './cornerNavigation'

for (const theme of ['light', 'dark'] as const) {
  test(`Settings sections in ${theme}`, async ({}, testInfo) => {
    const profile = mkdtempSync(join(tmpdir(), 'yogurt-settings-'))
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({ welcomed: true, theme }))
    const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
      ...process.env, YOGURT_USER_DATA: profile, YOGURT_FAKE: '1',
    } })
    try {
      const page = await app.firstWindow()
      await expect(page.getByTestId('home')).toBeVisible()
      await openFromCorner(page, 'settings-open')
      await expect.poll(() => page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(theme === 'dark')
      const capture = async (section: string) => {
        const panel = page.getByTestId('settings-page-' + section)
        await expect(panel).toBeVisible()
        await expect(panel.locator('.loading-content:not([data-loading-phase="ready"])')).toHaveCount(0)
        await page.screenshot({ path: testInfo.outputPath(`settings-${section}-${theme}.png`), animations: 'disabled' })
      }
      for (const section of settingsSections) {
        const link = page.getByTestId('settings-nav-' + section)
        await link.click()
        await expect(link).toHaveAttribute('aria-current', 'page')
        await capture(section)
      }
      for (const event of notificationEvents) {
        await page.getByTestId('settings-nav-notifications').click()
        await page.getByTestId('notification-' + event).click()
        await expect(page.getByRole('switch')).toHaveCount(2)
        await capture(event)
      }
    } finally { await app.close() }
  })
}
