import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// a version "downloaded" at launch; the corner waits AFTER_MS (a day in a real install) before offering Restart
const AFTER_MS = 1500
async function launch() {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-update-badge-')),
    YOGURT_FAKE_UPDATE: '9.9.9', YOGURT_FAKE_UPDATE_AFTER_MS: String(AFTER_MS),
  } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page }
}
const restarts = (app: Awaited<ReturnType<typeof launch>>['app']) =>
  app.evaluate(() => (globalThis as any).__fake__.main().updateRestarts as number)

test('the badge appears as soon as a version is ready', async () => {
  const { app, page } = await launch()
  try {
    // no wait: the icon keys off the downloaded version, not the corner's day-long offer
    await expect(page.getByTestId('update-badge')).toBeVisible()
    await expect(page.getByTestId('update-toast')).toHaveCount(0)
  } finally { await app.close() }
})

test('one click restarts Yogurt, and the badge goes away', async () => {
  const { app, page } = await launch()
  try {
    const badge = page.getByTestId('update-badge')
    await expect(badge).toBeVisible()
    await badge.click()
    await expect.poll(() => restarts(app)).toBe(1)
    await expect(badge).toHaveCount(0)
  } finally { await app.close() }
})

test('never restarts while recording: the badge dims, a click explains', async () => {
  const { app, page } = await launch()
  try {
    const badge = page.getByTestId('update-badge')
    await expect(badge).toBeVisible()
    await page.evaluate(() => window.yogurt.meetings.start(null))
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    await expect(badge).toHaveAttribute('data-recording', 'true')
    await badge.click()
    await expect(page.getByTestId('update-badge-blocked')).toContainText('Update is ready to apply as soon the recording is finished.')
    expect(await restarts(app)).toBe(0)
  } finally { await app.close() }
})

test('after the recording stops the badge restarts again', async () => {
  const { app, page } = await launch()
  try {
    const badge = page.getByTestId('update-badge')
    await page.evaluate(() => window.yogurt.meetings.start(null))
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    await expect(badge).toHaveAttribute('data-recording', 'true')
    await page.getByTestId('note-stop').click()
    await expect(badge).not.toHaveAttribute('data-recording')
    await badge.click()
    await expect.poll(() => restarts(app)).toBe(1)
  } finally { await app.close() }
})

test('the badge stays after the corner offer is put off', async () => {
  const { app, page } = await launch()
  try {
    const toast = page.getByTestId('update-toast')
    await expect(toast).toBeVisible({ timeout: 10_000 })
    await toast.locator('.app-toast-close').click()
    await expect(toast).toHaveCount(0)
    const badge = page.getByTestId('update-badge')
    await expect(badge).toBeVisible()
    await badge.click()
    await expect.poll(() => restarts(app)).toBe(1)
  } finally { await app.close() }
})
