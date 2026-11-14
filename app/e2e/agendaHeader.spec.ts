import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('day arrows select dates, move the strip past its last day, and Today resets both', async () => {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-agenda-header-')),
  } })
  try {
    const page = await app.firstWindow()
    await page.clock.install({ time: new Date(2026, 10, 30, 12) })
    await page.reload()
    const agenda = page.getByRole('complementary', { name: 'Agenda' })
    const header = agenda.locator('.agenda-header')
    const today = header.getByRole('button', { name: 'Today', exact: true })
    const month = agenda.locator('.agenda-month')
    const dates = agenda.locator('.agenda-week button')
    const labels = () => dates.evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')))
    const reads = () => app.evaluate(() => (globalThis as unknown as { agendaReads: number[] }).agendaReads)
    await expect(header.getByRole('heading', { name: 'Agenda', exact: true })).toBeVisible()
    await expect(agenda.getByTestId('coming-up')).toBeVisible()
    const originalLabels = await labels()
    await app.evaluate(({ ipcMain }) => {
      ;(globalThis as unknown as { agendaReads: number[] }).agendaReads = []
      ipcMain.removeHandler('calendar:day')
      ipcMain.handle('calendar:day', (_e, at: number) => {
        ;(globalThis as unknown as { agendaReads: number[] }).agendaReads.push(at)
        return { status: 'granted', events: [{ id: 'selected', title: 'Selected date event', start: at, end: at + 60_000, attendees: [], url: null }] }
      })
    })
    await expect(month).toHaveText('November 2026')
    const next = agenda.getByRole('button', { name: 'Next day', exact: true })
    const previous = agenda.getByRole('button', { name: 'Previous day', exact: true })
    await next.click()
    await expect.poll(labels).toEqual(originalLabels)
    await expect(month).toHaveText('November 2026')
    await expect(agenda.locator('.agenda-day > span')).toHaveText('Dec 1')
    await expect(agenda.locator('.agenda-day h3')).toHaveText('Tomorrow')
    await expect(agenda.getByRole('button', { name: 'Tuesday, December 1', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(agenda.getByTestId('event')).toContainText('Selected date event')
    await expect.poll(reads).toEqual([new Date(2026, 11, 1, 12).getTime()])
    await agenda.getByTestId('event-details').click()
    await expect(agenda.getByTestId('event-details-content')).toBeVisible()
    await previous.focus()
    await page.keyboard.press('Enter')
    await expect(agenda.getByTestId('event-details-content')).toHaveCount(0)
    await expect(agenda.locator('.agenda-day > span')).toHaveText('Nov 30')
    await expect.poll(labels).toEqual(originalLabels)
    await agenda.getByRole('button', { name: 'Saturday, December 5', exact: true }).click()
    await expect(agenda.locator('.agenda-day > span')).toHaveText('Dec 5')
    await expect(month).toHaveText('November 2026')
    await next.click()
    await expect.poll(labels).toEqual([
      'Sunday, December 6', 'Monday, December 7', 'Tuesday, December 8', 'Wednesday, December 9',
      'Thursday, December 10', 'Friday, December 11', 'Saturday, December 12',
    ])
    await expect(month).toHaveText('December 2026')
    await expect(agenda.locator('.agenda-day > span')).toHaveText('Dec 6')
    await expect(dates.first()).toHaveAttribute('aria-pressed', 'true')
    await previous.click()
    await expect.poll(labels).toEqual(originalLabels)
    await expect(agenda.locator('.agenda-day > span')).toHaveText('Dec 5')
    await expect(dates.last()).toHaveAttribute('aria-pressed', 'true')
    await today.focus()
    await page.keyboard.press('Enter')
    await expect.poll(labels).toEqual(originalLabels)
    await expect(month).toHaveText('November 2026')
    await expect(agenda.locator('.agenda-day h3')).toHaveText('Today')
    await expect(agenda.locator('.agenda-week [aria-current=date]')).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(reads).toEqual([
      new Date(2026, 11, 1, 12), new Date(2026, 10, 30, 12), new Date(2026, 11, 5, 12),
      new Date(2026, 11, 6, 12), new Date(2026, 11, 5, 12), new Date(2026, 10, 30, 12),
    ].map(Number))
  } finally { await app.close() }
})
