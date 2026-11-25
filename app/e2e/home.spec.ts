import { openFromCorner } from './cornerNavigation'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Meeting } from '../src/shared/types'
import { selectUpcomingAgendaDay } from './agendaDate'

const main = join(import.meta.dirname, '../out/main/index.js')

async function launch(env: Record<string, string> = {}, userData = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))) {
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData, ...env } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page, userData }
}
const fake = <T>(app: ElectronApplication, fn: string, arg?: unknown): Promise<T> =>
  app.evaluate((_e, [fn, arg]) => (globalThis as unknown as Record<string, Record<string, (a?: unknown) => unknown>>).__fake__[fn as string](arg), [fn, arg] as const) as Promise<T>
const routeOf = (page: Page) => page.evaluate(() => window.yogurt.nav.current())
const meetingOf = (page: Page, id: string) => page.evaluate((id) => window.yogurt.meetings.get(id), id) as Promise<Meeting>

// Prepared notes remain supported by the backend, but the agenda no longer creates one on click.
async function prepareCalendarNote(page: Page, title: string) {
  const id = await page.evaluate(async (title) => {
    const at = Date.now()
    const event = (await window.yogurt.calendar.day(at)).events.find(event => event.title === title)
    if (!event) throw new Error(`Missing calendar fixture: ${title}`)
    const result = await window.yogurt.meetings.prepare(event.id, at)
    if (!('id' in result)) throw new Error(`Could not prepare calendar fixture: ${result.error}`)
    return result.id
  }, title)
  await expect.poll(() => routeOf(page)).toBe(`/note/${id}`)
  return id
}

test('meeting rows show captured duration, excluding gaps, only after recording finishes', async () => {
  const { app, page, userData } = await launch()
  const db = new DatabaseSync(join(userData, 'yogurt.db'), { timeout: 5000 })
  try {
    await fake(app, 'manyMeetings', 6)
    db.prepare("UPDATE meetings SET duration_ms = ?, ended_at = started_at + ? WHERE title = 'Budget review'").run(32 * 60_000, 2 * 24 * 60 * 60_000)
    db.prepare("UPDATE meetings SET duration_ms = NULL, ended_at = started_at + ? WHERE title = 'Weekly sync'").run(35 * 60_000)
    db.prepare("UPDATE meetings SET duration_ms = 2000 WHERE title = 'Customer call with Acme'").run()
    db.prepare("UPDATE meetings SET state = 'prepared', ended_at = NULL, duration_ms = NULL WHERE title = 'Design crit'").run()
    db.prepare("UPDATE meetings SET state = 'stopped', ended_at = NULL, duration_ms = NULL WHERE title = '1:1 with Maya'").run()
    db.prepare("UPDATE meetings SET state = 'recording', ended_at = NULL, duration_ms = ? WHERE title = 'Hiring loop'").run(44 * 60_000)
    await page.reload()
    const card = (title: string) => page.getByTestId('past-note').filter({ hasText: title })
    await expect(card('Budget review').getByTestId('past-note-duration')).toHaveText('32 min')
    await expect(card('Weekly sync').getByTestId('past-note-duration')).toHaveText('35 min')
    await expect(card('Customer call with Acme').getByTestId('past-note-duration')).toHaveText('1 min')
    for (const title of ['Design crit', '1:1 with Maya', 'Hiring loop']) await expect(card(title).getByTestId('past-note-duration')).toHaveCount(0)
    await expect(card('Hiring loop')).toContainText('Recording')
    await expect(page.getByRole('heading', { name: 'Your meetings', exact: true })).toBeVisible()
  } finally { db.close(); await app.close() }
})

test('a prepared calendar note keeps its notes without recording; Start recording reuses it; ⌘K finds its contents', async () => {
  const { app, page } = await launch()
  try {
    const coming = page.getByTestId('coming-up')
    const standup = coming.getByTestId('event').filter({ hasText: 'Team standup' })
    await expect(standup).toBeVisible()
    await expect(standup.locator('.agenda-people')).toHaveCount(0)
    await selectUpcomingAgendaDay(page, 1)
    await expect(coming.getByTestId('event').filter({ hasText: 'Design review' })).toBeVisible()
    await page.getByRole('button', { name: 'Today', exact: true }).click()
    await expect(standup).toBeVisible()
    await expect(page.getByTestId('past-empty')).toBeVisible()

    const id = await prepareCalendarNote(page, 'Team standup')
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'prepared')
    const m = await meetingOf(page, id)
    expect(m).toMatchObject({ title: 'Team standup', state: 'prepared', app: null })
    expect(m.eventId).toContain('fake-standup')
    expect(m.attendees.map((a) => a.name)).toEqual(['Ann Lee', 'Bo Park'])

    await page.getByTestId('note-mine').click({ position: { x: 24, y: 12 } })
    await page.keyboard.type('Check the pricing page with Ann')
    await expect.poll(async () => (await page.evaluate((id) => window.yogurt.notes.get(id), id)).mine, { timeout: 5000 }).toContain('pricing')
    await page.getByTestId('nav-home').click()
    await standup.getByTestId('event-details').click()
    await page.getByTestId('event-open').click()
    expect(await routeOf(page)).toBe(`/note/${id}`)
    expect((await page.evaluate(() => window.yogurt.meetings.cards({ limit: 50 }))).filter((c) => c.state === 'recording')).toEqual([])
    await page.getByTestId('note-transcript-toggle').click()
    await page.getByTestId('note-start').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    expect(await routeOf(page)).toBe(`/note/${id}`)
    await expect(page.getByTestId('note-notes-tab')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('note-mine')).toBeVisible()
    await expect(page.getByTestId('note-mine')).toContainText('Check the pricing page with Ann')
    await expect.poll(async () => (await page.evaluate((id) => window.yogurt.transcript.get(id), id)).length, { timeout: 15_000 }).toBeGreaterThan(0)
    await page.getByTestId('note-stop').click()

    await page.getByTestId('nav-home').click()
    await expect(page.getByTestId('home')).toBeVisible()
    const card = page.getByTestId('past-note').filter({ hasText: 'Team standup' })
    await expect(card).toBeVisible()
    // the two invited, and Cy Dao, whom the fake Zoom call shows too (names from the call join the attendees)
    await expect(card.getByTestId('past-note-attendees')).toHaveText('Ann, Bo, Cy')
    await expect(card.getByTestId('past-note-preview')).toHaveCount(0)
    await expect(page.getByTestId('past-day').first()).toContainText('Today')

    await page.keyboard.press('Meta+k')
    const search = page.getByTestId('search')
    await expect(search).toBeVisible()
    await page.keyboard.type('pricing')
    const hit = search.getByTestId('search-result').filter({ hasText: 'Team standup' })
    await expect(hit).toBeVisible()
    await expect(hit.locator('mark').first()).toHaveText(/pricing/i)
    await hit.click()
    await expect(search).toHaveCount(0)
    await expect(page.getByTestId('note-title')).toHaveText('Team standup')
    expect(await routeOf(page)).toBe(`/note/${id}`)
    await page.getByTestId('note-attendees').click()
    for (const name of ['Ann Lee', 'Bo Park', 'Cy Dao']) await expect(page.getByTestId('people-list')).toContainText(name)
  } finally { await app.close() }
})

