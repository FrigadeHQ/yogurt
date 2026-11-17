import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// @everywhere: Windows and Linux connect their calendar with a private calendar address (iCal), in Settings and in the
// first run, with one form. A made-up feed is served on this computer; YOGURT_FAKE_PLATFORM shows Windows' screens.
const main = join(import.meta.dirname, '../out/main/index.js')
const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')

function serve(): Promise<{ server: Server; base: string }> {
  const start = Date.now() + 30 * 60_000
  const feed = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:Team calendar\r\nBEGIN:VEVENT\r\nUID:plan@example.com\r\nSUMMARY:Launch planning\r\nDTSTART:${stamp(start)}\r\nDTEND:${stamp(start + 30 * 60_000)}\r\nATTENDEE;CN=Dana Smith:mailto:dana@example.com\r\nDESCRIPTION:https://meet.google.com/abc-defg-hij\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`
  const server = createServer((req, res) => {
    if (req.url === '/cal.ics') { res.writeHead(200, { 'content-type': 'text/calendar' }); res.end(feed) } else { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>Sign in</html>') }
  })
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` })))
}

test('@everywhere on win32: the agenda sends you to Settings, a calendar link connects there, and its events show up', async () => {
  const { server, base } = await serve()
  const profile = mkdtempSync(join(tmpdir(), 'yogurt-callink-'))
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_FAKE_PLATFORM: 'win32', YOGURT_USER_DATA: profile } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('calendar-off')).toContainText('Connect a calendar to see your meetings.')
    await page.getByTestId('calendar-off').getByRole('button').click()
    const form = page.getByTestId('calendar-link-form')
    await expect(form).toBeVisible()
    await expect(form.getByTestId('calendar-link-open')).toHaveAttribute('href', /calendar\.google\.com/)
    await form.getByTestId('calendar-link-provider-outlook').click()
    await expect(form.getByTestId('calendar-link-open')).toHaveAttribute('href', /outlook\.office\.com/)
    // a page that isn't a calendar says so, and nothing is connected
    await form.getByTestId('calendar-link-input').fill(`${base}/page`)
    await form.getByTestId('calendar-link-connect').click()
    await expect(form.getByTestId('calendar-link-error')).toContainText("isn't a calendar")
    await form.getByTestId('calendar-link-input').fill(`${base}/cal.ics`)
    await form.getByTestId('calendar-link-connect').click()
    await expect(page.getByTestId('calendar-choice')).toHaveCount(1)
    await expect(page.getByTestId('calendar-choice')).toContainText('Team calendar')
    // the address is kept, but never as written in the settings file
    expect(readFileSync(join(profile, 'settings.json'), 'utf8')).not.toContain('/cal.ics')
    await page.getByTestId('nav-back').click()
    await expect(page.getByTestId('event').filter({ hasText: 'Launch planning' })).toBeVisible()
    // removed: no calendar, and the form is back
    await page.getByTestId('settings-open').click()
    await page.getByTestId('calendar-link-remove').click()
    await expect(page.getByTestId('calendar-link-form')).toBeVisible()
    await expect(page.getByTestId('calendar-choice')).toHaveCount(0)
  } finally { await app.close(); server.close() }
})

test('@everywhere on win32: the first run asks for a calendar link with the same form, and Not now goes on', async () => {
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_FAKE_PLATFORM: 'win32', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-callink-ob-')), YOGURT_FAKE_PERMISSIONS: 'unknown' } })
  try {
    const page = await app.firstWindow()
    await page.getByTestId('intro-next').click()
    const step = page.locator('[data-testid="onboarding-step"][data-step="calendar"]')
    await expect(step).toBeVisible({ timeout: 15_000 })
    await expect(step.getByTestId('calendar-link-form')).toBeVisible()
    await step.getByTestId('step-later').click()
    await expect(step).toHaveCount(0)
  } finally { await app.close() }
})
