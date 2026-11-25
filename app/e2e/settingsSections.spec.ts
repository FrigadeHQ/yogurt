import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { settingsSections } from '../src/shared/routes'
import { TRASH_DAYS } from '../src/shared/trash'
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
      const back = sidebar.getByRole('button', { name: 'Back to app', exact: true })
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
        if (section === 'storage') {
          await expect(panel.getByText(`Meetings you remove stay in the Trash for ${TRASH_DAYS} days, then they're deleted for good.`, { exact: true })).toBeVisible()
          await expect(panel.getByRole('button', { name: 'Trash', exact: true })).toHaveCount(0)
        }
        await page.screenshot({ path: testInfo.outputPath(`settings-${name}-${theme}.png`), animations: 'disabled' })
      }
      for (const section of settingsSections) {
        const link = page.getByTestId('settings-nav-' + section)
        await link.click()
        await expect(link).toHaveAttribute('aria-current', 'page')
        await capture(section)
      }
      const filter = page.getByRole('textbox', { name: 'Search settings' })
      await page.keyboard.press('ControlOrMeta+f')
      await expect(filter).toBeFocused()
      await filter.fill('language')
      await expect(sidebar.locator('.settings-nav-result')).toHaveText(['App language', 'Language', 'Summary language', 'Spoken language'])
      await sidebar.getByRole('button', { name: 'Summary language', exact: true }).click()
      await expect(page.getByTestId('settings-summary-language')).toBeFocused()
      const scroll = page.locator('.settings-scroll')
      const pos = await scroll.evaluate(el => el.scrollTop)
      await openFromCorner(page, 'settings-open')
      await expect(filter).toHaveValue('language')
      await expect(page.getByTestId('settings-page-recording')).toBeVisible()
      expect(await scroll.evaluate(el => el.scrollTop)).toBe(pos)
      await filter.fill('Trash')
      await expect(sidebar.getByRole('status')).toHaveText('No settings match')
      await filter.press('Escape')
      await expect(filter).toHaveValue('')
      await expect(page.getByTestId('settings-page-recording')).toBeVisible()
      for (const section of settingsSections) {
        const name = await page.getByTestId('settings-nav-' + section).innerText()
        await page.keyboard.press('ControlOrMeta+k')
        await expect(page.locator('[data-testid^="command-settings-"] .command-label')).toHaveText(['General', 'Notifications', 'Recording & notes', 'Connections', 'Storage & backup'])
        await page.getByTestId('search-input').fill(name)
        const command = page.getByTestId('command-settings-' + section)
        await expect(command).toHaveAttribute('aria-selected', 'true')
        await page.keyboard.press('Enter')
        await expect(page.getByTestId('search')).toHaveCount(0)
        await expect(page.getByTestId('settings-page-' + section)).toBeVisible()
      }
      await page.getByTestId('settings-nav-notifications').click()
      await page.getByTestId('detect-meetings').click()
      await expect(page.getByTestId('autostop-toggle')).toBeDisabled()
      await expect(page.getByTestId('autostop-toggle')).toBeChecked()
      await capture('notifications', 'notifications-detection-off')
      await page.keyboard.press('ControlOrMeta+k')
      await expect(page.getByTestId('search-input')).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('search')).toHaveCount(0)
      await expect(page.getByTestId('settings-page-notifications')).toBeVisible()
      for (const exit of ['Back', 'Escape', 'ControlOrMeta+[']) {
        if (exit === 'Back') await back.click()
        else await page.keyboard.press(exit)
        await expect(page.getByTestId('trash-page')).toBeVisible()
        await expect(toggle).toBeVisible()
        await page.keyboard.press('ControlOrMeta+]')
        await expect(page.getByTestId('settings-page-notifications')).toBeVisible()
      }
      await page.reload()
      await expect(page.getByTestId('detect-meetings')).not.toBeChecked()
      await expect(page.getByTestId('autostop-toggle')).toBeDisabled()
    } finally { await app.close() }
  })
}