test('agenda opens details on demand and the title bar records the current event', async () => {
  const { app, page } = await launch()
  try {
    // Keep past/current/upcoming fixture rows on one day even when CI runs at midnight.
    const now = await page.evaluate(() => { const day = new Date(); day.setHours(12, 0, 0, 0); return +day })
    await page.clock.setFixedTime(now)
    await app.evaluate(async (_e, at) => {
      await (globalThis as unknown as { __fake__: { advance(ms: number): Promise<void> } }).__fake__.advance(at - Date.now())
    }, now)
    await fake(app, 'calendarEvents', [
      { id: 'past', title: 'Earlier meeting', start: new Date(now - 600000).toISOString(), end: new Date(now - 300000).toISOString(), attendees: [] },
      { id: 'live', title: 'Current meeting', start: new Date(now - 60000).toISOString(), end: new Date(now + 300000).toISOString(), attendees: [] },
      { id: 'next', title: 'Later meeting', start: new Date(now + 600000).toISOString(), end: new Date(now + 900000).toISOString(), attendees: [] },
    ])
    await page.reload()
    const event = (title: string) => page.getByTestId('event').filter({ hasText: title })
    const details = page.getByTestId('event-details-content')
    await expect(page.getByTestId('event')).toHaveCount(3)
    await expect(details).toHaveCount(0)
    await expect(page.getByTestId('event-prepare')).toHaveCount(0)
    await expect(page.getByTestId('event-open')).toHaveCount(0)
    await expect(page.getByTestId('event-start')).toHaveCount(0)
    await expect(page.getByTestId('new-note')).toHaveText('Take notes · Current meeting')
    await event('Earlier meeting').getByTestId('event-details').click()
    await expect(page.getByTestId('home')).toBeVisible()
    await expect(details.getByRole('heading')).toHaveText('Earlier meeting')
    await expect(details.getByTestId('event-open')).toHaveText('Prepare note')
    await expect(details.getByTestId('event-open')).toBeVisible()
    expect(await page.evaluate(() => window.yogurt.meetings.cards({ limit: 50 }))).toEqual([])
    await details.getByRole('button', { name: 'Close', exact: true }).click()

    const earlier = await prepareCalendarNote(page, 'Earlier meeting')
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'prepared')
    await page.getByTestId('nav-home').click()
    await event('Earlier meeting').getByTestId('event-details').focus()
    await page.keyboard.press('Enter')
    await details.getByRole('button', { name: 'Open note', exact: true }).click()
    expect(await routeOf(page)).toBe(`/note/${earlier}`)
    const current = await prepareCalendarNote(page, 'Current meeting')
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'prepared')
    await page.getByTestId('nav-home').click()
    await page.getByTestId('new-note').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    expect(await routeOf(page)).toBe(`/note/${current}`)
    await page.getByTestId('nav-home').click()
    await expect(page.getByTestId('event-start')).toHaveCount(0)
    await expect(event('Current meeting').getByRole('img', { name: 'Recording', exact: true })).toBeVisible()
    await event('Current meeting').getByTestId('event-details').click()
    await details.getByRole('button', { name: 'Open note', exact: true }).click()
    expect(await routeOf(page)).toBe(`/note/${current}`)
    await page.getByTestId('note-stop').click()
    await page.getByTestId('nav-home').click()
    await expect(page.getByTestId('event-start')).toHaveCount(0)
  } finally { await app.close() }
})

test('New note records with no event, and nothing records before the click', async () => {
  const { app, page } = await launch()
  try {
    expect(await fake<{ route: string }>(app, 'main')).toMatchObject({ route: '' })
    // Record stays in the header for both populated and empty libraries.
    await fake(app, 'manyMeetings', 1)
    await page.reload()
    await expect(page.getByTestId('new-note')).toBeVisible()
    await expect(page.getByTestId('new-note')).toHaveText('Record')
    const before = await page.evaluate(() => window.yogurt.meetings.cards({ limit: 50 }))
    expect(before.filter((c) => c.state === 'recording')).toEqual([])
    await page.getByTestId('new-note').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    const m = await meetingOf(page, (await routeOf(page)).slice('/note/'.length))
    expect(m).toMatchObject({ eventId: null, attendees: [], state: 'recording' })
    // while it records, home says so and takes you back to it
    await page.getByTestId('nav-home').click()
    await expect(page.getByTestId('recording-return')).toBeVisible()
    await expect(page.getByTestId('new-note')).toHaveCount(0)
    await page.getByTestId('recording-return').click()
    await expect(page.getByTestId('note')).toBeVisible()
  } finally { await app.close() }
})

