import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SetupState } from '../src/shared/types'

const ready: SetupState = { phase: 'ready', fraction: 1 }
const download: SetupState = { ...ready, notesDownloading: true, notesFraction: .27, notesTotalBytes: 5e9, notesEtaSec: 240 }
const upgrade: SetupState = { ...ready, notesUpgradeDownloading: true, notesUpgradeFraction: .27, notesUpgradeTotalBytes: 14e9, notesUpgradeEtaSec: 240 }

async function launch(root = mkdtempSync(join(tmpdir(), 'yogurt-ai-titlebar-')), notesMs = '0') {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: root, YOGURT_FAKE_NOTES_MODEL_MS: notesMs,
  } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  await expect.poll(() => page.evaluate(async () => {
    const state = await window.yogurt.setup.state()
    return state.phase === 'ready' && !state.notesDownloading && !state.notesUpgradePending && !state.notesUpgradeDownloading
  }), { timeout: 15_000 }).toBe(true)
  return { app, page }
}

// Exercise the renderer through its real IPC subscription; controller transitions have unit coverage.
async function setSetup(app: ElectronApplication, state: SetupState) {
  await app.evaluate(({ ipcMain, BrowserWindow }, state) => {
    ipcMain.removeHandler('setup:state')
    ipcMain.handle('setup:state', () => state)
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('setup:state', state)
  }, state)
}

async function go(page: Page, route: string) {
  await page.evaluate(route => window.yogurt.nav.go(route), route)
  await expect.poll(() => page.evaluate(() => window.yogurt.nav.current())).toBe(route)
  const screen = route.startsWith('/note/') ? 'note-menu-button' : route.startsWith('/folder/') ? 'folder-page'
    : route.startsWith('/chat') ? 'chat-page' : route === '/trash' ? 'trash-empty' : route === '/settings' ? 'settings' : 'home'
  await expect(page.getByTestId(screen)).toBeVisible()
}

async function expectClear(page: Page) {
  await expect.poll(() => page.getByTestId('notes-setup-open').evaluate(el => {
    const box = el.getBoundingClientRect()
    const others = document.querySelectorAll('.workspace-sidebar-toggle, [data-testid="recording-return"], [data-testid="note-menu-button"], #workspace-actions button')
    return box.width >= 44 && box.x >= 0 && box.right <= innerWidth && [...others].every(other => {
      const rect = other.getBoundingClientRect()
      return box.right <= rect.x || box.x >= rect.right
    }) && el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
  })).toBe(true)
}

async function expectQuietLayout(page: Page, upgrading: boolean, failed: boolean) {
  const popup = page.getByTestId('notes-setup')
  await expect(popup).toHaveCSS('width', '408px')
  await expect(popup.locator('.notes-download-progress')).toHaveCSS('height', '3px')
  expect(await popup.evaluate(el => [...el.querySelectorAll('.notes-download-readout>*, .notes-download-support, button')].every(line => {
    const range = document.createRange()
    range.selectNodeContents(line)
    return range.getClientRects().length === 1 && line.scrollWidth <= line.clientWidth
  }))).toBe(true)
  const line = (await popup.locator('.notes-download-support').boundingBox())!
  if (upgrading || failed) {
    const actions = (await popup.locator('.notes-download-actions').boundingBox())!
    if (failed) expect(actions.y).toBeGreaterThanOrEqual(line.y + line.height)
    else expect(Math.abs(actions.y + actions.height / 2 - line.y - line.height / 2)).toBeLessThan(1)
  }
  if (upgrading) await expect(popup.getByTestId('notes-setup-skip')).toHaveCSS('text-decoration-line', 'none')
  await expect(popup.locator('.notes-download-next')).toHaveCount(0)
  await expect(popup).not.toContainText('Next,')
}

