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
    await expect(page.getByTestId('calendar-link-add')).toContainText('Add a calendar by link')
    await expect(form.getByTestId('calendar-link-input')).toBeFocused()
    await expect(page.getByText("Calendars from the Mac's Calendar app appear above automatically.", { exact: true })).toHaveCount(0)
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
    await expect(page.getByTestId('calendar-disconnect-all')).toHaveCount(0)
    const enabled = page.getByTestId('calendar-choice').getByRole('checkbox')
    await enabled.uncheck()
    await expect(enabled).not.toBeChecked()
    await expect(enabled).toBeEnabled()
    await enabled.check()
    await expect(enabled).toBeChecked()
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

test('@everywhere a Mac keeps its own calendar and can add a calendar link next to it (only "other": no Google or Outlook tabs)', async () => {
  const { server, base } = await serve()
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_FAKE_PLATFORM: 'darwin', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-callink-mac-')) } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible({ timeout: 15_000 })
    await page.getByTestId('settings-open').click()
    const settings = page.getByTestId('calendar-settings')
    if (await settings.getByTestId('calendar-settings-toggle').getAttribute('aria-expanded') !== 'true') await settings.getByTestId('calendar-settings-toggle').click()
    await expect(settings.getByTestId('calendar-link-add')).toContainText('Add a calendar by link')
    await expect(settings.getByTestId('calendar-link-add')).toContainText("Calendars from the Mac's Calendar app appear above automatically.")
    await expect(settings.getByTestId('calendar-disconnect')).toHaveCount(0)
    await expect(settings.getByTestId('calendar-disconnect-all')).toHaveCount(0)
    const before = await settings.getByTestId('calendar-choice').count()
    await settings.getByTestId('calendar-link-add').click()
    const form = settings.getByTestId('calendar-link-form')
    await expect(form.getByRole('tab')).toHaveCount(0)
    await expect(form.getByTestId('calendar-link-input')).toBeFocused()
    await form.getByTestId('calendar-link-input').fill('not an address')
    await expect(form.getByTestId('calendar-link-connect')).toBeDisabled()
    await settings.getByRole('heading', { name: 'Calendars' }).click()
    await expect(form.getByTestId('calendar-link-error')).toBeVisible()
    await form.getByTestId('calendar-link-cancel').click()
    await expect(form).toBeHidden()
    await expect(settings.getByTestId('calendar-link-add')).toBeFocused()
    await settings.getByTestId('calendar-link-add').click()
    await expect(form.getByTestId('calendar-link-input')).toHaveValue('not an address')
    await form.getByTestId('calendar-link-input').press('Escape')
    await expect(form).toBeHidden()
    await expect(settings.getByTestId('calendar-link-add')).toBeFocused()
    await settings.getByTestId('calendar-link-add').click()
    await form.getByTestId('calendar-link-input').fill(`${base}/cal.ics`)
    await form.getByTestId('calendar-link-connect').click()
    await expect(settings.getByTestId('calendar-choice')).toHaveCount(before + 1)
    await expect(settings.getByTestId('calendar-choice').filter({ hasText: 'Team calendar' }).getByTestId('calendar-link-remove')).toBeVisible()
    // the Mac's own calendars have no Remove: they live in the Mac's Calendar app
    await expect(settings.getByTestId('calendar-link-remove')).toHaveCount(1)
  } finally { await app.close(); server.close() }
})

test('an unavailable source offers Retry without claiming the day is empty', async () => {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-feed-retry-')),
  } })
  try {
    const page = await app.firstWindow()
    const setUnavailable = (names: string[]) => app.evaluate(({ ipcMain }, unavailable) => {
      ipcMain.removeHandler('calendar:day')
      ipcMain.handle('calendar:day', () => ({ status: 'granted', events: [], unavailable }))
    }, names)
    await setUnavailable(['Team calendar'])
    await page.reload()
    const agenda = page.getByRole('complementary', { name: 'Agenda' })
    await expect(agenda.getByRole('alert')).toContainText('Team calendar')
    await expect(agenda.getByText('No meetings')).toHaveCount(0)
    await setUnavailable([])
    await agenda.getByRole('button', { name: 'Try again' }).click()
    await expect(agenda.getByText('No meetings')).toBeVisible()
    await expect(agenda.getByRole('alert')).toHaveCount(0)
  } finally { await app.close() }
})
