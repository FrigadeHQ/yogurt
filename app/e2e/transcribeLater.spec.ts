import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')
const zoom = { bundleId: 'us.zoom.xos', name: 'zoom.us' }
const fake = (app: ElectronApplication, fn: string, arg?: unknown) =>
  app.evaluate((_e, [fn, arg]) => (globalThis as unknown as Record<string, Record<string, (a?: unknown) => unknown>>).__fake__[fn as string](arg), [fn, arg] as const)
const windowOf = async (app: ElectronApplication, hash: string): Promise<Page> => {
  for (let i = 0; i < 100; i++) {
    const w = app.windows().find((p) => p.url().includes(hash))
    if (w) return w
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`no ${hash} window`)
}

// #30: a meeting recorded before the speech model was in is transcribed from its saved recording once the model is
test('a meeting with audio and no transcript is transcribed from its recording', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    await fake(app, 'signals', { micApps: [zoom], events: [] })
    await (await windowOf(app, '#prompt')).getByTestId('prompt-take-notes').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    // the fixture says its four lines in about 15 s
    await page.waitForTimeout(16_000)
    await page.getByTestId('note-stop').click()
    await expect(page.getByTestId('note-state')).not.toHaveAttribute('data-state', 'recording')
    await fake(app, 'untranscribe')
    await page.getByTestId('note-transcript-toggle').click()
    await page.reload()
    await expect(page.getByTestId('transcript-bubble')).toHaveCount(0)
    await fake(app, 'transcribeWaiting')
    await page.reload()
    await page.getByTestId('note-transcript-toggle').click().catch(() => {})
    await expect(page.getByTestId('transcript-text').first()).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('transcript-text').filter({ hasText: 'launch plan' })).toHaveCount(1)
  } finally { await app.close() }
})

test('opted-in processing uses the synthetic recording only after the scheduled time, across restart', async () => {
  test.setTimeout(100_000)
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-e2e-schedule-'))
  const launch = () => electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData } })
  let app: ElectronApplication | undefined
  try {
    app = await launch()
    let page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    expect(await page.evaluate(async () => (await window.yogurt.settings.get()).deferRecordingProcessing)).toBe(false)
    await page.evaluate(() => window.yogurt.settings.setDeferRecordingProcessing(true))
    await fake(app, 'signals', { micApps: [zoom], events: [] })
    await (await windowOf(app, '#prompt')).getByTestId('prompt-take-notes').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    await page.getByTestId('note-transcript-toggle').click()
    // Let the same synthetic fixture speak its four lines.
    await page.waitForTimeout(16_000)
    await expect(page.getByTestId('transcript-bubble')).toHaveCount(0)
    await page.getByTestId('note-stop').click()
    const dialog = page.getByTestId('processing-schedule')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Schedule', exact: true }).click()
    await expect(dialog).toBeHidden()
    const [job] = await page.evaluate(() => window.yogurt.processing.pending())
    expect(job.at).toBeGreaterThan(Date.now())
    expect(await page.evaluate(id => window.yogurt.transcript.get(id), job.id)).toHaveLength(0)
    expect(await page.evaluate(id => window.yogurt.notes.get(id), job.id)).toMatchObject({ status: 'idle' })
    await app.close()
    app = undefined

    app = await launch()
    page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    expect(await page.evaluate(() => window.yogurt.processing.pending())).toEqual([job])
    expect(await page.evaluate(id => window.yogurt.transcript.get(id), job.id)).toHaveLength(0)
    // Jump the main process clock to the saved deadline and let its real timer release the job.
    await app.evaluate((_electron, at) => { Date.now = () => at }, job.at!)
    await expect.poll(() => page.evaluate(async id => (await window.yogurt.transcript.get(id)).some(line => /launch plan/i.test(line.text)), job.id), { timeout: 20_000 }).toBe(true)
    await expect.poll(() => page.evaluate(async id => !!(await window.yogurt.notes.get(id)).enhanced?.trim(), job.id), { timeout: 15_000 }).toBe(true)
    await expect.poll(() => page.evaluate(() => window.yogurt.processing.pending())).toEqual([])
  } finally {
    await app?.close()
    rmSync(userData, { recursive: true, force: true })
  }
})
