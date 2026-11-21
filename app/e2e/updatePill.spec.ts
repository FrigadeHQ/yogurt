import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function launch(root = mkdtempSync(join(tmpdir(), 'yogurt-update-')), version = '9.9.9') {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: root,
    YOGURT_FAKE_UPDATE: version,
  } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page }
}
const restarts = (app: Awaited<ReturnType<typeof launch>>['app']) =>
  app.evaluate(() => (globalThis as any).__fake__.main().updateRestarts as number)

test('The corner button opens the approved menu by keyboard and offers a ready update last', async () => {
  const { app, page } = await launch()
  try {
    const button = page.getByRole('button', { name: 'Help and settings' })
    const menu = page.getByRole('menu', { name: 'Yogurt menu' })
    const badge = page.getByTestId('corner-notice-dot')
    await expect(button).toHaveAccessibleDescription('Update ready')
    await expect(badge).toBeVisible()
    await expect(page.getByTestId('update-toast')).toHaveCount(0)
    expect(await button.getAttribute('title')).toBeNull()
    const tip = page.getByRole('tooltip')
    await button.hover()
    await expect(tip).toHaveText('Help and settings')
    await page.mouse.move(600, 80)
    await expect(tip).toBeHidden()
    await page.keyboard.press('Tab')
    await button.focus()
    await expect(tip).toHaveText('Help and settings')
    for (const key of ['Enter', 'Space']) {
      await button.focus()
      await page.keyboard.press(key)
      await expect(menu.getByRole('menuitem')).toHaveText([
        /What's new/, 'Star us on GitHub', 'Join Discord', /Keyboard shortcuts/,
        'Send feedback', 'Help', /Settings/, /Trash/, 'Restart to update · 9.9.9',
      ])
      await expect(badge).toHaveCount(0)
      await expect(tip).toBeHidden()
      await expect(menu.getByRole('separator')).toHaveCount(0)
      await page.keyboard.press('Home')
      await expect(menu.getByRole('menuitem').first()).toBeFocused()
      await page.keyboard.press('ArrowDown')
      await expect(menu.getByRole('menuitem', { name: 'Star us on GitHub' })).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(menu).toHaveCount(0)
      await expect(button).toBeFocused()
    }
    await button.click()
    await page.getByTestId('corner-shortcuts').click()
    await expect(page.getByTestId('shortcuts-dialog').getByRole('textbox')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(button).toBeFocused()
    expect(await restarts(app)).toBe(0)
    await button.click()
    await page.getByTestId('update-restart').click()
    await expect.poll(() => restarts(app)).toBe(1)
    await expect(badge).toHaveCount(0)
    await expect(menu).toHaveCount(0)
    await button.click()
    await expect(menu.getByRole('menuitem')).toHaveCount(8)
  } finally { await app.close() }
})

test('unseen updates are badged during recording and ending recording only enables Restart', async () => {
  const { app, page } = await launch()
  try {
    await page.evaluate(() => window.yogurt.meetings.start(null))
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    const button = page.getByTestId('corner-menu-button')
    await expect(button.getByTestId('corner-notice-dot')).toBeVisible()
    await expect(page.getByTestId('note-menu-button')).toBeVisible()
    await button.click()
    await expect(page.getByTestId('update-restart')).toContainText('You can restart after recording')
    await expect(page.getByTestId('update-restart')).toBeDisabled()
    await page.keyboard.press('Escape')
    await page.getByTestId('note-pause').click()
    await expect(page.getByTestId('note-pause')).toHaveAccessibleName('Resume recording')
    await button.click()
    await expect(page.getByTestId('update-restart')).toBeDisabled()
    await page.keyboard.press('Escape')
    await page.getByTestId('note-stop').click()
    await button.click()
    await expect(page.getByTestId('update-restart')).toBeEnabled()
    expect(await restarts(app)).toBe(0)
  } finally { await app.close() }
})

for (const failure of ['false', 'reject'] as const) test(`keeps the update ready when restart returns ${failure}`, async () => {
  const { app, page } = await launch()
  try {
    await app.evaluate(({ ipcMain }, failure) => {
      ipcMain.removeHandler('updates:restart')
      ipcMain.handle('updates:restart', () => { if (failure === 'reject') throw new Error('unavailable'); return false })
    }, failure)
    await page.getByTestId('corner-menu-button').click(); await page.getByTestId('update-restart').click()
    await expect(page.getByTestId('corner-menu').getByRole('alert')).toHaveText("Yogurt couldn't restart. Try again.")
    await expect(page.getByTestId('corner-notice-dot')).toHaveCount(0)
    await expect(page.getByTestId('update-restart')).toBeEnabled()
    expect(await restarts(app)).toBe(0)
  } finally { await app.close() }
})

test('keeps update and AI download controls visible available in their respective controls', async () => {
  const { app, page } = await launch()
  try {
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      const state = { phase: 'ready', fraction: 1, notesUpgradeDownloading: true, notesUpgradeFraction: .27 }
      ipcMain.removeHandler('setup:state'); ipcMain.handle('setup:state', () => state)
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('setup:state', state)
    })
    await expect(page.getByTestId('notes-setup-open')).toBeVisible()
    for (const width of [1200, 800, 720]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 800), width)
      await expect.poll(() => page.evaluate(() => {
        const corner = document.querySelector('[data-testid="corner-menu-button"]')!.getBoundingClientRect()
        const ai = document.querySelector('[data-testid="notes-setup-open"]')!.getBoundingClientRect()
        const action = document.querySelector('#workspace-actions button')!.getBoundingClientRect()
        return corner.width >= 28 && corner.top > ai.bottom && ai.width >= 44 && ai.right <= action.left && action.right <= innerWidth
      })).toBe(true)
    }
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByTestId('corner-menu-button').click()
    await expect(page.getByTestId('corner-menu')).toHaveCSS('transform', 'none')
    await page.keyboard.press('Escape')
    await app.evaluate(() => (globalThis as any).__fake__.manyMeetings({ n: 1, clean: true }))
    await page.evaluate(async () => {
      const [card] = await window.yogurt.meetings.cards({ limit: 1 })
      await window.yogurt.meetings.trash(card.id)
      await window.yogurt.meetings.start(null)
      await window.yogurt.nav.go('/trash')
    })
    await expect(page.getByTestId('trash-empty')).toBeVisible()
    await expect(page.getByTestId('recording-return')).toBeVisible()
    for (const locale of ['en', 'de', 'ar']) {
      await page.evaluate(locale => window.yogurt.settings.setLanguage(locale), locale)
      await expect(page.locator('html')).toHaveAttribute('lang', locale)
      for (const collapsed of [false, true]) {
        const toggle = page.locator('.workspace-sidebar-toggle')
        if (await toggle.getAttribute('aria-expanded') !== String(!collapsed)) await toggle.click()
        await expect.poll(() => page.evaluate(() => {
          const controls = [...document.querySelectorAll<HTMLElement>('[data-testid="corner-menu-button"], [data-testid="notes-setup-open"], [data-testid="recording-return"], [data-testid="trash-empty"], .workspace-sidebar-toggle')]
          return controls.length === 5 && controls.every((control, index) => {
            const box = control.getBoundingClientRect()
            return box.width >= (control.matches('.workspace-sidebar-toggle, .corner-trigger') ? 28 : 44)
              && box.x >= 0 && box.right <= innerWidth
              && control.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
              && controls.slice(index + 1).every(other => {
                const rect = other.getBoundingClientRect()
                return box.right <= rect.x || box.x >= rect.right || box.bottom <= rect.y || box.y >= rect.bottom
              })
          })
        })).toBe(true)
      }
    }
  } finally { await app.close() }
})


