import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function launch() {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-start-')),
  } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page }
}
async function folderPage(page: Page) {
  const folder = await page.evaluate(async () => {
    const folder = (await window.yogurt.folders.create('Therapy'))!
    window.yogurt.nav.go(`/folder/${folder.id}`)
    return folder
  })
  await expect(page.getByTestId('folder-title')).toHaveText('Therapy')
  return folder
}
const meetingId = (page: Page) => page.evaluate(async () => (await window.yogurt.nav.current()).slice('/note/'.length))
const foldersOf = (page: Page, id: string) => page.evaluate(id => window.yogurt.folders.of(id), id)
const stop = async (page: Page) => {
  await page.getByTestId('note-stop').click()
  await expect(page.getByTestId('note-state')).not.toHaveAttribute('data-state', 'recording')
}

test('a live event resumes the same note from the title bar and menu, keeping the edited-summary safeguard', async () => {
  test.setTimeout(90_000)
  const { app, page } = await launch()
  try {
    const now = await page.evaluate(() => { const date = new Date(); date.setHours(12, 0, 0, 0); return +date })
    await page.clock.setFixedTime(now)
    await app.evaluate(async (_e, now) => {
      const fake = (globalThis as unknown as { __fake__: { advance(ms: number): Promise<void>; calendarEvents(events: unknown[]): void } }).__fake__
      await fake.advance(now - Date.now())
      fake.calendarEvents([{ id: 'resume-event', title: 'Resume fixture', start: new Date(now - 60_000).toISOString(), end: new Date(now + 30 * 60_000).toISOString(), attendees: [] }])
    }, now)
    await page.reload()
    await expect(page.getByTestId('new-note')).toHaveText('Take notes · Resume fixture')
    await page.getByTestId('new-note').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    const id = await meetingId(page)
    await expect.poll(() => page.evaluate(id => window.yogurt.transcript.get(id).then(lines => lines.length), id), { timeout: 20_000 }).toBeGreaterThan(0)
    await app.evaluate(() => { process.env.YOGURT_FAKE_LLM_MS = '120' })
    await stop(page)
    await expect.poll(() => page.evaluate(id => window.yogurt.notes.get(id).then(notes => notes.status), id)).toBe('writing')
    const prior = await page.evaluate(id => window.yogurt.transcript.get(id), id)
    await page.getByTestId('nav-home').click()
    await expect(page.getByTestId('new-note')).toHaveText('Resume notes · Resume fixture')
    await page.getByTestId('new-note').click()
    await expect(page.getByTestId('note-resume')).toBeDisabled()
    await expect(page.getByTestId('note-state')).not.toHaveAttribute('data-state', 'recording')
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording', { timeout: 30_000 })
    await app.evaluate(() => { process.env.YOGURT_FAKE_LLM_MS = '1' })
    expect(await meetingId(page)).toBe(id)
    await expect(page.getByTestId('resume-confirm')).toHaveCount(0)
    await expect(page.getByTestId('note-notes-tab')).toHaveAttribute('aria-selected', 'true')
    const continued = await page.evaluate(id => window.yogurt.transcript.get(id), id)
    for (const line of prior) expect(continued.find(next => next.id === line.id)).toEqual(line)
    expect(await page.evaluate(() => window.yogurt.meetings.cards({ limit: 10 }))).toHaveLength(1)

    await page.getByTestId('note-notes-tab').click()
    await page.getByRole('textbox', { name: 'My notes', exact: true }).fill('Keep this earlier decision.')
    await stop(page)
    await expect(page.getByTestId('note-resume')).toBeEnabled({ timeout: 30_000 })
    await page.getByTestId('note-summary-tab').click()
    await page.getByRole('textbox', { name: 'Summary', exact: true }).fill('Keep this edited summary until confirmation.')
    await page.getByTestId('nav-home').click()
    await page.getByTestId('recording-choices').click()
    const row = page.getByTestId('recording-meeting')
    await expect(row).toContainText('Resume notes · Resume fixture')
    await row.click()
    await expect(page.getByTestId('resume-confirm')).toBeVisible()
    expect(await meetingId(page)).toBe(id)
    await page.getByTestId('resume-cancel').click()
    await expect(page.getByTestId('note-state')).not.toHaveAttribute('data-state', 'recording')
    // The Summary editor keeps its heading block, so the saved text may start with markdown.
    expect((await page.evaluate(id => window.yogurt.notes.get(id), id)).enhanced).toContain('Keep this edited summary until confirmation.')
    await page.getByTestId('nav-home').click()
    await page.getByTestId('new-note').click()
    await page.getByTestId('resume-yes').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    await expect(page.getByTestId('note-notes-tab')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('textbox', { name: 'My notes', exact: true })).toHaveText('Keep this earlier decision.')
    expect(await meetingId(page)).toBe(id)
    expect(await page.evaluate(() => window.yogurt.meetings.cards({ limit: 10 }))).toHaveLength(1)
  } finally { await app.close() }
})

