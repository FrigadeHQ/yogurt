import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')
async function launch() {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-retention-'))
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_FAKE_LLM_MS: '1', YOGURT_USER_DATA: userData } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page, userData }
}
const fake = <T>(app: ElectronApplication, fn: string, arg?: unknown): Promise<T> =>
  app.evaluate((_e, [fn, arg]) => (globalThis as unknown as Record<string, Record<string, (a?: unknown) => unknown>>).__fake__[fn as string](arg), [fn, arg] as const) as Promise<T>
const saved = (userData: string) => existsSync(join(userData, 'settings.json')) ? JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')) : {}

test('a transcript rule asks first with the count; Apply deletes the transcript and audio, and the note keeps its summary', async () => {
  const { app, page, userData } = await launch()
  try {
    const id = await fake<string>(app, 'bigMeeting', 4)
    await page.evaluate(id => window.yogurt.notes.writeAgain(id), id)
    await expect.poll(async () => (await page.evaluate(id => window.yogurt.notes.get(id), id)).status).toBe('done')
    const summary = (await page.evaluate(id => window.yogurt.notes.get(id), id)).enhanced
    await fake(app, 'endedDaysAgo', [id, 40])
    await page.getByTestId('settings-open').click()
    const choice = page.getByTestId('retention-transcript-choice')
    await choice.selectOption('30')
    await expect(page.getByTestId('retention-confirm')).toContainText('1 meeting already qualifies. Its transcript and audio are deleted now; its notes stay.')
    await page.getByTestId('retention-confirm-cancel').click()
    await expect(choice).toHaveValue('never')
    expect(saved(userData).transcriptDays).toBeUndefined()
    expect((await page.evaluate(id => window.yogurt.transcript.get(id), id)).length).toBe(4)
    await choice.selectOption('30')
    await page.getByTestId('retention-confirm-yes').click()
    await expect.poll(async () => (await page.evaluate(id => window.yogurt.transcript.get(id), id)).length).toBe(0)
    expect(saved(userData).transcriptDays).toBe(30)
    expect(await page.evaluate(id => window.yogurt.audio.tracks(id), id)).toEqual([])
    expect(existsSync(join(userData, 'meetings', id, 'me.wav'))).toBe(false)
    await fake(app, 'go', `/note/${id}`)
    await expect(page.getByTestId('note-resume')).toHaveCount(0)
    await page.getByRole('tab', { name: 'Transcript', exact: true }).click()
    await expect(page.getByTestId('transcript-deleted')).toContainText('The transcript was deleted on')
    expect((await page.evaluate(id => window.yogurt.notes.get(id), id)).enhanced).toBe(summary)
  } finally { await app.close() }
})

test('Other shows an empty days field only while picked, and saves a whole number of days', async () => {
  const { app, page, userData } = await launch()
  try {
    await page.getByTestId('settings-open').click()
    const choice = page.getByTestId('retention-meeting-choice'), days = page.getByTestId('retention-meeting-days')
    await expect(days).toHaveCount(0)
    await choice.selectOption('other')
    await expect(days).toBeVisible(); await expect(days).toHaveValue(''); await expect(days).toBeFocused()
    await choice.selectOption('never')
    await expect(days).toHaveCount(0)
    await choice.selectOption('other')
    await expect(days).toHaveValue('')
    await days.fill('45'); await days.press('Enter')
    await expect.poll(() => saved(userData).meetingDays).toBe(45)
    await page.getByTestId('nav-home').click()
    await page.getByTestId('settings-open').click()
    await expect(choice).toHaveValue('other'); await expect(days).toHaveValue('45')
    await choice.selectOption('never')
    await expect(days).toHaveCount(0)
    await expect.poll(() => saved(userData).meetingDays).toBeUndefined()
  } finally { await app.close() }
})