test('both AI stages live beside recording, open below, retry failures and disappear when ready', async () => {
  const { app, page } = await launch()
  try {
    const trigger = page.getByTestId('notes-setup-open')
    const popup = page.getByTestId('notes-setup')
    await setSetup(app, ready)
    await expect(trigger).toHaveCount(0)
    for (const upgrading of [false, true]) {
      const state = upgrading ? upgrade : download
      const label = upgrading ? 'Upgrading AI' : 'Downloading AI'
      await setSetup(app, state)
      await expect(trigger).toHaveAccessibleName(`${label} · 27%`)
      await expect(trigger).toHaveAttribute('title', `${label} · 27%`)
      await expect(trigger.locator('.lucide-chevron-down')).toHaveCount(0)
      await expect(page.locator('.workspace-toolbar').getByTestId('notes-setup-open')).toHaveCount(1)
      await expect(trigger).toHaveCSS('font-weight', '400')
      const start = (await page.getByTestId('new-note').boundingBox())!
      const status = (await trigger.boundingBox())!
      expect(status.height).toBe(30)
      expect(status.y + status.height / 2).toBe(start.y + start.height / 2)
      expect(start.x - status.x - status.width).toBeCloseTo(16, 0)
      expect(await trigger.evaluate(el => getComputedStyle(el).getPropertyValue('-webkit-app-region'))).toBe('no-drag')
      await expect(page.locator('.workspace-breadcrumb')).toHaveCSS('-webkit-app-region', 'drag')
      for (const control of ['nav-back', 'nav-forward', 'new-note']) {
        await expect(page.getByTestId(control)).toHaveCSS('-webkit-app-region', 'no-drag')
      }
      // The middle of the flexible breadcrumb must not fall inside any no-drag rectangle.
      expect(await page.locator('.workspace-breadcrumb').evaluate(el => {
        const box = el.getBoundingClientRect()
        const x = box.x + box.width / 2, y = box.y + box.height / 2
        return [...document.querySelectorAll('.workspace *')].every(other => {
          if (getComputedStyle(other).getPropertyValue('-webkit-app-region') !== 'no-drag') return true
          const rect = other.getBoundingClientRect()
          return x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom
        })
      })).toBe(true)
      await trigger.focus()
      await page.keyboard.press('Enter')
      await expect(popup.locator('.notes-download-readout')).toHaveText(upgrading ? '3.8 of 14.0 GB27%' : '1.4 of 5.0 GBabout 4 min left')
      await expect(popup.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '27')
      await expect(popup.locator('.notes-download-next')).toHaveCount(0)
      await expect(popup).not.toContainText('Next,')
      await expect(popup).toContainText(upgrading ? "Once this model is ready, we'll remove the old one." : 'You can record meetings. AI summaries and Ask work when this finishes.')
      await expectQuietLayout(page, upgrading, false)
      await expect.poll(async () => (await popup.boundingBox())!.y - status.y - status.height).toBeGreaterThanOrEqual(8)
      await page.keyboard.press('Escape')
      await expect(popup).toHaveCount(0)
      await expect(trigger).toBeFocused()
      await trigger.click()
      await setSetup(app, upgrading ? { ...state, notesUpgradeFraction: 1 } : { ...state, notesFraction: 1 })
      await expect(trigger).toHaveAccessibleName(`${label} · 100%`)
      await expect(popup).not.toContainText('min left')
      await setSetup(app, upgrading ? { ...state, notesUpgradeDownloading: undefined, notesUpgradeError: 'Offline' } : { ...state, notesDownloading: undefined, notesError: 'Offline' })
      await expect(trigger).toHaveAccessibleName(upgrading ? 'AI upgrade paused' : 'AI download stopped')
      await expect(popup.locator('.notes-download-readout')).toHaveText(upgrading ? 'Upgrade paused3.8 of 14.0 GB' : 'Download stopped1.4 of 5.0 GB')
      await expect(popup.locator('.notes-download-support')).toHaveText('Offline')
      await expect(popup.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '27')
      await expect(popup).not.toContainText('min left')
      await expect(popup.getByTestId('notes-setup-retry')).toHaveText('Try again')
      await expect(popup.getByTestId('notes-setup-skip')).toHaveCount(upgrading ? 1 : 0)
      await expectQuietLayout(page, upgrading, true)
      await app.evaluate(({ ipcMain, BrowserWindow }, state) => {
        let rejectOnce = true
        ipcMain.removeHandler('setup:retry')
        ipcMain.handle('setup:retry', () => {
          if (rejectOnce) { rejectOnce = false; throw new Error('retry transport failed') }
          for (const win of BrowserWindow.getAllWindows()) win.webContents.send('setup:state', state)
        })
      }, state)
      await page.getByTestId('notes-setup-retry').click()
      await expect(popup).toContainText("Couldn't restart the download. Try again.")
      await page.getByTestId('notes-setup-retry').click()
      await expect(trigger).toHaveAccessibleName(`${label} · 27%`)
      await setSetup(app, ready)
      await expect(trigger).toHaveCount(0)
      await expect(popup).toHaveCount(0)
    }
  } finally { await app.close() }
})