test('a folder starts recording immediately and only files the note after a successful confirmation', async () => {
  const { app, page } = await launch()
  try {
    const folder = await folderPage(page)
    await expect(page.getByTestId('folder-empty')).toContainText('Start recording here')
    await page.getByTestId('start-recording').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    const id = await meetingId(page)
    const proposal = page.getByTestId('folder-suggestion')
    await expect(proposal).toHaveText('Therapy')
    expect(await foldersOf(page, id)).toEqual([])
    // The recording reminder is a nonmodal toast, not a folder confirmation.
    await expect(page.locator('[role="dialog"]').filter({ hasNot: page.getByText("Let everyone know you're recording.", { exact: true }) })).toHaveCount(0)

    // Navigating away does not silently accept or lose the pending choice.
    await page.getByTestId('nav-home').click()
    await page.evaluate(id => window.yogurt.nav.go(`/note/${id}`), id)
    await expect(proposal).toBeVisible()
    expect(await foldersOf(page, id)).toEqual([])
    await app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as typeof ipcMain & { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers
      const add = handlers.get('folders:add')!
      let failed = false
      ipcMain.removeHandler('folders:add')
      ipcMain.handle('folders:add', (...args) => {
        if (!failed) { failed = true; throw new Error('fixture write failed') }
        return add(...args)
      })
    })
    await page.getByTestId('folder-suggestion-confirm').click()
    await expect(page.getByTestId('folder-suggestion-error')).toBeVisible()
    await expect(proposal).toBeVisible()
    expect(await foldersOf(page, id)).toEqual([])
    await page.getByTestId('folder-suggestion-confirm').click()
    await expect(proposal).toHaveCount(0)
    await expect(page.getByTestId('note-folders-summary')).toHaveText('Therapy')
    expect(await foldersOf(page, id)).toMatchObject([{ id: folder.id }])
    await stop(page)
  } finally { await app.close() }
})

test('cancelling the folder suggestion leaves the recording unfiled; Meetings and Chat suggest no folder', async () => {
  const { app, page } = await launch()
  try {
    await folderPage(page)
    await page.getByTestId('start-recording').click()
    await expect(page.getByTestId('folder-suggestion')).toBeVisible()
    const id = await meetingId(page)
    await page.getByTestId('folder-suggestion-cancel').click()
    await expect(page.getByTestId('note-folders-summary')).toHaveText('Add to folder')
    await expect(page.getByTestId('note-folders')).toBeFocused()
    expect(await foldersOf(page, id)).toEqual([])
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    await stop(page)

    await page.getByTestId('nav-home').click()
    await page.getByTestId('new-note').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    await expect(page.getByTestId('folder-suggestion')).toHaveCount(0)
    await stop(page)

    await page.getByTestId('nav-chat').click()
    await page.getByTestId('start-recording').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    await expect(page.getByTestId('folder-suggestion')).toHaveCount(0)
    expect(await foldersOf(page, await meetingId(page))).toEqual([])
    await stop(page)
    await page.getByTestId('nav-chat').click()
    const chat = await page.evaluate(() => window.yogurt.conversations.ask(null, 'What was discussed?'))
    await page.evaluate(id => window.yogurt.nav.go(`/chat/${id}`), chat)
    await expect(page.getByTestId('chat-page')).toBeVisible()
    await expect(page.getByTestId('start-recording')).toHaveCount(0)
  } finally { await app.close() }
})

test('a failed folder start stays on the folder with no membership or pending suggestion', async () => {
  const { app, page } = await launch()
  try {
    const folder = await folderPage(page)
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('meetings:start')
      ipcMain.handle('meetings:start', () => ({ error: 'failed' }))
    })
    await page.getByTestId('start-recording').click()
    await expect(page.getByTestId('start-recording-message')).toBeVisible()
    await expect(page.getByTestId('start-recording')).toBeEnabled()
    await expect(page.getByTestId('folder-page')).toBeVisible()
    await expect(page.getByTestId('folder-suggestion')).toHaveCount(0)
    expect(await page.evaluate(id => window.yogurt.meetings.cards({ folder: id, limit: 10 }), folder.id)).toEqual([])
  } finally { await app.close() }
})

test('an active recording replaces start actions and a raced start identifies the existing note', async () => {
  const { app, page } = await launch()
  try {
    const folder = await folderPage(page)
    // A second entry point wins the race after this button was shown but before its request reaches main.
    await app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as typeof ipcMain & { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers
      const start = handlers.get('meetings:start')!
      ipcMain.removeHandler('meetings:start')
      ipcMain.handle('meetings:start', async (...args) => { await start(...args); return start(...args) })
    })
    await page.getByTestId('start-recording').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    const id = await meetingId(page)
    const reused = await page.evaluate(() => window.yogurt.meetings.start(null))
    expect(reused).toEqual({ id, alreadyRecording: true })
    await expect(page.getByTestId('folder-suggestion')).toHaveCount(0)
    for (const route of [`/folder/${folder.id}`, '/chat']) {
      await page.evaluate(route => window.yogurt.nav.go(route), route)
      await expect(page.getByTestId('recording-return')).toBeVisible()
      await expect(page.getByTestId('start-recording')).toHaveCount(0)
    }
    expect(await foldersOf(page, id)).toEqual([])
    await page.getByTestId('recording-return').click()
    await stop(page)
  } finally { await app.close() }
})

