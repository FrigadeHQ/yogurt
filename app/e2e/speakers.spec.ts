import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Who said what, after the meeting: voices told apart with a progress bar before the summary (voices/, here the
 * fake stand-in YOGURT_FAKE_VOICES), names fixed from a turn's name, the summary written again from a button in
 * sight, and the summary's prompt shown in Settings.
 */
const main = join(import.meta.dirname, '../out/main/index.js')
const zoom = { bundleId: 'us.zoom.xos', name: 'zoom.us' }

async function launch(env: Record<string, string> = {}) {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData, ...env } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page }
}
const fake = <T>(app: ElectronApplication, fn: string, arg?: unknown): Promise<T> =>
  app.evaluate((_e, [fn, arg]) => (globalThis as unknown as Record<string, Record<string, (a?: unknown) => unknown>>).__fake__[fn as string](arg), [fn, arg] as const) as Promise<T>
const windowOf = async (app: ElectronApplication, hash: string): Promise<Page> => {
  for (let i = 0; i < 100; i++) {
    const w = app.windows().find((p) => p.url().includes(hash))
    if (w) return w
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`no ${hash} window`)
}
const whoOf = (page: Page, text: string) => page.getByTestId('transcript-turn').filter({ has: page.getByTestId('transcript-line').filter({ hasText: text }) }).getByTestId('transcript-who')

/** a meeting whose other side the call app never named (no Accessibility), stopped, its transcript open */
async function finished(app: ElectronApplication, page: Page) {
  await fake(app, 'signals', { micApps: [zoom], events: [] })
  await (await windowOf(app, '#prompt')).getByTestId('prompt-take-notes').click()
  await page.getByRole('tab', { name: 'Transcript', exact: true }).click()
  await expect(page.getByTestId('transcript-line').filter({ hasText: 'She will send a draft' })).toBeVisible({ timeout: 40_000 })
  // nothing is told apart while it records
  await expect(page.getByTestId('voices-progress')).toHaveCount(0)
  await page.getByTestId('note-stop').click()
}

test('once the meeting is over its voices are told apart, with a progress bar, and the turns get Speaker 1 and 2', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_AX: 'denied', YOGURT_FAKE_VOICES: '1' })
  try {
    await finished(app, page)
    const bar = page.getByTestId('voices-progress')
    await expect(bar).toBeVisible({ timeout: 20_000 })
    await expect(bar).toContainText('Telling voices apart')
    await expect(bar.getByRole('progressbar')).toHaveAttribute('aria-valuenow', /^(?:[1-9]\d?|100)$/)
    await expect(bar).toHaveCount(0, { timeout: 10_000 })
    await page.getByTestId('note-transcript-toggle').click()
    await expect(whoOf(page, 'The site goes live on Tuesday')).toHaveText('Speaker 1')
    await expect(whoOf(page, 'She will send a draft')).toHaveText('Speaker 2')
  } finally { await app.close() }
})

test('without the voices, a meeting whose call app named no one stays Them, and no bar shows', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_AX: 'denied' })
  try {
    await finished(app, page)
    await page.getByTestId('note-transcript-toggle').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', /^(stopped|done)$/)
    await expect(whoOf(page, 'The site goes live on Tuesday')).toHaveText('Them')
    await expect(page.getByTestId('voices-progress')).toHaveCount(0)
  } finally { await app.close() }
})