test('AI status stays on every workspace page and clears recording and More in narrow LTR and RTL windows', async () => {
  test.setTimeout(120_000)
  const { app, page } = await launch()
  try {
    await app.evaluate(() => (globalThis as unknown as { __fake__: { manyMeetings(o: { n: number; clean: boolean }): void } }).__fake__.manyMeetings({ n: 2, clean: true }))
    await page.reload()
    await expect(page.getByTestId('home')).toBeVisible()
    const [other, trashed] = (await page.evaluate(() => window.yogurt.meetings.cards({ limit: 10 }))).map(card => card.id)
    await page.evaluate(id => window.yogurt.meetings.trash(id), trashed)
    const folder = await page.evaluate(() => window.yogurt.folders.create('A long folder title '.repeat(10)))
    const chat = await page.evaluate(() => window.yogurt.conversations.current([], true))
    await setSetup(app, upgrade)
    const trigger = page.getByTestId('notes-setup-open')
    for (const route of ['', '/chat', `/chat/${chat}`, '/trash', '/settings', `/folder/${folder!.id}`, `/note/${other}`]) {
      await go(page, route)
      await expect(trigger).toHaveCount(1)
      await expect(page.locator('.workspace-toolbar').getByTestId('notes-setup-open')).toBeVisible()
      await expect(page.locator('.note-footer-bar').getByTestId('notes-setup-open')).toHaveCount(0)
      if (route === '/trash') await expect(page.locator('.workspace-toolbar').getByTestId('trash-empty')).toBeVisible()
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes('#'))!.setSize(720, 600))
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(720)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    for (const locale of ['en', 'de', 'ar']) {
      await page.evaluate(locale => window.yogurt.settings.setLanguage(locale), locale)
      await expect(page.locator('html')).toHaveAttribute('lang', locale)
      for (const collapsed of [false, true]) {
        const toggle = page.locator('.workspace-sidebar-toggle')
        if (await toggle.getAttribute('aria-expanded') !== String(!collapsed)) await toggle.click()
        for (const route of ['', `/folder/${folder!.id}`]) {
          await go(page, route)
          await expect(page.locator('#workspace-actions button')).toBeVisible()
          await expectClear(page)
        }
      }
    }
    await go(page, '')
    await page.getByTestId('new-note').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    const recording = await page.evaluate(() => window.yogurt.nav.current())
    await expect(trigger).toBeVisible()
    await expect(page.locator('.note-footer-bar').getByTestId('notes-setup-open')).toHaveCount(0)
    for (const locale of ['en', 'de', 'ar']) {
      await page.evaluate(locale => window.yogurt.settings.setLanguage(locale), locale)
      await expect(page.locator('html')).toHaveAttribute('lang', locale)
      for (const collapsed of [false, true]) {
        const toggle = page.locator('.workspace-sidebar-toggle')
        if (await toggle.getAttribute('aria-expanded') !== String(!collapsed)) await toggle.click()
        for (const route of ['', '/trash', `/note/${other}`, recording]) {
          await go(page, route)
          await expect(trigger).toBeVisible()
          if (route !== recording) await expect(page.getByTestId('recording-return')).toBeVisible()
          await expectClear(page)
          await trigger.click()
          const popup = page.getByTestId('notes-setup')
          await expect(popup).toBeVisible()
          const box = (await trigger.boundingBox())!, panel = (await popup.boundingBox())!
          expect(panel.x).toBeGreaterThanOrEqual(12)
          expect(panel.x + panel.width).toBeLessThanOrEqual((await page.evaluate(() => innerWidth)) - 12)
          expect(panel.y).toBeGreaterThanOrEqual(box.y + box.height + 8)
          expect(locale === 'ar' ? panel.x - box.x : panel.x + panel.width - box.x - box.width).toBeCloseTo(0, 0)
          await page.keyboard.press('Escape')
        }
      }
    }
    // Reserve a Windows/Linux control strip as well; RTL must keep More on the status's end.
    await page.evaluate(() => {
      document.documentElement.dataset.chrome = 'overlay'
      document.documentElement.style.setProperty('--controls-end', '138px')
    })
    for (const collapsed of [false, true]) {
      const toggle = page.locator('.workspace-sidebar-toggle')
      if (await toggle.getAttribute('aria-expanded') !== String(!collapsed)) await toggle.click()
      for (const route of ['', '/trash', `/note/${other}`]) {
        await go(page, route)
        await expectClear(page)
        if (route.startsWith('/note/')) {
          const menu = (await page.getByTestId('note-menu-button').boundingBox())!
          expect(menu.x + menu.width).toBeLessThanOrEqual((await trigger.boundingBox())!.x)
        }
      }
    }
  } finally { await app.close() }
})