test('localized recording actions leave room for a long folder title at the smallest window width', async () => {
  const { app, page } = await launch()
  try {
    const folder = await folderPage(page)
    const title = 'Planning the next release and reviewing open questions '.repeat(4).trim()
    await app.evaluate((_e, title) => {
      const now = Date.now()
      ;(globalThis as unknown as { __fake__: { calendarEvents(events: unknown[]): void } }).__fake__.calendarEvents([
        { id: 'long-title', title, start: new Date(now - 60_000).toISOString(), end: new Date(now + 30 * 60_000).toISOString(), attendees: [] },
      ])
    }, title)
    // The fake calendar hook refreshes main's consumers; reload to read it in the renderer.
    await page.reload()
    await expect(page.getByTestId('start-recording')).toHaveAttribute('title', `Take notes · ${title}`)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes('#'))!.setSize(720, 520))
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(720)
    await page.evaluate(id => window.yogurt.folders.rename(id, 'Therapy and personal reflections '.repeat(6)), folder.id)
    await expect(page.getByTestId('folder-title')).toHaveText('Therapy and personal reflections '.repeat(6).trim())
    for (const locale of ['en', 'de', 'ar']) {
      await page.evaluate(locale => window.yogurt.settings.setLanguage(locale), locale)
      await expect(page.locator('html')).toHaveAttribute('lang', locale)
      const action = page.getByTestId('start-recording')
      await expect(action).toBeVisible()
      await expect.poll(async () => {
        const heading = (await page.getByTestId('workspace-heading').boundingBox())!
        const button = (await action.boundingBox())!
        return locale === 'ar' ? heading.x - (button.x + button.width) : button.x - (heading.x + heading.width)
      }).toBeGreaterThanOrEqual(12)
      const split = (await page.locator('.recording-split').boundingBox())!
      expect(split.width).toBeLessThanOrEqual(276)
      expect(await action.locator('.recording-label').evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true)
      await expect(action).toHaveAttribute('title', new RegExp(title.trim()))
      const button = split
      expect(button.x).toBeGreaterThanOrEqual(locale === 'ar' ? 132 : 0)
      expect(button.x + button.width).toBeLessThanOrEqual(await page.evaluate(() => innerWidth))
      await expect(action).toBeEnabled()
    }
  } finally { await app.close() }
})

test('two live meetings open the title-bar menu; arrows, Enter and Escape choose or dismiss it', async () => {
  const { app, page } = await launch()
  try {
    const now = await page.evaluate(() => { const date = new Date(); date.setHours(12, 0, 0, 0); return +date })
    await page.clock.setFixedTime(now)
    await app.evaluate(async (_e, now) => {
      const fake = (globalThis as unknown as { __fake__: { advance(ms: number): Promise<void>; calendarEvents(events: unknown[]): void } }).__fake__
      await fake.advance(now - Date.now())
      fake.calendarEvents([
        { id: 'first', title: 'Planning review', start: new Date(now - 60_000).toISOString(), end: new Date(now + 30 * 60_000).toISOString(), attendees: [{ name: 'Robin Vale', email: null }] },
        { id: 'second', title: 'Project review', start: new Date(now - 30_000).toISOString(), end: new Date(now + 30 * 60_000).toISOString(), attendees: [] },
        { id: 'soon', title: 'Release review', start: new Date(now + 8 * 60_000).toISOString(), end: new Date(now + 38 * 60_000).toISOString(), attendees: [] },
      ])
    }, now)
    await page.reload()
    const action = page.getByTestId('new-note')
    const menu = page.getByRole('menu', { name: 'Start recording', exact: true })
    await expect(action).toHaveText('Take notes · 2 now')
    await expect(page.getByTestId('event-start')).toHaveCount(0)
    await action.click()
    await expect(menu).toBeVisible()
    await expect(page.getByTestId('note-state')).toHaveCount(0)
    await expect(menu.getByTestId('recording-meeting')).toHaveText(['Planning reviewRobin ValeNow', 'Project reviewNow', 'Release reviewin 8 min'])
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(action).toBeFocused()
    await action.press('ArrowDown')
    await expect(menu.getByTestId('recording-meeting').first()).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    await expect(page.getByTestId('note-title')).toHaveText('Project review')
    const id = await meetingId(page)
    expect(await page.evaluate(id => window.yogurt.meetings.get(id).then(m => m?.eventId), id)).toBe('second')
    await page.getByTestId('nav-home').click()
    await expect(page.getByTestId('recording-return')).toBeVisible()
    await expect(page.getByTestId('recording-choices')).toHaveCount(0)
    await page.getByTestId('recording-return').click()
    await stop(page)
    await page.getByTestId('nav-home').click()
    await page.getByTestId('recording-choices').press('ArrowUp')
    await expect(menu.getByTestId('recording-unattached')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    const unattached = await meetingId(page)
    expect(await page.evaluate(id => window.yogurt.meetings.get(id).then(m => m?.eventId), unattached)).toBeNull()
  } finally { await app.close() }
})