test('no meetings yet: plain words and one button', async () => {
  const { app, page } = await launch()
  try {
    const empty = page.getByTestId('past-empty')
    await expect(empty).toBeVisible()
    await expect(empty.getByRole('button')).toHaveCount(1)
    await expect(page.getByTestId('new-note')).toBeVisible()
    await empty.getByRole('button', { name: 'Record', exact: true }).click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
  } finally { await app.close() }
})

for (const state of ['default', 'live', 'resume'] as const) test(`Home keeps the ${state} recording label when Agenda closes`, async ({}, testInfo) => {
  const { app, page } = await launch()
  try {
    const title = 'Quarterly planning with the customer success and product teams'
    const now = await page.evaluate(() => new Date().setHours(12, 0, 0, 0))
    await page.clock.setFixedTime(now)
    await fake(app, 'manyMeetings', { n: 6, clean: true })
    await fake(app, 'calendarEvents', [{
      id: 'planning', title, start: new Date(now + (state === 'default' ? 5 : -5) * 60_000).toISOString(),
      end: new Date(now + 30 * 60_000).toISOString(), attendees: [],
    }])
    if (state === 'resume') await page.evaluate(async at => {
      const [meeting] = await window.yogurt.meetings.cards({ limit: 1 })
      await window.yogurt.meetings.linkEvent(meeting.id, 'planning', at)
    }, now)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.reload()
    await expect(page.getByTestId('past-note')).toHaveCount(6)
    await expect(page.getByTestId('event').filter({ hasText: title })).toBeVisible()
    const button = page.getByTestId('new-note')
    const expected = state === 'live' ? `Take notes · ${title}` : state === 'resume' ? 'Resume recording' : 'Record'
    for (const agenda of ['open', 'hidden'] as const) {
      if (agenda === 'hidden') {
        await page.getByRole('button', { name: 'Hide Agenda' }).click()
        await page.mouse.move(720, 40)
        await expect(page.getByRole('complementary', { name: 'Agenda' })).toBeHidden()
      }
      await expect(button).toHaveText(expected)
      await expect(button).toHaveAccessibleName(expected)
      await expect(button).toHaveAttribute('title', expected)
      if (state === 'live') expect(await button.locator('.recording-label').evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true)
      for (const theme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
        await page.screenshot({ path: testInfo.outputPath(`home-record-${state}-agenda-${agenda}-${theme}.png`) })
      }
    }
  } finally { await app.close() }
})

test('Home remembers a hidden Agenda after relaunch and keeps the recording menu available', async () => {
  const env = { YOGURT_FAKE_CALENDAR: 'notDetermined' }
  const first = await launch(env)
  try {
    await expect(first.page.getByTestId('calendar-off')).toBeVisible()
    const list = first.page.locator('.native-home .native-library')
    const width = await list.evaluate(el => el.clientWidth)
    await first.page.getByRole('button', { name: 'Hide Agenda' }).click()
    await expect(first.page.getByRole('complementary', { name: 'Agenda' })).toHaveCount(0)
    await expect.poll(() => list.evaluate(el => el.clientWidth)).toBeGreaterThan(width)
  } finally { await first.app.close() }
  const { app, page } = await launch(env, first.userData)
  try {
    const toggle = page.locator('#home-agenda-toggle')
    await expect(toggle).toHaveAccessibleName('Show Agenda')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    const record = page.locator('#workspace-actions').getByTestId('new-note')
    await expect(record).toHaveAccessibleName('Record')
    await expect(record.locator('.recording-label')).toHaveText('Record')
    await expect(record).toHaveAttribute('title', 'Record')
    await page.getByTestId('recording-choices').click()
    await expect(page.getByTestId('recording-unattached')).toBeVisible()
    await page.keyboard.press('Escape')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await toggle.click()
    const connect = page.getByTestId('calendar-off').getByRole('button')
    await expect(connect).toBeVisible()
    await connect.focus()
    const mac = await page.evaluate(() => window.yogurt.os === 'darwin')
    await expect(toggle).toHaveAttribute('aria-keyshortcuts', mac ? 'Control+Meta+A' : 'Control+Shift+A')
    await page.keyboard.press(mac ? 'Control+Meta+a' : 'Control+Shift+a')
    await expect(toggle).toBeFocused()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByTestId('calendar-off')).toHaveCount(0)

    // With the left sidebar open, a 720px window puts Agenda below the list.
    const win = await app.browserWindow(page)
    await win.evaluate(w => w.setContentSize(720, 650))
    const expand = page.getByTestId('sidebar-expand')
    await expect(expand).toBeVisible()
    await expand.click()
    const list = page.locator('.native-home .native-library')
    const height = await list.evaluate(el => el.clientHeight)
    await toggle.click()
    const agenda = page.getByRole('complementary', { name: 'Agenda' })
    await expect(agenda).toBeVisible()
    const above = (await list.boundingBox())!, below = (await agenda.boundingBox())!
    expect(below.y).toBeCloseTo(above.y + above.height, 0)
    expect(below.height).toBe(200)
    await toggle.click()
    await expect.poll(() => list.evaluate(el => el.clientHeight)).toBe(height)
  } finally { await app.close() }
})

