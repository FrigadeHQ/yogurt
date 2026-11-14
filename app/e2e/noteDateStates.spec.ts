import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const theme of ['light', 'dark'] as const) for (const status of ['notDetermined', 'denied', 'error', 'granted'] as const) {
  test(`date popover recovers from ${status} (${theme})`, async () => {
    const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
      ...process.env, YOGURT_FAKE: '1', YOGURT_FAKE_CALENDAR: status,
      YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-date-states-')),
    } })
    try {
      const page = await app.firstWindow()
      await expect(page.getByTestId('home')).toBeVisible()
      await app.evaluate(() => {
        const fake = (globalThis as any).__fake__
        fake.manyMeetings({ n: 1, clean: true }); fake.calendarEvents([])
      })
      await page.evaluate(theme => window.yogurt.settings.setTheme(theme), theme)
      await page.reload()
      await page.getByTestId('past-note').click()
      await page.getByTestId('note-date').click()
      const card = page.getByTestId('note-date-card')
      await expect(card.getByRole('button', { name: 'Close', exact: true })).toHaveCount(0)
      await expect(card).toContainText('25 min')
      if (status !== 'granted') await expect(card.getByTestId('note-date-previous')).toHaveCount(0)
      await expect(card.getByTestId('note-date-heading')).toBeVisible()
      const label = status === 'error' ? 'Try again' : status === 'denied' ? 'Open System Settings' : status === 'notDetermined' ? 'Connect calendar' : 'Link event'
      const action = card.getByRole('button', { name: label, exact: true })
      await expect(action).toHaveClass('workspace-button agenda-open-note')
      await expect(action).toHaveCSS('height', '28px')
      if (status === 'denied') {
        await action.click()
        await expect.poll(() => app.evaluate(() => (globalThis as any).__fake__.main().settingsOpened)).toBe(1)
        await expect(card).toContainText('Calendar access is off')
        await app.evaluate(() => (globalThis as any).__fake__.calendarStatus('granted'))
        await page.evaluate(() => window.dispatchEvent(new Event('focus')))
      } else if (status === 'error') {
        await expect(card).toContainText("Yogurt couldn't read your calendar")
        await app.evaluate(() => (globalThis as any).__fake__.calendarStatus('granted'))
        await action.click()
      } else if (status === 'notDetermined') {
        await expect(card).toContainText('Calendar access is off')
        await action.click()
      }
      await expect(card.getByTestId('note-date-events-none')).toHaveText('No events')
      await card.getByTestId('note-date-events-toggle').press('Enter')
      await expect(card.getByTestId('note-date-previous')).toBeFocused()
      const header = card.locator('.agenda-inspector-heading')
      const meetingDay = await header.getByTestId('note-date-heading').textContent()
      await expect(header.getByTestId('note-date-previous')).toBeVisible()
      await expect(header.getByTestId('note-date-next')).toBeVisible()
      await expect(card.locator('.note-date-days')).toHaveCount(0)
      const headingBounds = await header.getByTestId('note-date-heading').boundingBox()
      for (const id of ['note-date-previous', 'note-date-next']) {
        const bounds = await header.getByTestId(id).boundingBox()
        expect(Math.abs(bounds!.y - headingBounds!.y)).toBeLessThan(8)
      }
      await header.getByTestId('note-date-next').press('Enter')
      await expect(header.getByTestId('note-date-heading')).not.toHaveText(meetingDay!)
      await expect(card.getByTestId('note-date-events-none')).toBeVisible()
      await header.getByTestId('note-date-previous').press('Enter')
      await expect(header.getByTestId('note-date-heading')).toHaveText(meetingDay!)
      // Revoking access while browsing restores the date/time layout and removes the header arrows.
      await app.evaluate(() => {
        const fake = (globalThis as any).__fake__
        fake.calendarStatus('denied'); fake.calendarEvents([])
      })
      await page.evaluate(() => window.dispatchEvent(new Event('focus')))
      await expect(card.getByRole('button', { name: 'Open System Settings' })).toBeFocused()
      await expect(card).toContainText('25 min')
      await expect(card.getByTestId('note-date-next')).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('note-date')).toBeFocused()
      await page.getByTestId('note-date').press('Enter')
      await expect(card).toBeVisible()
      await page.getByTestId('note-title').dispatchEvent('pointerdown')
      await expect(card).toHaveCount(0)
      await expect(page.getByTestId('note-date')).toBeFocused()
    } finally { await app.close() }
  })
}
