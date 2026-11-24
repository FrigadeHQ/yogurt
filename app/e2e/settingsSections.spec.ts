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
      await page.emulateMedia({ colorScheme: null })
      await expect(page.getByTestId('home')).toBeVisible()
      await openFromCorner(page, 'nav-trash')
      const sidebar = page.locator('#workspace-sidebar')
      const width = await sidebar.evaluate(el => el.getBoundingClientRect().width)
      const collapsed = theme === 'dark'
      const toggle = page.getByTestId(collapsed ? 'sidebar-expand' : 'sidebar-collapse')
      if (!await toggle.isVisible()) await page.getByTestId(collapsed ? 'sidebar-collapse' : 'sidebar-expand').click()
      await openFromCorner(page, 'settings-open')
      await expect.poll(() => page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(theme === 'dark')
      const back = sidebar.getByRole('button', { name: 'Back', exact: true })
      const capture = async (section: string, name = section) => {
        const panel = page.getByTestId('settings-page-' + section)
        await expect(panel).toBeVisible()
        await expect(back).toBeInViewport()
        await expect(page.getByTestId('nav-home')).toHaveCount(0)
        await expect(sidebar.locator('button[aria-current="page"]')).toHaveCount(1)
        expect(await sidebar.boundingBox()).toMatchObject({ x: 0, width })
        const content = (await page.locator('.settings-scroll').boundingBox())!
        expect(content.x).toBe(width)
        expect(content.x + content.width).toBe(await page.evaluate(() => innerWidth))
        await expect(panel.locator('.loading-content:not([data-loading-phase="ready"])')).toHaveCount(0)
        await page.screenshot({ path: testInfo.outputPath(`settings-${name}-${theme}.png`), animations: 'disabled' })
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
        await expect(page.getByTestId('settings-page-' + event).getByRole('switch')).toHaveCount(2)
        await capture(event)
      }
      await page.getByTestId('settings-nav-meetings').click()
      await page.getByTestId('detect-meetings').click()
      await expect(page.getByTestId('autostop-toggle')).toBeDisabled()
      await page.getByTestId('settings-nav-notifications').click()
      for (const id of ['meeting-detected', 'call-ended']) {
        const row = page.getByTestId('notification-' + id)
        await expect(row).toBeDisabled()
        await expect(row).toContainText('Automatic meeting detection is off.')
      }
      await capture('notifications', 'notifications-detection-off')
      await page.getByTestId('notification-notes-ready').click()
      await expect(page.getByRole('switch', { name: 'Sound', exact: true })).toBeDisabled()
      await page.getByRole('switch', { name: 'System notification', exact: true }).click()
      await page.getByRole('switch', { name: 'Sound', exact: true }).click()
      await page.keyboard.press('ControlOrMeta+k')
      await expect(page.getByTestId('search-input')).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('search')).toHaveCount(0)
      await expect(page.getByTestId('settings-page-notes-ready')).toBeVisible()
      for (const exit of ['Back', 'Escape', 'ControlOrMeta+[']) {
        if (exit === 'Back') await back.click()
        else await page.keyboard.press(exit)
        await expect(page.getByTestId('trash-page')).toBeVisible()
        await expect(toggle).toBeVisible()
        await page.keyboard.press('ControlOrMeta+]')
        await expect(page.getByTestId('settings-page-notes-ready')).toBeVisible()
      }
      await page.reload()
      await expect(page.getByRole('switch', { name: 'Sound', exact: true })).toBeChecked()
    } finally { await app.close() }
  })
}