test('a turn\'s name fixes who spoke: a new name for just that turn joins the attendees, then a whole speaker becomes them', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_AX: 'denied', YOGURT_FAKE_VOICES: '1' })
  try {
    await finished(app, page)
    await expect(page.getByTestId('voices-progress')).toHaveCount(0, { timeout: 20_000 })
    await page.getByTestId('note-transcript-toggle').click()
    await expect(whoOf(page, 'She will send a draft')).toHaveText('Speaker 2')

    // Speaker 2 was really Dana Lund: just this turn, a name typed new
    await whoOf(page, 'She will send a draft').click()
    const menu = page.getByTestId('speaker-menu')
    await expect(menu).toBeVisible()
    await expect(menu.getByTestId('speaker-option').filter({ hasText: 'Speaker 1' })).toBeVisible()
    await menu.getByTestId('speaker-new').fill('Dana Lund')
    await menu.getByTestId('speaker-new').press('Enter')
    await expect(menu.getByTestId('speaker-back')).toContainText('Dana Lund')
    await expect(menu.getByTestId('speaker-all-lines')).toHaveText("All of Speaker 2's lines")
    await menu.getByTestId('speaker-this-turn').click()
    await expect(menu).toHaveCount(0)
    await expect(whoOf(page, 'She will send a draft')).toHaveText('Dana Lund')
    await expect(whoOf(page, 'The site goes live on Tuesday')).toHaveText('Speaker 1')
    // a real name typed new is someone at the meeting
    await expect(page.getByTestId('note-attendees-summary')).toContainText('Dana')

    // and Speaker 1 is her too: picked from the attendees, for all of Speaker 1's lines
    await whoOf(page, 'The site goes live on Tuesday').click()
    await expect(menu).toBeVisible()
    await menu.getByTestId('speaker-option').filter({ hasText: 'Dana Lund' }).click()
    await menu.getByTestId('speaker-all-lines').click()
    await expect(whoOf(page, 'The site goes live on Tuesday')).toHaveText('Dana Lund')
    await expect(page.getByTestId('transcript')).not.toContainText(/Speaker \d/)

    // the current speaker can't be picked again
    await whoOf(page, 'She will send a draft').click()
    await expect(menu.getByTestId('speaker-option').filter({ hasText: 'Dana Lund' })).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
  } finally { await app.close() }
})

test('the mic\'s own turns are always You, with no menu to change them', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_AX: 'denied' })
  try {
    await finished(app, page)
    await page.getByTestId('note-transcript-toggle').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', /^(stopped|done)$/)
    const mine = page.getByTestId('transcript-turn').filter({ has: page.getByTestId('transcript-line').filter({ hasText: 'Can we go over the launch plan' }) }).getByTestId('transcript-who')
    await expect(mine).toHaveText('You')
    expect(await mine.evaluate((el) => el.tagName)).toBe('SPAN')
  } finally { await app.close() }
})

test('Regenerate summary is in sight once there is a summary, and opens the same form as the menu', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_AX: 'denied' })
  try {
    await finished(app, page)
    await expect(page.getByTestId('note-enhanced')).not.toBeEmpty({ timeout: 30_000 })
    const button = page.getByTestId('note-regenerate-button')
    await expect(button).toBeEnabled({ timeout: 30_000 })
    await expect(button).toHaveAccessibleName('Regenerate summary')
    await button.click()
    await expect(page.getByTestId('note-regenerate-input')).toBeFocused()
    await expect(page.getByTestId('note-write-again-confirm')).toHaveText('Regenerate')
  } finally { await app.close() }
})

test('Settings shows the prompt summaries are written with, the meeting\'s own parts as placeholders', async () => {
  const { app, page } = await launch()
  try {
    await fake(app, 'go', '/settings')
    const section = page.getByTestId('settings-summary-prompt')
    await expect(section).toBeVisible()
    const summary = page.getByTestId('settings-prompt-summary')
    await summary.locator('summary').click()
    await expect(summary.locator('pre')).toContainText('How to write them, so they read at a glance')
    await expect(summary.locator('pre')).toContainText('<meeting title>')
    await expect(summary.locator('pre')).toContainText('"Speaker 1", "Speaker 2"')
    await expect(page.getByTestId('settings-prompt-summary-copy')).toBeEnabled()
    const part = page.getByTestId('settings-prompt-part')
    await part.locator('summary').click()
    await expect(part.locator('pre')).toContainText('Write compact notes on this part only')
  } finally { await app.close() }
})