test('meeting rows fill a laptop pane and stay centred in their own column through Agenda motion', async () => {
  const { app, page } = await launch()
  try {
    await fake(app, 'manyMeetings', 2)
    await page.reload()
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const row = page.getByTestId('past-note').first()
    await expect(row).toBeVisible()
    const gap = page.locator('.workspace-sidebar-gap')
    for (const direction of ['ltr', 'rtl']) {
      await page.evaluate(dir => { document.documentElement.dir = dir }, direction)
      for (const [width, sidebar] of [[720, 208], [868, 208], [1440, 208], [1440, 0], [1728, 208], [1728, 0], [1920, 208], [2560, 208]]) {
        await page.setViewportSize({ width, height: 760 })
        // Let the automatic sidebar collapse on crossing 900px finish before choosing a state.
        await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
        const changeSidebar = page.getByTestId(sidebar === 208 ? 'sidebar-expand' : 'sidebar-collapse')
        if (await changeSidebar.count()) await changeSidebar.press('Enter')
        await expect.poll(() => gap.evaluate(el => el.getBoundingClientRect().width)).toBe(sidebar)
        const result = await row.evaluate(async card => {
          const home = card.closest<HTMLElement>('.native-home')!
          const list = card.closest<HTMLElement>('.native-library')!
          const hover = card.closest('.native-meeting-row')!
          const toggle = document.getElementById('home-agenda-toggle')!
          const heading = list.querySelector('.library-page-heading')!, day = list.querySelector('[data-testid="past-day"]')!
          let error = 0
          function measure() {
            const css = getComputedStyle(list)
            const left = list.getBoundingClientRect().left + list.clientLeft + parseFloat(css.paddingLeft)
            const available = list.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight)
            const width = Math.min(available + 16, 1080)
            const centre = left + available / 2
            const row = hover.getBoundingClientRect()
            error = Math.max(error, Math.abs(row.left - (centre - width / 2)), Math.abs(row.width - width))
            for (const el of [heading, day]) {
              const box = el.getBoundingClientRect()
              error = Math.max(error, Math.abs(box.left - row.left - 8), Math.abs(row.right - box.right - 8))
            }
          }
          const listWidths = [list.getBoundingClientRect().width]
          measure()
          for (const open of [false, true]) {
            toggle.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
            // The 200 ms UI timer and the grid transition can finish on different frames.
            do {
              await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
              measure()
            } while (home.dataset.agendaMotion === 'true' || home.getAnimations().length > 0)
            if (toggle.getAttribute('aria-expanded') !== String(open)) throw new Error('Agenda did not toggle')
            listWidths.push(list.getBoundingClientRect().width)
          }
          return { error, listWidths }
        })
        // clientWidth rounds fractional grid widths to whole pixels at intermediate frames.
        expect(result.error, `${direction}, ${width}px window / ${sidebar}px sidebar`).toBeLessThan(1)
        const pane = width - sidebar
        const agenda = pane <= 520 ? 0 : pane <= 700 ? 235 : 270
        expect(result.listWidths).toEqual([pane - agenda, pane, pane - agenda])
      }
    }
  } finally { await app.close() }
})

test('wide Home with both sidebars hidden in light and dark', async ({}, testInfo) => {
  const { app, page } = await launch()
  try {
    await fake(app, 'manyMeetings', { n: 12, clean: true })
    await page.evaluate(async () => {
      const folder = await window.yogurt.folders.create('Acme')
      const meetings = await window.yogurt.meetings.cards({ limit: 12 })
      await window.yogurt.folders.add(folder!.id, meetings.find(m => m.title === 'Customer call with Acme')!.id)
    })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
    await page.reload()
    await expect(page.getByTestId('past-note-folder').first()).toHaveText('Acme')
    await expect(page.locator('.library-load')).toHaveAttribute('data-loading-phase', 'ready')
    const sidebar = page.getByRole('complementary', { name: 'Main navigation' })
    const agenda = page.getByRole('complementary', { name: 'Agenda' })
    const search = page.getByRole('button', { name: 'Search meetings', exact: true })
    await expect(sidebar).toBeVisible()
    await expect(agenda.getByTestId('event').first()).toBeVisible()
    await expect(search).toBeHidden()
    await page.screenshot({ path: testInfo.outputPath('home-wide-1440-light-sidebars-open.png') })
    await page.getByTestId('sidebar-collapse').click()
    await page.mouse.move(720, 40)
    await expect(sidebar).toBeHidden()
    await search.click()
    await expect(page.getByTestId('search-input')).toBeFocused()
    await expect(page.getByTestId('search-scope')).toHaveCount(0)
    await page.getByTestId('search-input').fill('Budget review')
    await expect(page.getByTestId('search-result').first()).toContainText('Budget review')
    await page.keyboard.press('Escape')
    await expect(search).toBeFocused()
    await page.getByRole('button', { name: 'Hide Agenda' }).click()
    await page.mouse.move(720, 40)
    await expect(agenda).toBeHidden()
    await expect(search).toBeVisible()
    await expect(page.getByTestId('new-note')).toHaveText('Record')
    for (const width of [1440, 1920]) {
      await page.setViewportSize({ width, height: 900 })
      await expect(page.locator('.native-meeting-row').first()).toHaveCSS('width', '1080px')
      for (const theme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
        await page.screenshot({ path: testInfo.outputPath(`home-wide-${width}-${theme}.png`) })
      }
    }
  } finally { await app.close() }
})

test('wide folder and Trash pages centre their headings and empty states on the same measure', async () => {
  const { app, page } = await launch()
  try {
    await page.setViewportSize({ width: 2560, height: 760 })
    await page.evaluate(() => window.yogurt.folders.create('Planning'))
    for (const empty of ['folder-empty', 'trash-none'] as const) {
      if (empty === 'trash-none') await openFromCorner(page, 'nav-trash')
      else await page.getByTestId('sidebar-folder-open').filter({ hasText: 'Planning' }).click()
      const state = page.getByTestId(empty)
      await expect(state).toBeVisible()
      const boxes = await state.evaluate(el => {
        const list = el.closest<HTMLElement>('.native-library')!
        const centre = list.getBoundingClientRect().left + list.clientLeft + list.clientWidth / 2
        return [list.firstElementChild!, el].map(item => {
          const { left, width } = item.getBoundingClientRect()
          return { width, offset: left + width / 2 - centre }
        })
      })
      for (const box of boxes) {
        expect(box.width).toBe(1080 - 16)
        expect(Math.abs(box.offset)).toBeLessThan(1)
      }
    }
  } finally { await app.close() }
})

test('calendar not asked yet: one button asks, then the meetings show', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_CALENDAR: 'notDetermined' })
  try {
    const off = page.getByTestId('calendar-off')
    await expect(off).toBeVisible()
    await expect(off.getByRole('button')).toHaveCount(1)
    await off.getByRole('button').click()
    await expect(page.getByTestId('coming-up').getByTestId('event').filter({ hasText: 'Team standup' })).toBeVisible()
  } finally { await app.close() }
})

