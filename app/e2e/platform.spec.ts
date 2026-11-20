import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backgroundPixel } from './backgroundPixel'

// @everywhere: these also run on the Windows and Linux CI. YOGURT_FAKE_PLATFORM lets the Mac try those screens too.
const main = join(import.meta.dirname, '../out/main/index.js')
const launch = (env: Record<string, string> = {}) =>
  electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-e2e-')), ...env } })

test('@everywhere the search palette follows appearance and transparency preferences', async () => {
  const app = await launch()
  try {
    const page = await app.firstWindow()
    await page.getByTestId('search-open').click()
    const palette = page.getByTestId('search')
    const cdp = await page.context().newCDPSession(page)
    const defaults = { 'prefers-reduced-transparency': 'no-preference', 'prefers-contrast': 'no-preference', 'forced-colors': 'none' }
    const media = (changes: Record<string, string>) => cdp.send('Emulation.setEmulatedMedia', {
      features: Object.entries({ ...defaults, ...changes }).map(([name, value]) => ({ name, value })),
    })
    for (const [theme, tint] of [['light', .915], ['dark', .95]] as const) {
      await media({ 'prefers-color-scheme': theme })
      await expect(palette).toHaveCSS('backdrop-filter', /^blur\(22px\) saturate\((?:1\.065|106\.5%)\)$/)
      const [red, , , alpha] = await palette.evaluate(backgroundPixel)
      expect(Math.abs(red - (theme === 'light' ? 255 : 41))).toBeLessThanOrEqual(1)
      expect(Math.abs(alpha - 255 * tint)).toBeLessThanOrEqual(1)
    }
    for (const [name, value] of [['prefers-reduced-transparency', 'reduce'], ['prefers-contrast', 'more'], ['forced-colors', 'active']]) {
      await media({ [name]: value })
      await expect(palette).toHaveCSS('backdrop-filter', 'none')
      expect((await palette.evaluate(backgroundPixel))[3]).toBe(255)
    }
  } finally { await app.close() }
})

for (const platform of ['win32', 'linux']) {
  // Linux reads names from calls through AT-SPI and Windows through UI Automation: nothing to ask for, so it reads as on
  const names = true
  test(`@everywhere on ${platform}: the agenda, and Settings' calendars by calendar link (no calendar permission), and names from calls`, async () => {
    const app = await launch({ YOGURT_FAKE_PLATFORM: platform })
    try {
      const page = await app.firstWindow()
      await expect(page.getByTestId('home')).toBeVisible({ timeout: 15_000 })
      expect(await page.evaluate(() => window.yogurt.capabilities)).toEqual({ calendar: true, calendarLink: true, callNames: names, permissionPrompts: false, mediaPause: false })
      await expect(page.getByRole('complementary', { name: 'Agenda' })).toBeVisible()
      await page.getByTestId('settings-open').click()
      await expect(page.getByTestId('settings')).toBeVisible()
      await expect(page.getByTestId('permission-row')).toHaveCount(names ? 4 : 3)
      await expect(page.locator('[data-testid="permission-row"][data-kind="calendar"]')).toHaveCount(0)
      await expect(page.locator('[data-testid="permission-row"][data-kind="accessibility"]')).toHaveCount(names ? 1 : 0)
      // Manage only where there is a page to open (#70): never on names from calls here, and on Linux nowhere
      await expect(page.locator('[data-testid="permission-row"][data-kind="accessibility"] [data-testid="permission-open"]')).toHaveCount(0)
      await expect(page.locator('[data-testid="permission-row"] [data-testid="permission-open"]')).toHaveCount(platform === 'win32' ? 3 : 0)
      await expect(page.getByTestId('calendar-settings')).toBeVisible()
      await expect(page.getByTestId('calendar-link-form')).toBeVisible()
    } finally { await app.close() }
  })

  test(`@everywhere on ${platform}: the first run asks only for a calendar link (no prompts there; mic, call audio and notifications are on)`, async () => {
    const app = await launch({ YOGURT_FAKE_PLATFORM: platform, YOGURT_FAKE_PERMISSIONS: 'unknown', YOGURT_FAKE_CALENDAR: 'notDetermined' })
    try {
      const page = await app.firstWindow()
      await page.getByTestId('intro-next').click()
      const calendar = page.locator('[data-testid="onboarding-step"][data-step="calendar"]')
      await expect(calendar).toBeVisible({ timeout: 15_000 })
      await calendar.getByTestId('step-later').click()
      await expect(page.getByTestId('home')).toBeVisible({ timeout: 15_000 })
      await expect(page.getByTestId('onboarding-step')).toHaveCount(0)
    } finally { await app.close() }
  })
}

test('@everywhere a Mac keeps the agenda and every permission', async () => {
  const app = await launch({ YOGURT_FAKE_PLATFORM: 'darwin' })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible({ timeout: 15_000 })
    expect(await page.evaluate(() => window.yogurt.capabilities)).toEqual({ calendar: true, calendarLink: false, callNames: true, permissionPrompts: true, mediaPause: true })
    await expect(page.getByRole('complementary', { name: 'Agenda' })).toBeVisible()
    await page.getByTestId('settings-open').click()
    await expect(page.getByTestId('permission-row')).toHaveCount(5)
    await expect(page.getByTestId('calendar-settings')).toBeVisible()
  } finally { await app.close() }
})