test('the popover never previews a Next download and stays open through the upgrade gap', async () => {
  const { app, page } = await launch()
  try {
    const trigger = page.getByTestId('notes-setup-open')
    const popup = page.getByTestId('notes-setup')
    await setSetup(app, download)
    await trigger.click()
    await expect(popup).not.toContainText('Next,')
    await setSetup(app, { ...download, notesUpgradeBytes: 14.4e9 })
    await expect(popup).not.toContainText('Next,')
    await expect(popup.locator('.notes-download-next')).toHaveCount(0)
    await setSetup(app, { ...ready, notesUpgradeBytes: 14.4e9, notesUpgradePending: true })
    await expect(trigger).toHaveAccessibleName('Upgrading AI')
    await expect(popup).toBeVisible()
    await expect(popup).not.toContainText('Next,')
    await expect(page.getByTestId('notes-setup-skip')).toBeVisible()
    await setSetup(app, upgrade)
    await expect(trigger).toHaveAccessibleName('Upgrading AI · 27%')
    await expect(popup).toBeVisible()
  } finally { await app.close() }
})

test('skipping from the popover confirms only success, opens Settings, and dismisses manually or after eight seconds', async () => {
  const { app, page } = await launch()
  try {
    await app.evaluate(({ ipcMain, BrowserWindow }, state) => {
      let rejectOnce = true
      ipcMain.removeHandler('setup:skip-upgrade')
      ipcMain.handle('setup:skip-upgrade', () => {
        if (rejectOnce) { rejectOnce = false; throw new Error('skip transport failed') }
        for (const win of BrowserWindow.getAllWindows()) win.webContents.send('setup:state', state)
      })
    }, { ...ready, notesUpgradeSkipped: true })
    const toast = page.getByTestId('notes-skipped-toast')
    await setSetup(app, upgrade)
    await page.getByTestId('notes-setup-open').click()
    await page.getByTestId('notes-setup-skip').click()
    await expect(page.getByRole('alert')).toHaveText("Couldn't change the notes model. Try again.")
    await expect(toast).toHaveCount(0)
    for (const dismiss of ['settings', 'close', 'timeout']) {
      if (dismiss !== 'settings') {
        await go(page, '')
        await setSetup(app, upgrade)
        await page.getByTestId('notes-setup-open').click()
      }
      await page.getByTestId('notes-setup-skip').click()
      await expect(page.getByTestId('notes-setup-open')).toHaveCount(0)
      await expect(page.getByTestId('notes-setup')).toHaveCount(0)
      await expect(toast).toContainText('AI upgrade skipped')
      await expect(toast.getByRole('button', { name: 'Get it in Settings' })).toBeVisible()
      expect(await toast.evaluate(el => {
        const title = el.querySelector('.app-toast-title')!, action = el.querySelector('.app-toast-action')!
        return [title, action].every(line => {
          const range = document.createRange()
          range.selectNodeContents(line)
          return range.getClientRects().length === 1 && line.scrollWidth <= line.clientWidth
        }) && Math.abs(title.getBoundingClientRect().y + title.getBoundingClientRect().height / 2
          - action.getBoundingClientRect().y - action.getBoundingClientRect().height / 2) < 1
      })).toBe(true)
      if (dismiss === 'settings') {
        await toast.getByRole('button', { name: 'Get it in Settings' }).click()
        await expect(page.getByTestId('settings')).toBeVisible()
        await expect.poll(() => page.evaluate(() => window.yogurt.nav.current())).toBe('/settings')
      } else if (dismiss === 'close') {
        await toast.locator('.app-toast-close').click()
      } else {
        await page.mouse.move(0, 0)
      }
      await expect(toast).toHaveCount(0, { timeout: 10_000 })
    }
  } finally { await app.close() }
})