test('calendar access turned off: the one button opens the Mac settings', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_CALENDAR: 'denied' })
  try {
    const off = page.getByTestId('calendar-off')
    await expect(off).toBeVisible()
    await page.getByRole('button', { name: 'Hide Agenda' }).click()
    await page.getByRole('button', { name: 'Show Agenda' }).click()
    await expect(off.getByRole('button')).toHaveAccessibleName('Open System Settings')
    await expect(off.getByRole('button')).toHaveCount(1)
    await off.getByRole('button').click()
    await expect.poll(async () => (await fake<{ settingsOpened: number }>(app, 'main')).settingsOpened).toBe(1)
  } finally { await app.close() }
})

for (const theme of ['light', 'dark'] as const) {
  test(`Go to date lands on the nearest meeting day and returns to the top for a future date in ${theme}`, async ({}, testInfo) => {
    const { app, page, userData } = await launch()
    const db = new DatabaseSync(join(userData, 'yogurt.db'), { timeout: 5000 })
    try {
      await fake(app, 'manyMeetings', { n: 100, clean: true })
      const rows = db.prepare('SELECT id FROM meetings ORDER BY started_at DESC').all()
      const date = (offset: number) => new Date(2024, 10, 11 + offset, 12)
      const stamp = db.prepare('UPDATE meetings SET started_at = ?, ended_at = ? WHERE id = ?')
      const today = new Date(2026, 10, 24, 12)
      await page.clock.setFixedTime(today)
      // Nov 12 is a tie. Skipping Nov 9 makes Nov 11 the closest day to Nov 10 on the second page.
      rows.forEach(({ id }, i) => {
        const at = theme === 'light' && i < 3 ? today.getTime() - i * 60_000 : date(i === 61 ? -4 : 2 * (60 - i)).getTime()
        stamp.run(at, at + 30 * 60_000, id)
      })
      await page.evaluate(theme => window.yogurt.settings.setTheme(theme), theme)
      await page.reload()
      await page.emulateMedia({ colorScheme: theme, reducedMotion: theme === 'dark' ? 'reduce' : 'no-preference' })
      await expect(page.getByTestId('past-note').first()).toBeVisible()
      expect(await page.getByTestId('past-note').count()).toBeLessThan(61)
      await page.getByRole('button', { name: 'Hide Agenda' }).click()
      if (theme === 'dark') await openFromCorner(page, 'nav-trash')

      const jump = async (query: string) => {
        await page.keyboard.press('Meta+k')
        await page.getByTestId('search-input').fill(query)
        await expect(page.getByTestId('command-agenda-date')).toHaveAttribute('aria-selected', 'true')
        await page.keyboard.press('Enter')
        await expect(page.getByTestId('search')).toHaveCount(0)
      }
      const library = page.locator('.native-home .native-library')
      const trace = await page.evaluateHandle(() => ({
        landing: new Promise<{ from: number; viewport: number }>(resolve => {
          document.addEventListener('focusin', function onFocus(event) {
            const heading = event.target
            if (!(heading instanceof HTMLElement) || !heading.dataset.rowHeading) return
            document.removeEventListener('focusin', onFocus)
            const pane = heading.closest<HTMLElement>('.native-library')!
            resolve({ from: pane.scrollTop, viewport: pane.clientHeight })
          })
        }),
      }))
      await jump('November 12, 2024')
      const heading = page.locator(`[data-row-heading="${date(0).toDateString()}"]`)
      await expect(heading).toBeFocused()
      await expect.poll(() => heading.evaluate(el => {
        const pane = el.closest<HTMLElement>('.native-library')!
        return Math.abs(el.getBoundingClientRect().top - pane.getBoundingClientRect().top - parseFloat(getComputedStyle(pane).paddingTop))
      })).toBeLessThan(1)
      const { from, viewport } = await trace.evaluate(t => t.landing)
      const to = await library.evaluate(el => el.scrollTop)
      expect(to).toBeGreaterThan(viewport * 2)
      if (theme === 'light') expect(Math.abs(to - from - viewport)).toBeLessThanOrEqual(1)
      else expect(from).toBe(0)
      await expect(heading).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      await expect(heading).toHaveCSS('outline-style', 'none')
      await expect(library.getByText(/^No meetings on /)).toHaveCount(0)
      const agenda = page.getByRole('complementary', { name: 'Agenda' })
      await expect(agenda.getByRole('button', { name: 'Tuesday, November 12', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await page.getByTestId('home').screenshot({ path: testInfo.outputPath(`meeting-date-jump-${theme}.png`) })

      await jump('November 10, 2024')
      await expect(heading).toBeFocused()
      await expect(agenda.getByRole('button', { name: 'Sunday, November 10', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await jump('November 11, 2023')
      const oldest = date(2 * (61 - rows.length)).toDateString()
      await expect(library.locator(`[data-row-heading="${oldest}"]`)).toBeFocused()
      await expect.poll(() => library.evaluate(el => Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop))).toBeLessThan(1)
      await expect(library.getByText(/^No meetings on /)).toHaveCount(0)

      await jump('December 12')
      await expect(agenda.getByRole('button', { name: 'Saturday, December 12', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await expect.poll(() => library.evaluate(el => el.scrollTop)).toBe(0)
      await expect(library.getByRole('heading', { name: 'Your meetings', exact: true })).toBeFocused()

      await library.focus()
      await jump('December 13')
      await expect(agenda.getByRole('button', { name: 'Sunday, December 13', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await expect(library).toBeFocused()
      expect(await library.evaluate(el => el.scrollTop)).toBe(0)
    } finally { db.close(); await app.close() }
  })
}

test('500 past meetings: the list opens fast, grouped by day, and loads more as you scroll', async () => {
  const { app, page } = await launch()
  try {
    await fake(app, 'manyMeetings', 500)
    await page.reload()
    const t0 = Date.now()
    await expect(page.getByTestId('past-note').first()).toBeVisible()
    expect(Date.now() - t0).toBeLessThan(1500)
    const first = await page.getByTestId('past-note').count()
    expect(first).toBeLessThan(100)
    expect(await page.getByTestId('past-day').count()).toBeGreaterThan(3)
    for (let i = 0; i < 30 && (await page.getByTestId('past-note').count()) < 500; i++) {
      await page.getByTestId('past-more').scrollIntoViewIfNeeded().catch(() => {})
      await page.waitForTimeout(100)
    }
    await expect(page.getByTestId('past-note')).toHaveCount(500)
    await expect(page.getByTestId('past-more')).toHaveCount(0)
  } finally { await app.close() }
})

test('search: from any screen, as you type, arrows and Enter, Esc closes; a slow older answer never replaces a newer one', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_SEARCH_SLOW: '1' })
  try {
    await fake(app, 'manyMeetings', 40)
    await page.reload()
    await expect(page.getByTestId('past-note').first()).toBeVisible()
    // from a note too
    await page.getByTestId('past-note').first().click()
    await expect(page.getByTestId('note')).toBeVisible()
    await page.keyboard.press('Meta+k')
    const search = page.getByTestId('search')
    await expect(search).toBeVisible()
    // nothing typed: the latest notes
    await expect(search.getByTestId('search-result').first()).toBeVisible()
    // a short query answers slowly (fake), a longer one fast: the newer one must stay
    await page.keyboard.type('cust')
    await page.waitForTimeout(200)
    await page.keyboard.press('Meta+a')
    await page.keyboard.type('budget')
    await expect(search.getByTestId('search-result').first()).toContainText('Budget')
    await page.waitForTimeout(1200)
    const results = search.getByTestId('search-result')
    for (const r of await results.all()) await expect(r.locator('mark').first()).toHaveText(/budget/i)
    await page.keyboard.press('ArrowDown')
    await expect(results.nth(1)).toHaveAttribute('aria-selected', 'true')
    const title = (await results.nth(1).getByTestId('search-result-title').textContent())!
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('note-title')).toHaveText(title)
    await page.keyboard.press('Meta+k')
    await expect(search).toBeVisible()
    await page.keyboard.type('zzqx')
    await expect(search.getByTestId('search-result')).toHaveCount(0)
    await expect(search.getByTestId('search-primary-hint')).toHaveText('↵Ask')
    await page.keyboard.press('Escape')
    await expect(search).toHaveCount(0)
  } finally { await app.close() }
})

test('search finds Chinese and Japanese words inside a line, and markup in a note never runs', async () => {
  const { app, page } = await launch()
  try {
    await fake(app, 'manyMeetings', 3)
    await page.reload()
    // on a busy machine the reload can still be starting when ⌘K is pressed; wait for the meetings, then the box
    await expect(page.getByTestId('past-note').first()).toBeVisible()
    await page.keyboard.press('Meta+k')
    await expect(page.getByTestId('search')).toBeVisible()
    await page.keyboard.type('预算')
    const hit = page.getByTestId('search-result').first()
    await expect(hit).toBeVisible()
    await expect(hit.locator('mark').first()).toContainText('预算')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('search')).toHaveCount(0)
    await page.keyboard.press('Meta+k')
    await expect(page.getByTestId('search-input')).toBeFocused()
    await page.keyboard.type('script')
    await expect(page.getByTestId('search-result').first()).toContainText('<img')
    expect(await page.evaluate(() => (window as unknown as { pwned?: boolean }).pwned)).toBeUndefined()
  } finally { await app.close() }
})

test('search gives focus back to where it was, keeps keys inside, and only ⌘K opens it', async () => {
  const { app, page } = await launch()
  try {
    await fake(app, 'manyMeetings', 5)
    await page.reload()
    await page.getByTestId('past-note').first().click()
    const editor = page.getByTestId('note-enhanced-editor').or(page.getByTestId('note-mine'))
    await editor.click()
    await page.keyboard.press('Meta+k')
    const search = page.getByTestId('search')
    await expect(search).toBeVisible()
    // a click on the panel's padding, then Tab: the keys still reach the search
    await search.click({ position: { x: 4, y: 4 } })
    await page.keyboard.press('Tab')
    await expect(page.getByTestId('search-shortcuts')).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(page.getByTestId('search-input')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(search).toHaveCount(0)
    expect(await editor.evaluate((el) => el.contains(document.activeElement))).toBe(true)
    // Control+K is not the shortcut on a Mac
    await page.keyboard.press('Control+k')
    await page.waitForTimeout(200)
    await expect(search).toHaveCount(0)
  } finally { await app.close() }
})

test('Enter right after typing opens the note that matches, not a result from before', async () => {
  const { app, page } = await launch()
  try {
    await fake(app, 'manyMeetings', 12)
    await page.reload()
    await page.getByTestId('search-open').click()
    await expect(page.getByTestId('search-result').first()).toBeVisible()
    await page.keyboard.type('roadmap')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('note-title')).toHaveText('Roadmap planning')
  } finally { await app.close() }
})

test('day names move on at midnight without a reload', async () => {
  const { app, page } = await launch()
  try {
    await fake(app, 'manyMeetings', 2)
    await page.clock.install({ time: Date.now() })
    await page.reload()
    const first = page.getByTestId('past-day').first()
    await expect(first).toBeVisible()
    const was = await first.textContent()
    const midnight = new Date(); midnight.setHours(24, 1, 0, 0)
    await page.clock.fastForward(midnight.getTime() - Date.now())
    await expect(first).not.toHaveText(was!)
  } finally { await app.close() }
})

test('starting an event gone from the calendar says so plainly, and records nothing', async () => {
  const { app, page } = await launch()
  try {
    const now = Date.now()
    await fake(app, 'calendarEvents', [{ id: 'vanishing', title: 'Current meeting', start: new Date(now - 60000).toISOString(), end: new Date(now + 300000).toISOString(), attendees: [] }])
    await page.reload()
    await expect(page.getByTestId('new-note')).toHaveText('Take notes · Current meeting')
    // Remove it after the click reaches main, so calendar refresh cannot turn this into an unattached action.
    await app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as typeof ipcMain & { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers
      const start = handlers.get('meetings:start')!
      ipcMain.removeHandler('meetings:start')
      ipcMain.handle('meetings:start', (...args) => {
        (globalThis as unknown as { __fake__: { calendarEvents(events: unknown[]): void } }).__fake__.calendarEvents([])
        return start(...args)
      })
    })
    await page.getByTestId('new-note').click()
    await expect(page.getByTestId('start-recording-message')).toHaveText('That meeting is no longer on your calendar.')
    await expect(page.getByTestId('home')).toBeVisible()
    expect((await page.evaluate(() => window.yogurt.meetings.cards({ limit: 5 }))).length).toBe(0)
    // the list catches up with the calendar
    await expect(page.getByTestId('event')).toHaveCount(0)
  } finally { await app.close() }
})

test('a calendar that cannot be read says so, with Try again', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_CALENDAR: 'error' })
  try {
    const off = page.getByTestId('calendar-error')
    await expect(off).toBeVisible()
    await expect(off.getByRole('button')).toHaveText('Try again')
    await expect(page.getByTestId('calendar-off')).toHaveCount(0)
    await fake(app, 'calendarStatus', 'granted')
    await off.getByRole('button').click()
    await expect(page.getByTestId('event').first()).toBeVisible()
  } finally { await app.close() }
})


test('workspace navigation stays usable with the sidebar closed; nothing in it is marked as not built yet', async () => {
  const { app, page } = await launch()
  try {
    await fake(app, 'manyMeetings', 4)
    await page.reload()
    await page.getByTestId('sidebar-collapse').click()
    await page.keyboard.press('Meta+k')
    await expect(page.getByTestId('search')).toBeVisible()
    await page.getByTestId('search-input').fill('')
    await expect(page.getByTestId('search-result').first()).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('note')).toBeVisible()
    await page.getByTestId('nav-back').click()
    await expect(page.getByTestId('home')).toBeVisible()
    await page.getByTestId('sidebar-expand').click()
    await page.getByRole('button', { name: 'Ask', exact: true }).click()
    await expect(page.getByTestId('chat-page')).toBeVisible()
    await openFromCorner(page, 'nav-trash')
    await expect(page.getByTestId('trash-page')).toContainText('The Trash is empty')
    await expect(page.getByText('Planned', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'All meetings', exact: true })).toHaveCount(0)
    await page.getByTestId('nav-home').click()
    await expect(page.getByTestId('past-note')).toHaveCount(4)
    await expect(page.getByRole('complementary', { name: 'Agenda' })).toBeVisible()
    await page.reload()
    await expect(page.getByTestId('home')).toBeVisible()
    await expect(page.getByRole('complementary', { name: 'Agenda' })).toBeVisible()
  } finally { await app.close() }
})