test('Later survives a renderer reload but Settings still offers Restart', async () => {
  const { app, page } = await launch()
  try {
    await expect(page.getByTestId('corner-notice-dot')).toBeVisible()
    await page.getByTestId('corner-menu-button').click()
    await expect(page.getByTestId('corner-menu')).toBeVisible()
    await page.getByTestId('update-restart').press('Escape')
    await expect(page.getByTestId('corner-menu')).toHaveCount(0)
    await page.evaluate(() => window.yogurt.updates.later())
    await expect(page.getByTestId('corner-notice-dot')).toHaveCount(0)
    expect(await restarts(app)).toBe(0)
    await page.reload(); await expect(page.getByTestId('home')).toBeVisible()
    await expect(page.getByTestId('corner-notice-dot')).toHaveCount(0)
    await page.evaluate(() => window.yogurt.nav.go('/settings'))
    await expect(page.getByTestId('updates-restart')).toBeVisible()
    await expect(page.getByTestId('updates-state')).toHaveAttribute('data-state', 'ready')
    await expect(page.getByTestId('updates-toggle')).toHaveAttribute('aria-checked', 'true')
    await page.getByTestId('updates-restart').click()
    await expect.poll(() => restarts(app)).toBe(1)
  } finally { await app.close() }
})

test('opening What\'s new marks that release read across reloads and a newer version restores both indicators', async () => {
  // Use the real fake updater for both reads and broadcasts, above Electron's development version.
  const { app, page } = await launch(undefined, '999.0.0')
  try {
    await expect(page.getByTestId('corner-notice-dot')).toBeVisible()
    const button = page.getByTestId('corner-menu-button')
    const news = page.getByRole('menuitem', { name: /What's new/ })
    await button.click()
    await expect(news.getByText('New', { exact: true })).toBeVisible()
    await news.click()
    await expect(page.getByTestId('corner-menu')).toHaveCount(0)
    await page.reload()
    await button.click()
    await expect(news.getByText('New', { exact: true })).toHaveCount(0)
    await expect(page.getByTestId('corner-menu')).toBeVisible()
    await page.getByTestId('update-restart').press('Escape')
    await expect(page.getByTestId('corner-menu')).toHaveCount(0)
    await page.evaluate(() => window.yogurt.updates.later())
    await expect(page.getByTestId('corner-notice-dot')).toHaveCount(0)
    const state = await page.evaluate(() => window.yogurt.updates.status())
    expect(state).toMatchObject({ next: '999.0.0', dismissed: true })
    await app.evaluate(({ BrowserWindow }, previous) => {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('updates:status', {
        ...previous, next: '999.0.1', dismissed: false,
      })
    }, state)
    await expect(page.getByTestId('corner-notice-dot')).toBeVisible()
    await page.getByTestId('corner-menu-button').click()
    await expect(page.getByTestId('corner-notice-dot')).toHaveCount(0)
    await expect(news.getByText('New', { exact: true })).toBeVisible()
    await expect(page.getByTestId('update-restart')).toHaveText('Restart to update · 999.0.1')
  } finally { await app.close() }
})

test('restarting the app offers the same ready version again', async () => {
  const root = mkdtempSync(join(tmpdir(), 'yogurt-update-session-'))
  const first = await launch(root)
  try {
    await expect(first.page.getByTestId('corner-notice-dot')).toBeVisible()
    await first.page.getByTestId('corner-menu-button').click()
    await first.page.keyboard.press('Escape')
    await expect(first.page.getByTestId('corner-notice-dot')).toHaveCount(0)
  } finally { await first.app.close() }
  const second = await launch(root)
  try {
    expect((await second.page.evaluate(() => window.yogurt.updates.status())).state).toBe('ready')
    await expect(second.page.getByTestId('corner-notice-dot')).toHaveCount(0)
    await second.page.getByTestId('corner-menu-button').click()
    await expect(second.page.getByTestId('update-restart')).toHaveText('Restart to update · 9.9.9')
    await second.page.keyboard.press('Escape')
    await expect(second.page.getByTestId('corner-notice-dot')).toHaveCount(0)
  }
  finally { await second.app.close() }
})