test('Settings shows restore progress without a title-bar download and keeps the removal error', async () => {
  const { app, page } = await launch()
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes('#'))!.setSize(1100, 800))
    const installed = { ...ready, notesUpgradeBytes: 14e9, notesUpgradeInstalled: true }
    await setSetup(app, installed)
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('setup:remove-upgrade')
      ipcMain.handle('setup:remove-upgrade', () => new Promise<void>((resolve, reject) => {
        ipcMain.once('test:restore-finish', (_event, fail: boolean) => {
          if (fail) reject(new Error('restore download failed'))
          else resolve()
        })
      }))
    })
    await go(page, '/settings')
    const row = page.getByTestId('settings-notes-model')
    const action = page.getByTestId('settings-notes-model-action')
    for (const fail of [true, false]) {
      await action.click()
      for (const [fraction, eta, detail] of [
        [0, undefined, '0.0 of 5.2 GB'],
        [.02, 240, '0.1 of 5.2 GB · about 4 min left'],
        [.429, undefined, '2.2 of 5.2 GB'],
        [1, 240, '5.2 of 5.2 GB'],
      ] as const) {
        await setSetup(app, { ...installed, notesUpgradeChanging: true, notesRestoreFraction: fraction, notesRestoreTotalBytes: 5.2e9, notesRestoreEtaSec: eta })
        const descriptions = row.locator('.settings-description')
        await expect(descriptions).toHaveText([
          `Getting the smaller model · ${detail}`,
          'The larger model keeps running summaries and Ask until then, and is removed after.',
        ])
        for (const line of await descriptions.all()) {
          await expect(line).toHaveCSS('text-wrap', 'pretty')
          expect(await line.evaluate(el => {
            const range = document.createRange()
            range.selectNodeContents(el)
            return range.getClientRects().length === 1 && el.scrollWidth <= el.clientWidth
          })).toBe(true)
        }
        await expect(action).toBeDisabled()
        await expect(action).toHaveText('Removing…')
        await expect(page.getByTestId('notes-setup-open')).toHaveCount(0)
      }
      await setSetup(app, fail ? installed : { ...ready, notesUpgradeBytes: 14e9, notesUpgradeSkipped: true })
      await app.evaluate(({ ipcMain }, fail) => { ipcMain.emit('test:restore-finish', null, fail) }, fail)
      await expect(action).toBeEnabled()
      await expect(row).not.toContainText('Getting the smaller model')
      await expect(row).not.toContainText('The larger model keeps running summaries and Ask')
      if (fail) {
        await expect(row.getByRole('alert')).toHaveText("Couldn't change the notes model. Try again.")
        await expect(action).toHaveText('Remove')
      } else {
        await expect(row.getByRole('alert')).toHaveCount(0)
        await expect(action).toHaveText('Download (14 GB)')
      }
    }
  } finally { await app.close() }
})

test('Settings download, Skip, restart and Remove use the real setup controller', async () => {
  test.setTimeout(60_000)
  const root = mkdtempSync(join(tmpdir(), 'yogurt-upgrade-controls-'))
  let { app, page } = await launch(root, '1600')
  try {
    await go(page, '/settings')
    const action = page.getByTestId('settings-notes-model-action')
    await expect(action).toHaveText('Remove')
    await expect(page.getByTestId('settings-notes-model')).toContainText('Notes use this model. Removing it brings back the smaller one.')
    await action.click()
    await expect(action).toHaveText(/^Download \([\d.]+ GB\)$/)
    await expect(page.getByTestId('settings-notes-model')).toContainText("More detailed, accurate notes. Replaces the current model, so you don't keep both.")
    await action.click()
    await expect(action).toHaveText('Skip for now')
    await action.click()
    await expect(action).toHaveText(/^Download \([\d.]+ GB\)$/)
    await expect(page.getByTestId('notes-skipped-toast')).toHaveCount(0)
    await action.click()
    await go(page, '')
    await page.getByTestId('notes-setup-open').click()
    await page.getByTestId('notes-setup-skip').click()
    await expect(page.getByTestId('notes-setup-open')).toHaveCount(0)
    await page.getByTestId('notes-skipped-toast').getByRole('button', { name: 'Get it in Settings' }).click()
    await expect(page.getByTestId('settings')).toBeVisible()
    await expect(action).toHaveText(/^Download \([\d.]+ GB\)$/)
    await app.close()
    ;({ app, page } = await launch(root, '1600'))
    await expect(page.getByTestId('notes-setup-open')).toHaveCount(0)
    await go(page, '/settings')
    const restarted = page.getByTestId('settings-notes-model-action')
    await expect(restarted).toHaveText(/^Download \([\d.]+ GB\)$/)
    await restarted.click()
    await expect(page.getByTestId('notes-setup-open')).toBeVisible()
    await expect(restarted).toHaveText('Remove', { timeout: 10_000 })
    await restarted.click()
    await expect(restarted).toHaveText(/^Download \([\d.]+ GB\)$/)
    expect(await page.evaluate(async () => (await window.yogurt.setup.state()).notesUpgradeSkipped)).toBe(true)
  } finally { await app.close() }
})