test('unlinking a prepared calendar note keeps the edited title, people and notes', async () => {
  const { app, page } = await launch()
  try {
    const id = await prepareCalendarNote(page, 'Team standup')
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'prepared')
    await page.evaluate(async (id) => {
      await window.yogurt.meetings.rename(id, 'Our planning agenda')
      await window.yogurt.meetings.setAttendees(id, [{ name: 'Maya Chen', email: 'maya@example.com' }])
    }, id)
    await page.getByTestId('note-mine').click({ position: { x: 24, y: 12 } })
    await page.keyboard.type('Keep the release date and launch checklist.')
    await expect.poll(async () => (await page.evaluate((id) => window.yogurt.notes.get(id), id)).mine).toContain('launch checklist')
    await page.getByTestId('note-date').click()
    await page.getByTestId('note-date-events-toggle').click()
    await page.getByTestId('note-date-unlink').click()
    await expect.poll(async () => (await meetingOf(page, id)).eventId).toBeNull()
    expect(await meetingOf(page, id)).toMatchObject({ title: 'Our planning agenda', state: 'prepared', attendees: [{ name: 'Maya Chen', email: 'maya@example.com' }] })
    await expect(page.getByTestId('note-mine')).toContainText('launch checklist')
    await expect(page.getByTestId('note-date-card')).not.toContainText('Our planning agenda')
    await expect(page.getByTestId('note-date-card').getByRole('button', { name: 'Open note' })).toHaveCount(0)
  } finally { await app.close() }
})

