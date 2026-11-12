import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('the larger notes model shows in the footer while notes keep working', async () => {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-larger-model-')),
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      const state = {
        phase: 'ready', fraction: 1, notesKind: 'larger', notesDownloading: true, notesFraction: 0.4, notesTotalBytes: 14e9, notesEtaSec: 180,
      }
      ipcMain.removeHandler('setup:state')
      ipcMain.handle('setup:state', () => state)
      for (const win of BrowserWindow.getAllWindows()) {
        const send = win.webContents.send.bind(win.webContents)
        win.webContents.send = ((channel: string, ...args: unknown[]) => {
          if (channel === 'setup:state') return send(channel, state)
          return send(channel, ...args)
        }) as typeof win.webContents.send
        send('setup:state', state)
      }
    })
    await page.getByTestId('new-note').or(page.getByTestId('past-empty').getByRole('button')).first().click()
    await expect(page.getByTestId('notes-setup-open')).toContainText('Better notes model')
    await page.getByTestId('notes-setup-open').click()
    const popup = page.getByTestId('notes-setup')
    await expect(popup).toHaveAttribute('data-kind', 'larger')
    await expect(popup).toContainText('Your notes already work')
    await expect(page.getByTestId('notes-model-error')).toHaveCount(0)
  } finally { await app.close() }
})
