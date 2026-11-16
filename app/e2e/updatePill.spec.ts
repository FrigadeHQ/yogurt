import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function launch(root = mkdtempSync(join(tmpdir(), 'yogurt-update-'))) {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: root,
    YOGURT_FAKE_UPDATE: '9.9.9',
  } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page }
}
const restarts = (app: Awaited<ReturnType<typeof launch>>['app']) =>
  app.evaluate(() => (globalThis as any).__fake__.main().updateRestarts as number)

test('a ready version is visible immediately and can restart', async () => {
  const { app, page } = await launch()
  try {
    const pill = page.getByTestId('update-ready'), popup = page.getByTestId('update-popover')
    await expect(pill).toHaveText('Update ready')
    await expect(page.getByTestId('update-toast')).toHaveCount(0)
    await pill.click()
    await expect(popup).toContainText('Yogurt 9.9.9')
    await expect(popup).toContainText('Installs when you restart Yogurt')
    await page.keyboard.press('Escape')
    await expect(popup).toHaveCount(0); await expect(pill).toBeVisible()
    expect(await restarts(app)).toBe(0)
    await pill.focus(); await page.keyboard.press('Enter')
    await expect(popup).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(pill).toBeFocused()
    await pill.click(); await page.getByTestId('update-restart').click()
    await expect.poll(() => restarts(app)).toBe(1)
    await expect(pill).toHaveCount(0)
  } finally { await app.close() }
})

test('the pill stays visible while recording and ending recording only enables Restart', async () => {
  const { app, page } = await launch()
  try {
    await page.evaluate(() => window.yogurt.meetings.start(null))
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    await page.getByTestId('update-ready').click()
    await expect(page.getByTestId('update-popover')).toContainText('You can restart after recording')
    await expect(page.getByTestId('update-restart')).toBeDisabled()
    await page.keyboard.press('Escape'); await page.getByTestId('note-stop').click()
    await page.getByTestId('update-ready').click()
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
    await page.getByTestId('update-ready').click(); await page.getByTestId('update-restart').click()
    await expect(page.getByTestId('update-popover').getByRole('alert')).toHaveText("Yogurt couldn't restart. Try again.")
    await expect(page.getByTestId('update-ready')).toBeVisible()
    await expect(page.getByTestId('update-restart')).toBeEnabled()
    expect(await restarts(app)).toBe(0)
  } finally { await app.close() }
})

test('keeps update and AI download controls visible together before the main action', async () => {
  const { app, page } = await launch()
  try {
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      const state = { phase: 'ready', fraction: 1, notesUpgradeDownloading: true, notesUpgradeFraction: .27 }
      ipcMain.removeHandler('setup:state'); ipcMain.handle('setup:state', () => state)
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('setup:state', state)
    })
    await expect(page.getByTestId('notes-setup-open')).toBeVisible()
    for (const width of [1200, 800]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 800), width)
      await expect.poll(() => page.evaluate(() => {
        const update = document.querySelector('[data-testid="update-ready"]')!.getBoundingClientRect()
        const ai = document.querySelector('[data-testid="notes-setup-open"]')!.getBoundingClientRect()
        const action = document.querySelector('#workspace-actions button')!.getBoundingClientRect()
        return update.width >= 44 && ai.width >= 44 && update.right <= ai.left && ai.right <= action.left && action.right <= innerWidth
      })).toBe(true)
    }
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByTestId('update-ready').click()
    await expect(page.getByTestId('update-popover')).toHaveCSS('transform', 'none')
  } finally { await app.close() }
})


test('Later survives a renderer reload but Settings still offers Restart', async () => {
  const { app, page } = await launch()
  try {
    await page.getByTestId('update-ready').click(); await page.getByTestId('update-later').click()
    await expect(page.getByTestId('update-ready')).toHaveCount(0)
    await expect(page.getByTestId('update-popover')).toHaveCount(0)
    expect(await restarts(app)).toBe(0)
    await page.reload(); await expect(page.getByTestId('home')).toBeVisible()
    await expect(page.getByTestId('update-ready')).toHaveCount(0)
    await page.evaluate(() => window.yogurt.nav.go('/settings'))
    await expect(page.getByTestId('updates-restart')).toBeVisible()
    await expect(page.getByTestId('updates-state')).toHaveAttribute('data-state', 'ready')
    await expect(page.getByTestId('updates-toggle')).toHaveAttribute('aria-checked', 'true')
    await page.getByTestId('updates-restart').click()
    await expect.poll(() => restarts(app)).toBe(1)
  } finally { await app.close() }
})

test('a newer ready version is visible after Later', async () => {
  const { app, page } = await launch()
  try {
    await page.getByTestId('update-ready').click(); await page.getByTestId('update-later').click()
    await expect(page.getByTestId('update-ready')).toHaveCount(0)
    await app.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('updates:status', {
        state: 'ready', version: '0.3.1', next: '9.9.10', available: true, on: true, dismissed: false,
      })
    })
    await page.getByTestId('update-ready').click()
    await expect(page.getByTestId('update-popover')).toContainText('Yogurt 9.9.10')
  } finally { await app.close() }
})

test('restarting the app offers the same ready version again', async () => {
  const root = mkdtempSync(join(tmpdir(), 'yogurt-update-session-'))
  const first = await launch(root)
  try {
    await first.page.getByTestId('update-ready').click(); await first.page.getByTestId('update-later').click()
    await expect(first.page.getByTestId('update-ready')).toHaveCount(0)
  } finally { await first.app.close() }
  const second = await launch(root)
  try { await expect(second.page.getByTestId('update-ready')).toBeVisible() }
  finally { await second.app.close() }
})