test('agenda date navigation keeps the column width and the selected date stays legible on hover', async () => {
  const { app, page } = await launch()
  try {
    await expect(page.getByTestId('event').first()).toBeVisible()
    const agenda = page.getByRole('complementary', { name: 'Agenda' })
    const before = await agenda.boundingBox()
    const selected = agenda.locator('.agenda-week button[aria-pressed="true"]')
    const colors = () => selected.locator('b').evaluate((el) => ({ ink: getComputedStyle(el).color, surface: getComputedStyle(el).backgroundColor }))
    const normal = await colors()
    await selected.hover()
    expect(await colors()).toEqual(normal)
    await selectUpcomingAgendaDay(page, 1)
    await expect(page.getByTestId('event').filter({ hasText: 'Design review' })).toBeVisible()
    await selectUpcomingAgendaDay(page, 2)
    await expect(agenda.getByRole('heading', { name: 'No meetings', exact: true })).toBeVisible()
    await expect(agenda).not.toContainText('Your calendar is clear.')
    const empty = await agenda.boundingBox()
    expect(empty?.x).toBe(before?.x)
    expect(empty?.width).toBe(before?.width)
    await page.getByRole('button', { name: 'Today', exact: true }).click()
    await page.getByTestId('event-details').first().click()
    await expect(page.getByTestId('event-details-content')).toContainText('Ann Lee')
    await expect(page.getByTestId('event-details-content').getByRole('link', { name: 'Join meeting' })).toBeVisible()
  } finally { await app.close() }
})

