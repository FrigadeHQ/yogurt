import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('an event with notes gets a muted notes icon and only a live event gets a purple line', async () => {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-agenda-ribbon-')),
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    const now = new Date(); now.setHours(12, 0, 0, 0)
    await page.clock.setFixedTime(now)
    const events = ['Planning', 'Retro'].map((title, i) => ({ id: `event-${i}`, title, calendar: 'Work',
      start: new Date(+now + (i + 1) * 60 * 60_000).toISOString(), end: new Date(+now + ((i + 1) * 60 + 30) * 60_000).toISOString(), attendees: [] }))
    events.push({ id: 'live', title: 'Current review', calendar: 'Work', start: new Date(+now - 60_000).toISOString(), end: new Date(+now + 30 * 60_000).toISOString(), attendees: [] })
    await app.evaluate((_e, events) => (globalThis as any).__fake__.calendarEvents(events), events)
    await page.reload()
    const row = (title: string) => page.getByTestId('event').filter({ has: page.getByRole('button', { name: title, exact: true }) })
    const line = (title: string) => row(title).locator('.agenda-event-body').evaluate(el => getComputedStyle(el).borderInlineStartColor)
    const { accent, muted } = await page.evaluate(() => {
      const s = document.createElement('span'); document.body.append(s)
      s.style.color = 'var(--accent)'; const accent = getComputedStyle(s).color
      s.style.color = 'var(--muted)'; const muted = getComputedStyle(s).color
      s.remove(); return { accent, muted }
    })
    await expect.poll(() => line('Planning')).not.toBe(accent)
    await expect(row('Planning').getByRole('img', { name: 'Has notes', exact: true })).toHaveCount(0)
    await expect.poll(() => line('Current review')).toBe(accent)

    // notes made for the event (Prepare note in its card)
    expect(await page.evaluate(day => window.yogurt.meetings.prepare('event-0', day), +now)).toHaveProperty('id')
    await expect(page.getByTestId('note-title')).toHaveText('Planning')
    await page.getByTestId('nav-home').click()
    await expect(row('Planning')).toHaveAttribute('data-has-note', 'true')
    await expect(row('Planning').getByRole('img', { name: 'Has notes', exact: true })).toHaveCSS('color', muted)
    expect(await line('Planning')).not.toBe(accent)
    expect(await line('Current review')).toBe(accent)
    expect(await line('Retro')).not.toBe(accent)
    await expect(row('Retro').getByRole('img', { name: 'Has notes', exact: true })).toHaveCount(0)
  } finally { await app.close() }
})
