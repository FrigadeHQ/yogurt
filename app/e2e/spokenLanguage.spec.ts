import { openFromCorner } from './cornerNavigation'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')

async function launch(userData = mkdtempSync(join(tmpdir(), 'yogurt-spoken-')), system?: string) {
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData, ...(system ? { YOGURT_SYSTEM_LANGUAGES: system } : {}) } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page, userData }
}
const fake = <T>(app: ElectronApplication, fn: string, arg?: unknown): Promise<T> =>
  app.evaluate((_e, [fn, arg]) => (globalThis as unknown as Record<string, Record<string, (a?: unknown) => unknown>>).__fake__[fn as string](arg), [fn, arg] as const) as Promise<T>
const languages = async (app: ElectronApplication) => (await fake<{ languages: string[] }>(app, 'prompts')).languages
const saved = (userData: string) => JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')).spoken

test('the spoken language picker: English only by default, Multi-language for the recording going on, remembered and shown in Settings', async () => {
  const a = await launch()
  const { app, page } = a
  try {
    await page.locator('#workspace-actions').getByRole('button', { name: 'Record', exact: true }).click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    await expect(page.getByTestId('spoken-name')).toHaveText('English')
    // whisper is told English, nothing is detected
    await expect.poll(async () => (await languages(app)).length, { timeout: 30_000 }).toBeGreaterThan(0)
    expect(new Set(await languages(app))).toEqual(new Set(['en']))

    await page.getByTestId('spoken-chip').click()
    const menu = page.getByTestId('spoken-menu')
    await expect(menu).toBeVisible()
    await expect(page.getByTestId('spoken-en')).toContainText('English only')
    await expect(page.getByTestId('spoken-en')).toContainText('Highest quality')
    await expect(page.getByTestId('spoken-en')).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('spoken-multi')).toContainText('Multi-language')
    await expect(page.getByTestId('spoken-multi')).toContainText('99 languages supported')
    await expect(page.getByTestId('spoken-multi-info')).toHaveAttribute('title', /not in English/)

    // the recording going on detects from its next words, and the choice is kept for the next ones
    const told = (await languages(app)).length
    await page.getByTestId('spoken-multi').click()
    await expect(menu).toHaveCount(0)
    await expect(page.getByTestId('spoken-name')).toHaveText('Multi-language')
    await expect.poll(() => saved(a.userData)).toBe('multi')
    await expect.poll(async () => (await languages(app)).slice(told), { timeout: 30_000 }).toContain('auto')
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')

    // the keyboard: Escape closes, the checked one has focus when it opens
    await page.getByTestId('spoken-chip').click()
    // (a hidden test window never has focus itself, so the element is read instead)
    const focused = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid)
    await expect.poll(focused).toBe('spoken-multi')
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)

    // Settings → Language shows the same choice, and changes it back
    await page.getByTestId('note-stop').click()
    await openFromCorner(page, 'settings-open')
    const picker = page.getByTestId('settings-spoken')
    await expect(picker).toHaveValue('multi')
    await picker.selectOption('en')
    // English only is the default, so it is not written down
    await expect.poll(() => saved(a.userData)).toBeUndefined()
    // one other language: English only, Multi-language, a divider, then the 98 others by name
    await expect(picker.locator('option')).toHaveCount(101)
    await picker.selectOption('es')
    await expect.poll(() => saved(a.userData)).toBe('es')
    await picker.selectOption('multi')
    await expect.poll(() => saved(a.userData)).toBe('multi')
  } finally { await app.close() }

  // after a relaunch the next recording starts in Multi-language
  const b = await launch(a.userData)
  try {
    await b.page.locator('#workspace-actions').getByRole('button', { name: 'Record', exact: true }).click()
    await expect(b.page.getByTestId('spoken-name')).toHaveText('Multi-language')
    await expect.poll(async () => (await languages(b.app)).length, { timeout: 30_000 }).toBeGreaterThan(0)
    expect(new Set(await languages(b.app))).toEqual(new Set(['auto']))
  } finally { await b.app.close() }
})

test('one other language: offered under the note when the interface is in it, and whisper is told it', async () => {
  const { app, page, userData } = await launch(undefined, 'es-ES')
  try {
    await page.locator('#workspace-actions').getByRole('button', { name: 'Grabar', exact: true }).click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    await page.getByTestId('spoken-chip').click()
    await expect(page.getByTestId('spoken-other')).toHaveText(/Español/)
    await expect(page.getByTestId('spoken-other')).toHaveAttribute('aria-checked', 'false')
    const told = (await languages(app)).length
    await page.getByTestId('spoken-other').click()
    await expect(page.getByTestId('spoken-name')).toHaveText('Español')
    await expect.poll(() => saved(userData)).toBe('es')
    // told Spanish from the next words: nothing guessed, nothing translated
    await expect.poll(async () => (await languages(app)).slice(told), { timeout: 30_000 }).toContain('es')
    expect((await languages(app)).slice(told)).not.toContain('auto')
  } finally { await app.close() }
})