test('agenda detail cards support keyboard entry, dismissal and return focus without trapping the page', async () => {
  const { app, page } = await launch()
  try {
    const at = new Date(); at.setHours(12, 0, 0, 0)
    await page.clock.setFixedTime(at.getTime() - 60_000)
    const base = { start: at.toISOString(), end: new Date(at.getTime() + 30 * 60_000).toISOString() }
    await fake(app, 'calendarEvents', [
      { ...base, id: 'no-details', title: 'Focus time', attendees: [], url: '   ' },
      { ...base, id: 'people-only', title: 'In-person planning', attendees: [{ name: 'Ann Lee', email: 'ann@example.com' }, { name: 'Bo Park', email: null }], url: null },
      { ...base, id: 'link-only', title: 'Open office hours', attendees: [], url: 'https://meet.google.com/fak-eeve-ntx' },
    ])
    await page.reload()
    const event = (title: string) => page.getByTestId('event').filter({ has: page.getByRole('button', { name: title, exact: true }) })
    const details = page.getByTestId('event-details-content')
    await event('Focus time').getByTestId('event-details').click()
    await expect(details.getByRole('heading')).toHaveText('Focus time')
    await expect(details).toContainText('12:00 PM – 12:30 PM')
    await expect(details.getByRole('link')).toHaveCount(0)
    await expect(details.getByTestId('event-open')).toHaveText('Prepare note')
    await expect(details.getByTestId('event-open')).toBeVisible()
    expect(await details.evaluate(el => el.matches(':modal'))).toBe(false)
    await expect(details.getByRole('heading')).toBeFocused()
    await expect(details.getByRole('button', { name: 'Close', exact: true })).not.toBeFocused()
    await page.keyboard.press('Escape')
    await expect(details).toHaveCount(0)
    await expect(event('Focus time').getByTestId('event-details')).toBeFocused()

    const people = event('In-person planning')
    await people.getByTestId('event-details').click()
    const attendeeNames = details.getByRole('list', { name: 'People' }).getByRole('listitem')
    await expect(attendeeNames).toHaveText(['Ann Lee', 'Bo Park'])
    await expect(details.getByText('ann@example.com', { exact: true })).toHaveCount(0)
    await attendeeNames.first().hover()
    await expect(attendeeNames.first()).toHaveAttribute('title', 'ann@example.com')
    await expect(details.getByRole('link')).toHaveCount(0)
    await page.mouse.move(0, 0)
    await expect(details).toBeVisible()
    await expect(people).toHaveAttribute('data-selected', 'true')
    await details.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(details).toHaveCount(0)
    await expect(people.getByTestId('event-details')).toBeFocused()
    await expect(people).toHaveAttribute('data-selected', 'false')

    const link = event('Open office hours')
    await link.getByTestId('event-details').focus()
    await expect(link.getByTestId('event-details')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(details.getByRole('heading')).toHaveText('Open office hours')
    await expect(details.getByRole('link', { name: 'Join meeting' })).toHaveAttribute('href', 'https://meet.google.com/fak-eeve-ntx')
    await expect(details.getByRole('button', { name: 'Close', exact: true })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(details.getByTestId('event-open')).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(details.getByRole('link', { name: 'Join meeting' })).toBeFocused()
    await page.clock.setFixedTime(at.getTime() + 30 * 60_000)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(details.getByRole('link', { name: 'Join meeting' })).toHaveCount(0)
    await expect(details.getByTestId('event-open')).toBeVisible()
    // The card is nonmodal: a click in the rest of the page dismisses it and still works.
    await page.getByTestId('nav-chat').click()
    await expect(page.getByTestId('chat-page')).toBeVisible()
    await expect(details).toHaveCount(0)
  } finally { await app.close() }
})

test('each agenda day shows only its own meetings, once, even when a meeting is on two calendars', async () => {
  const { app, page } = await launch()
  try {
    const day = (offset: number, hour: number) => { const d = new Date(); d.setDate(d.getDate() + offset); d.setHours(hour, 0, 0, 0); return d }
    // a meeting shared onto a second calendar comes from the Mac twice, with the same id
    const on = (offset: number, hour: number, title: string, calendar = 'Work') => {
      const at = day(offset, hour)
      return { id: `${title}:${at.toISOString()}`, title, calendar, start: at.toISOString(), end: new Date(at.getTime() + 30 * 60_000).toISOString(), attendees: [], url: null }
    }
    await fake(app, 'calendarEvents', [
      on(0, 9, 'Standup'), on(0, 9, 'Standup', 'Shared'), on(0, 12, 'Speed round'), on(0, 12, 'Speed round', 'Shared'),
      on(1, 8, 'Swimming'), on(1, 9, 'Standup'), on(1, 9, 'Standup', 'Shared'), on(1, 13, 'Lunch'),
      on(2, 9, 'Vendor call'), on(2, 9, 'Vendor call', 'Shared'), on(2, 11, 'Dedupe review'), on(2, 11, 'Dedupe review', 'Shared'),
    ])
    await page.reload()
    const titles = page.getByTestId('coming-up').locator('.agenda-title')
    const expectDay = async (list: string[]) => {
      await expect(titles).toHaveText(list)
      // and it stays that way: no rows from another day linger once the list settles
      await page.waitForTimeout(300)
      await expect(titles).toHaveText(list)
    }
    const today = ['Standup', 'Speed round'], tomorrow = ['Swimming', 'Standup', 'Lunch'], after = ['Vendor call', 'Dedupe review']
    await expectDay(today)
    await selectUpcomingAgendaDay(page, 1)
    await expectDay(tomorrow)
    await selectUpcomingAgendaDay(page, 2)
    await expectDay(after)
    await selectUpcomingAgendaDay(page, 1)
    await expectDay(tomorrow)
    await page.getByRole('button', { name: 'Today', exact: true }).click()
    await expectDay(today)
    // a day picked on the week strip (tomorrow is on it unless today is Saturday)
    const strip = page.getByRole('button', { name: day(1, 12).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }), exact: true })
    if (await strip.count()) { await strip.click(); await expectDay(tomorrow) }
  } finally { await app.close() }
})
