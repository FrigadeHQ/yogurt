import { openFromCorner } from './cornerNavigation'
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('the compact sidebar keeps navigation and folder actions available, including at narrow widths', async () => {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-rail-')),
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.getByTestId('folder-create').click()
    await page.getByTestId('folder-name-input').fill('Standup')
    await page.getByTestId('folder-name-save').click()
    const corner = page.getByTestId('corner-menu-button')
    const footer = page.locator('.workspace-corner')
    await expect(footer).toHaveCSS('border-top-width', '1px')
    const markInset = () => corner.locator('svg path').evaluate(mark =>
      Math.round(mark.getBoundingClientRect().left - mark.closest('.workspace-corner')!.getBoundingClientRect().left))
    await expect.poll(markInset).toBe(21)
    const cornerY = (await corner.boundingBox())!.y
    await page.getByTestId('sidebar-collapse').click()
    await expect(page.getByTestId('nav-chat')).toBeVisible()
    await expect.poll(async () => (await page.locator('#workspace-sidebar').boundingBox())!.width).toBe(56)
    await expect.poll(markInset).toBe(17)
    await expect(corner).toHaveAccessibleName('Help and settings')
    expect((await corner.boundingBox())!.y).toBeCloseTo(cornerY, 0)
    await expect(page.getByTestId('nav-trash')).toHaveCount(0)
    await expect(page.getByTestId('settings-open')).toHaveCount(0)
    await expect(page.getByTestId('nav-chat')).toHaveAccessibleName('Ask')
    await page.getByTestId('nav-chat').click()
    await expect(page.getByTestId('workspace-heading')).toHaveText('Ask')
    await page.getByTestId('sidebar-folder-open').click({ button: 'right' })
    await expect(page.getByTestId('sidebar-folder-rename')).toBeVisible()
    await expect.poll(async () => (await page.getByTestId('sidebar-folder-menu').boundingBox())!.width).toBeGreaterThanOrEqual(180)
    await page.getByTestId('sidebar-folder-rename').click()
    await expect(page.getByTestId('folder-name-input')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('sidebar-folder-open')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('folder-title')).toHaveText('Standup')
    await page.getByTestId('search-open').click()
    await expect(page.getByTestId('search-input')).toBeVisible()
    await page.keyboard.press('Escape')
    await openFromCorner(page, 'settings-open')
    await expect(page.getByTestId('settings')).toBeVisible()
    await openFromCorner(page, 'nav-trash')
    await expect(page.getByTestId('workspace-heading')).toHaveText('Trash')
    await page.getByTestId('nav-chat').hover()
    const sidebar = page.locator('#workspace-sidebar')
    // Sample an actual transition at its midpoint, independent of runner frame scheduling.
    await sidebar.evaluate(el => el.addEventListener('transitionrun', function pauseWidth(event) {
      if (event.target !== el || (event as TransitionEvent).propertyName !== 'width') return
      for (const animation of el.getAnimations()) { animation.pause(); animation.currentTime = 100 }
      el.removeEventListener('transitionrun', pauseWidth)
    }))
    await page.getByTestId('sidebar-expand').click()
    await expect.poll(() => sidebar.evaluate(el => el.getAnimations().some(a => a.playState === 'paused'))).toBe(true)
    const intermediate = (await sidebar.boundingBox())!.width
    expect(intermediate).toBeGreaterThan(56)
    expect(intermediate).toBeLessThan(208)
    await page.getByTestId('sidebar-collapse').click()
    await expect.poll(async () => (await page.locator('#workspace-sidebar').boundingBox())!.width).toBe(56)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByTestId('sidebar-expand').click()
    await page.getByTestId('sidebar-collapse').click()
    expect(await page.locator('#workspace-sidebar').evaluate(el => getComputedStyle(el).transitionDuration)).toBe('0s')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(720, 700))
    await page.getByTestId('nav-home').click()
    const rail = await page.locator('#workspace-sidebar').boundingBox()
    const content = await page.locator('.workspace-content').boundingBox()
    expect(content!.x).toBe(rail!.x + rail!.width)
    expect(await page.locator('.workspace').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    expect(await page.locator('.workspace-sidebar-body').evaluate(el => getComputedStyle(el).overflowX)).toBe('hidden')
    await page.evaluate(() => window.yogurt.settings.setLanguage('ar'))
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
    const box = (await corner.boundingBox())!
    const mark = (await corner.locator('svg path').boundingBox())!
    expect(mark.x).toBeGreaterThanOrEqual(box.x)
    expect(mark.x + mark.width).toBeLessThanOrEqual(box.x + box.width)
    await corner.click()
    const menu = page.getByTestId('corner-menu')
    await expect(menu).toBeVisible()
    const popup = (await menu.boundingBox())!
    expect(popup.x).toBeGreaterThanOrEqual(0)
    expect(popup.y + popup.height).toBeLessThanOrEqual(box.y)
  } finally { await app.close() }
})
