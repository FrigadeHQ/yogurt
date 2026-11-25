import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('Granola offers a local CSV import and remembers the result', async ({}, info) => {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_FAKE_GRANOLA: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-granola-')),
  } })
  try {
    const page = await app.firstWindow()
    const prompt = page.getByRole('region', { name: 'Bring your notes from Granola' })
    const settings = page.getByTestId('import-settings')
    for (const width of [1100, 720]) {
      await page.setViewportSize({ width, height: width === 720 ? 520 : 760 })
      for (const theme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: theme })
        await page.evaluate(() => window.yogurt.nav.go('/meetings'))
        await expect(prompt).toBeInViewport()
        await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
        await expect.poll(() => page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(theme === 'dark')
        await page.screenshot({ path: info.outputPath('granola-card-' + width + '-' + theme + '.png') })
        await prompt.getByRole('button', { name: 'Import notes' }).click()
        await expect(settings.getByRole('button', {name:'Connect Granola'})).toBeInViewport()
        await expect(settings.getByRole('button', { name: 'Choose CSV' })).toBeInViewport()
        await page.screenshot({ path: info.outputPath('granola-settings-' + width + '-' + theme + '.png') })
      }
    }
    const file = { name: 'example.csv', mimeType: 'text/csv', buffer: Buffer.from('document_id,document_title,summary\na,Paper samples,Picked cobalt\nb,Blank,') }
    await settings.locator('input[type=file]').setInputFiles(file)
    await expect(settings.getByRole('status')).toContainText('Added 1 meeting')
    await settings.locator('summary').click()
    await expect(settings.locator('details')).toContainText('Blank')
    await settings.locator('input[type=file]').setInputFiles(file)
    await expect(settings.getByRole('status')).toContainText('1 was already here')
    await page.evaluate(() => window.yogurt.nav.go('/meetings'))
    await expect(page.getByTestId('past-note').filter({ hasText: 'Paper samples' })).toBeVisible()
    await expect(prompt).toHaveCount(0)
  } finally { await app.close() }
})

for (const action of ['skip','csv'] as const) test('optional first-run Granola step: ' + action, async () => {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE:'1', YOGURT_FAKE_PLATFORM:'darwin', YOGURT_FAKE_GRANOLA:'1', YOGURT_FAKE_PERMISSIONS:'granted',
    YOGURT_FAKE_CALENDAR:'granted', YOGURT_USER_DATA:mkdtempSync(join(tmpdir(), 'yogurt-granola-first-run-')),
  } })
  try {
    const page = await app.firstWindow()
    await page.getByTestId('intro-next').click()
    const step = page.getByTestId('granola-onboarding')
    await expect(step.getByRole('img', { name: 'Step 2 of 2', exact: true })).toBeVisible()
    await expect(step.locator('.ob-stage .ob-card')).toHaveCount(0)
    await expect(step.getByRole('button', {name:'Connect Granola'})).toBeEnabled()
    await expect(step.getByRole('radio', {name:'Connect', exact:true})).toBeChecked()
    await step.locator('label').filter({hasText:'API key'}).click()
    await expect(step.locator('input[type=password]')).toBeVisible()
    await step.locator('label').filter({hasText:'CSV'}).click()
    await expect(step.locator('input[type=password]')).toHaveCount(0)
    if (action === 'skip') await step.getByRole('button', {name:'Skip'}).click()
    else {
      const chooser = page.waitForEvent('filechooser')
      await step.getByRole('button', {name:'Choose CSV'}).click()
      await (await chooser).setFiles({name:'fixture.csv',mimeType:'text/csv',buffer:Buffer.from('document_id,document_title,summary\nsample,Synthetic note,Meeting summary')})
      await expect(step.getByRole('heading')).toHaveText('Added 1 meeting.')
      await expect(step.locator('.ob-stage').getByText('Synthetic note')).toBeVisible()
      await step.getByRole('button', {name:'Continue'}).click()
    }
    await expect(page.getByTestId('home')).toBeVisible({timeout:15_000})
    await expect(page.getByRole('region', {name:'Bring your notes from Granola'})).toHaveCount(0)
    await page.evaluate(() => window.yogurt.nav.go('/settings/import'))
    const settings = page.getByTestId('import-settings')
    await expect(settings.getByRole('button', {name:'Connect Granola'})).toBeEnabled()
    await expect(settings.getByRole('button', {name:'Choose CSV'})).toBeVisible()
    await expect(settings.getByRole('button', {name:'Use an API key instead'})).toHaveAttribute('aria-expanded','false')
    if (action === 'csv') await expect(settings.getByRole('status')).toContainText('Added 1 meeting')
  } finally { await app.close() }
})
