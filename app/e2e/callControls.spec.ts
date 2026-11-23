import { openFromCorner } from './cornerNavigation'
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')
async function launch() {
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-call-controls-')) } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page }
}

test('paused recording controls fit the minimum window and keep focus inside each button', async ({}, testInfo) => {
  const { app, page } = await launch()
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(720, 520))
    await page.locator('#workspace-actions').getByRole('button', { name: 'Start recording', exact: true }).click()
    const stop = page.getByTestId('note-stop'), pause = page.getByTestId('note-pause')
    const tooltip = page.getByRole('tooltip')
    await expect(pause).toHaveAccessibleName('Pause recording')
    await pause.locator('svg[data-icon=Pause]').hover()
    await expect(tooltip).toHaveText('Pause recording')
    // Hold the exit so both popups are mounted during the handoff on every run.
    const holdExit = await page.addStyleTag({ content: `
      @keyframes hold-tooltip-exit { to { opacity: 0 } }
      [role="tooltip"][data-closed] { animation: hold-tooltip-exit 1s paused; }
    ` })
    await stop.hover()
    await expect(tooltip).toHaveText('Stop recording')
    await expect(page.locator('[role="tooltip"][data-closed]')).toHaveText('Pause recording')
    await holdExit.evaluate(style => { style.parentNode?.removeChild(style) })
    await page.getByTestId('note-pause').click()
    await expect(page.getByTestId('rec-mic')).toHaveText('Recording paused')
    await page.getByTestId('note-title').hover()
    await expect(tooltip).toHaveCount(0)
    await page.keyboard.press('Tab')
    await page.getByTestId('note-pause').focus()
    await expect(tooltip).toHaveText('Resume recording')
    await page.screenshot({ path: testInfo.outputPath('paused-minimum.png') })
    await expect(page.getByTestId('rec-mic-chip').locator('[data-icon=Pause]')).toHaveAttribute('fill', 'currentColor')
    await expect(page.getByTestId('note-pause')).toHaveCSS('outline-offset', '-2px')
    const group = page.locator('.note-recording-group')
    const buttons = page.locator('.note-recording-group button')
    const box = await group.boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(720)
    expect(box!.height).toBe(30)
    await expect(buttons).toHaveCount(3)
    const mic = group.getByRole('button', { name: 'Mute my mic', exact: true })
    await expect(mic).toBeDisabled()
    await expect(page.getByTestId('note-pause')).toHaveText('')
    await expect(page.getByTestId('note-pause')).toHaveAccessibleName('Resume recording')
    await page.keyboard.press('Tab')
    await expect(page.getByTestId('note-stop')).toBeFocused()
    await expect(page.getByTestId('note-stop')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(page.getByTestId('note-stop')).toHaveCSS('outline-offset', '-2px')
    expect(await page.getByTestId('note-stop').evaluate(el => getComputedStyle(el, '::before').width)).toBe('8px')
    for (const button of await buttons.all()) {
      expect(await button.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    }
    await expect(stop).toHaveAccessibleName('Stop recording')
    await expect(tooltip).toHaveText('Stop recording')
    const selected = await group.getAttribute('data-treatment')
    expect(['neutral-icons', 'accent-icons', 'word']).toContain(selected)
    for (const treatment of ['neutral-icons', 'accent-icons', 'word']) {
      await group.evaluate((el, value) => { el.dataset.treatment = value }, treatment)
      const withWord = treatment === 'word'
      await expect(stop).toHaveText(withWord ? 'Stop' : '', { useInnerText: true })
      const pauseBox = (await pause.boundingBox())!, stopBox = (await stop.boundingBox())!
      expect(stopBox.height).toBe(pauseBox.height)
      if (withWord) expect(stopBox.width).toBeGreaterThan(pauseBox.width)
      else expect(stopBox.width).toBe(pauseBox.width)
      const neutral = await stop.evaluate(el => getComputedStyle(el, '::before').backgroundColor === getComputedStyle(el).color)
      expect(neutral).toBe(treatment === 'neutral-icons')
    }
    await group.evaluate((el, value) => { el.dataset.treatment = value! }, selected)
    await page.getByTestId('note-pause').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-paused', 'false')
    await expect(mic).toBeEnabled()
    await expect(page.getByTestId('note-wave')).toBeVisible()
    await expect(group).not.toContainText('Recording')
    await page.getByTestId('note-stop').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'done', { timeout: 20000 })
  } finally { await app.close() }
})

test('Custom words has the same visible unfocused field boundary in light and dark mode', async ({}, testInfo) => {
  const { app, page } = await launch()
  try {
    await openFromCorner(page, 'settings-open')
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate(theme => window.yogurt.settings.setTheme(theme), theme)
      const input = page.getByTestId('jargon-input')
      await input.evaluate(el => el.blur())
      await input.scrollIntoViewIfNeeded()
      const row = page.locator('.settings-row').filter({ has: input })
      await row.screenshot({ path: testInfo.outputPath(`jargon-${theme}.png`) })
      const field = page.getByTestId('jargon-field')
      await expect(field).toHaveCSS('border-top-width', '1px')
      await expect(field).toHaveCSS('border-top-style', 'solid')
      const nameStyle = await page.getByTestId('settings-name').evaluate(el => ({ border: getComputedStyle(el).borderTopColor, bg: getComputedStyle(el).backgroundColor }))
      await expect(field).toHaveCSS('border-top-color', nameStyle.border)
      await expect(field).toHaveCSS('background-color', nameStyle.bg)
      await input.fill(`Example ${theme}`)
      await input.press('Enter')
      await expect(page.getByTestId('jargon-chip').filter({ hasText: `Example ${theme}` })).toBeVisible()
    }
  } finally { await app.close() }
})
