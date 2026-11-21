import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')
const zoom = { bundleId: 'us.zoom.xos', name: 'zoom.us' }

async function launch(env: Record<string, string> = {}) {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData, ...env } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page }
}
const fake = <T>(app: ElectronApplication, fn: string, arg?: unknown): Promise<T> =>
  app.evaluate((_e, [fn, arg]) => (globalThis as unknown as Record<string, Record<string, (a?: unknown) => unknown>>).__fake__[fn as string](arg), [fn, arg] as const) as Promise<T>
const windowOf = async (app: ElectronApplication, hash: string): Promise<Page> => {
  for (let i = 0; i < 100; i++) {
    const w = app.windows().find((p) => p.url().includes(hash))
    if (w) return w
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`no ${hash} window`)
}

test('recording on a small Mac leaves Ask readable and explains when typing resumes', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_PLATFORM: 'darwin', YOGURT_FAKE_SMALL_MAC: '1' })
  try {
    await page.getByTestId('new-note').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    const id = await page.evaluate(async () => (await window.yogurt.nav.current()).slice('/note/'.length))
    await page.keyboard.press('Meta+j')
    const noteInput = page.getByTestId('chat-input')
    await expect(noteInput).toBeFocused()
    await expect(noteInput).toHaveAccessibleDescription('Available after recording')
    await expect(noteInput).not.toBeEditable()
    await expect(page.getByRole('tooltip')).toHaveText('Available after recording')
    await page.getByTestId('chat-close').focus()
    await noteInput.hover()
    await expect(page.getByRole('tooltip')).toBeVisible()
    await page.getByTestId('chat-close').click()
    await page.getByTestId('nav-chat').click()
    const homeInput = page.getByTestId('chat-page-input')
    await expect(homeInput).toHaveAttribute('aria-disabled', 'true')
    await page.keyboard.press('Meta+k')
    await page.getByTestId('search-input').fill('What did we decide?')
    await page.keyboard.press('Meta+Enter')
    await expect(homeInput).toHaveValue('What did we decide?')
    await expect(homeInput).not.toBeEditable()
    await homeInput.press('Enter')
    await expect(page.getByTestId('chat-page-turn')).toHaveCount(0)
    await page.evaluate(id => window.yogurt.meetings.stop(id), id)
    await expect(homeInput).toBeEditable()
    await expect(homeInput).toHaveValue('What did we decide?')
    await expect(page.getByTestId('chat-page-send')).toBeEnabled()
    await expect(page.getByTestId('chat-page-turn')).toHaveCount(0)
  } finally { await app.close() }
})

test('the meeting keeps its reading width until the first send opens a conversation above the same field', async () => {
  const { app, page } = await launch()
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 800))
    const id = await fake<string>(app, 'bigMeeting', 10)
    await fake(app, 'go', `/note/${id}`)
    const input = page.getByTestId('chat-input'), panel = page.getByTestId('chat-panel')
    await expect(input).toHaveAttribute('placeholder', 'Ask about this meeting')
    await expect(input).not.toBeFocused()
    const original = await input.elementHandle()
    const width = (await page.locator('.note-reading-area').boundingBox())!.width
    await page.keyboard.press('Meta+j')
    await expect(input).toBeFocused()
    await input.fill('What did we decide?')
    expect((await page.locator('.note-reading-area').boundingBox())!.width).toBe(width)
    await input.press('Enter')
    await expect(panel.getByTestId('chat-turn')).toBeVisible()
    expect(await original!.evaluate(el => el === document.activeElement)).toBe(true)
    const box = (await panel.boundingBox())!, note = (await page.locator('.note-reading-area').boundingBox())!
    expect(note.x + note.width).toBeLessThanOrEqual(box.x + 1)
    expect(box.y).toBeCloseTo(52, 0)
    expect(box.y + box.height).toBeCloseTo(await page.evaluate(() => innerHeight), 0)
    await input.fill('A follow-up for later')
    await input.press('Escape')
    await expect(panel).toHaveCount(0)
    await expect(input).toHaveValue('A follow-up for later')
    expect((await page.locator('.note-reading-area').boundingBox())!.width).toBe(width)
  } finally { await app.close() }
})

test('the width left by the sidebar determines whether the same conversation is modal', async () => {
  const { app, page } = await launch()
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 760))
    const id = await fake<string>(app, 'bigMeeting', 10)
    await fake(app, 'go', `/note/${id}`)
    const panel = page.getByTestId('chat-panel'), input = page.getByTestId('chat-input')
    if (await page.getByTestId('sidebar-expand').count()) await page.getByTestId('sidebar-expand').click()
    await page.getByTestId('chat-open').click()
    await expect(panel).toHaveAttribute('aria-modal', 'true')
    await input.fill('Keep this draft')
    await input.press('Tab')
    expect(await panel.evaluate(el => el.matches(':modal') && el.contains(document.activeElement))).toBe(true)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('chat-open')).toBeFocused()
    await page.getByTestId('sidebar-collapse').click()
    await page.getByTestId('chat-open').click()
    await expect(panel).not.toHaveAttribute('aria-modal', 'true')
    await expect(input).toHaveValue('Keep this draft')
    await page.getByTestId('note-title').click()
    await page.keyboard.press('Meta+j')
    await expect(input).toBeFocused()
  } finally { await app.close() }
})

test('asking about a finished meeting streams the answer in, word by word, and it is still there after a reload', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_LLM_MS: '80' })
  try {
    const id = await fake<string>(app, 'bigMeeting', 30)
    await fake(app, 'go', `/note/${id}`)
    await page.getByTestId('chat-open').click()
    const input = page.getByTestId('chat-input')
    await expect(input).toHaveAttribute('placeholder', 'Ask about this meeting')
    // Keep the action slot reserved even before there is a question to send.
    await expect(page.getByTestId('chat-send')).toBeDisabled()
    await expect(page.getByTestId('chat-follow-up')).toHaveCount(0)
    await input.click()
    // a few common questions to start from
    await expect(page.locator('[data-testid=chat-suggestion]:visible')).toHaveCount(3)
    await input.fill('When does the site go live?')
    await input.press('Enter')
    await expect(input).toHaveValue('')
    const turn = page.getByTestId('chat-turn')
    await expect(page.getByTestId('chat-question')).toHaveText('When does the site go live?')
    await expect(turn).toHaveAttribute('data-status', 'answering', { timeout: 10_000 })
    // the stop button while it writes; new words fade in
    await expect(page.getByTestId('chat-stop')).toBeVisible()
    await expect(page.getByTestId('chat-stop')).toHaveAccessibleName('Stop')
    // a quiet grey stop with an ink square, so typing ahead never looks ready to send
    await expect(page.getByTestId('chat-stop')).toHaveCSS('color', 'rgb(41, 41, 44)')
    await expect(page.getByTestId('chat-answer').locator('.fw').first()).toBeVisible()
    await expect(turn).toHaveAttribute('data-status', 'done', { timeout: 15_000 })
    const answer = page.getByTestId('chat-answer')
    await expect(answer).toContainText('The launch plan, in short:')
    await expect(answer.locator('li')).toHaveCount(2)
    await expect(answer.locator('strong')).toHaveText('Tuesday')
    await expect(page.getByTestId('chat-stop')).toHaveCount(0)
    await page.getByTestId('chat-close').click()
    await expect(page.getByTestId('chat-open')).toBeFocused()
    await expect(page.getByTestId('chat-panel')).toHaveCount(0)
    await page.getByTestId('chat-open').click()
    await expect(page.getByTestId('chat-panel')).toBeVisible()
    await input.press('Escape')
    await expect(page.getByTestId('chat-open')).toBeFocused()
    await expect(page.getByTestId('chat-panel')).toHaveCount(0)
    await page.getByTestId('chat-open').click()
    // Transcript and chat stay available together; the completed answer is announced once.
    await page.getByTestId('note-transcript-toggle').click()
    await expect(page.getByTestId('transcript-panel')).toBeVisible()
    await expect(page.getByTestId('chat-panel')).toBeVisible()
    await page.getByTestId('note-notes-tab').click()
    await expect(page.getByTestId('chat-announce')).toContainText('The launch plan, in short:')
    await page.getByTestId('note-title').click()
    await expect(page.getByTestId('chat-panel')).toBeVisible()

    await page.reload()
    await expect(page.getByTestId('chat-panel')).toBeVisible()
    await expect(page.getByTestId('chat-turn')).toHaveAttribute('data-status', 'done')
    await expect(page.getByTestId('chat-answer')).toContainText('The site goes live on Tuesday.')

    await page.getByTestId('chat-menu').click()
    await page.getByTestId('chat-new').click()
    await expect(page.getByTestId('chat-turn')).toHaveCount(0)
    await expect(page.locator('[data-testid=chat-suggestion]:visible')).toHaveCount(3)
    await expect(page.getByTestId('chat-input')).toBeFocused()
    expect((await page.evaluate((id) => window.yogurt.chat.get(id), id)).turns).toEqual([])
  } finally { await app.close() }
})

test('opening Ask on a meeting reads it in ahead, and a question says what it is doing until the answer starts', async () => {
  // a first word well after the 4s step tick, so a slow machine still sees each step
  const { app, page } = await launch({ YOGURT_FAKE_LLM_MS: '8000' })
  try {
    const id = await fake<string>(app, 'bigMeeting', 12)
    await fake(app, 'go', `/note/${id}`)
    const title = (await page.getByTestId('note-title').textContent())!.trim()
    await page.getByTestId('chat-open').click()
    const input = page.getByTestId('chat-input')
    await expect(input).toBeFocused()
    // the meeting's transcript and notes are read into the model before anything is asked, once for repeated opens
    await expect.poll(async () => (await fake<{ preloads: string[] }>(app, 'prompts')).preloads.length).toBeGreaterThan(0)
    const read = (await fake<{ preloads: string[] }>(app, 'prompts')).preloads.at(-1)!
    expect(read).toContain(`Meeting: ${title}`)
    await input.blur(); await input.focus()
    await input.fill('When does the site go live?')
    await input.press('Enter')
    const step = page.getByTestId('chat-step')
    await expect(step).toHaveText(`Reading ${title}…`)
    await expect(step).toHaveText(`Still reading ${title}…`, { timeout: 6000 })
    expect((await fake<{ notes: string[] }>(app, 'prompts')).notes.find((p) => p.includes('When does the site go live?'))!.startsWith(read)).toBe(true)
    expect((await fake<{ preloads: string[] }>(app, 'prompts')).preloads.filter((p) => p === read)).toHaveLength(1)
    await page.getByTestId('chat-stop').click()
    await expect(page.getByTestId('chat-turn')).toHaveAttribute('data-status', 'stopped')
    await expect(step).toHaveCount(0)
  } finally { await app.close() }
})

test('during a recording it answers from the transcript so far, and a stop keeps what was written', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_LLM_MS: '250' })
  try {
    await fake(app, 'signals', { micApps: [], events: [] })
    await fake(app, 'signals', { micApps: [zoom], events: [] })
    await (await windowOf(app, '#prompt')).getByTestId('prompt-take-notes').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    await page.getByTestId('note-transcript-toggle').click()
    await expect(page.getByTestId('transcript-line').first()).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('chat-open').click()
    // questions that fit a meeting still going on
    await page.getByTestId('chat-suggestion').filter({ hasText: 'What did I just miss?' }).click()
    await expect(page.getByTestId('chat-question')).toHaveText('What did I just miss?')
    await expect(page.getByTestId('chat-answer')).toContainText('So far,', { timeout: 10_000 })
    await page.getByTestId('chat-stop').click()
    await expect(page.getByTestId('chat-turn')).toHaveAttribute('data-status', 'stopped')
    await expect(page.getByTestId('chat-stop')).toHaveCount(0)
    await page.waitForTimeout(600)
    await expect(page.getByTestId('chat-answer')).not.toContainText('Wednesday')
    // stopped stays stopped
    await page.reload()
    await expect(page.getByTestId('chat-panel')).toBeVisible()
    await expect(page.getByTestId('chat-turn')).toHaveAttribute('data-status', 'stopped')
  } finally { await app.close() }
})

test('the suggestions can be reached and picked with the keyboard', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_LLM_MS: '20' })
  try {
    const id = await fake<string>(app, 'bigMeeting', 10)
    await fake(app, 'go', `/note/${id}`)
    await page.getByTestId('chat-open').click()
    await expect(page.locator('[data-testid=chat-suggestion]:visible')).toHaveCount(3)
    await expect(page.getByTestId('chat-input')).toBeFocused()
    // Suggestions sit above the composer; the scope pill comes after the text.
    await page.keyboard.press('Shift+Tab') // third suggestion
    await page.keyboard.press('Shift+Tab') // second suggestion
    await page.keyboard.press('Shift+Tab') // first suggestion
    await expect(page.getByTestId('chat-suggestion').first()).toBeFocused()
    await expect(page.locator('[data-testid=chat-suggestion]:visible')).toHaveCount(3)
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('chat-question')).toHaveText('What was decided?')
    await expect(page.getByTestId('chat-turn')).toHaveAttribute('data-status', 'done', { timeout: 15_000 })
    // links an answer has are shown as plain text, never followed
    await expect(page.getByTestId('chat-answer')).toContainText('the launch page')
    await expect(page.getByTestId('chat-answer').locator('a')).toHaveCount(0)
  } finally { await app.close() }
})

test('the composer has no follow-up shortcut and keeps its input and send action in place while asking and stopping', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_LLM_MS: '250' })
  try {
    const id = await fake<string>(app, 'bigMeeting', 10)
    await fake(app, 'go', `/note/${id}`)
    const input = page.getByTestId('chat-input')
    const action = page.locator('[data-testid="chat-send"], [data-testid="chat-stop"]')
    await page.getByTestId('chat-open').click()
    await expect(input).toBeVisible()
    await expect(page.getByTestId('chat-follow-up')).toHaveCount(0)
    const initialInput = (await input.boundingBox())!, initialAction = (await action.boundingBox())!
    // The send action lives inside the roomy composer, below its text area.
    expect(initialAction.y).toBeGreaterThanOrEqual(initialInput.y + initialInput.height)
    const stable = async () => {
      const nextInput = (await input.boundingBox())!
      expect(nextInput.width).toBeCloseTo(initialInput.width, 1)
      const nextAction = (await action.boundingBox())!
      expect(nextAction.x).toBeCloseTo(initialAction.x, 1)
      expect(nextAction.width).toBeCloseTo(initialAction.width, 1)
    }
    await input.fill('When does the site go live?')
    await stable()
    await input.press('Enter')
    await expect(page.getByTestId('chat-turn')).toHaveAttribute('data-status', 'answering')
    await stable()
    await page.getByTestId('chat-stop').click()
    await expect(page.getByTestId('chat-turn')).toHaveAttribute('data-status', 'stopped')
    await expect(page.getByTestId('chat-send')).toBeDisabled()
    await stable()
  } finally { await app.close() }
})

test('an unacknowledged question cannot be sent twice, and a rejected request keeps it ready to retry', async () => {
  const { app, page } = await launch()
  try {
    const id = await fake<string>(app, 'bigMeeting', 10)
    await fake(app, 'go', `/note/${id}`)
    await app.evaluate(({ ipcMain }) => {
      const state = { calls: 0, reject: () => {} }
      ;(globalThis as unknown as { __chatRequestTest: typeof state }).__chatRequestTest = state
      ipcMain.removeHandler('conversations:ask')
      ipcMain.handle('conversations:ask', () => {
        state.calls++
        return new Promise((_resolve, reject) => { state.reject = () => reject(new Error('request failed')) })
      })
    })
    const input = page.getByTestId('chat-input'), send = page.getByTestId('chat-send')
    await page.getByTestId('chat-open').click()
    await input.fill('Who owns the release notes?')
    await input.press('Enter')
    await expect(input).toHaveValue('Who owns the release notes?')
    await expect(input).not.toBeEditable()
    await expect(input).toBeFocused()
    await expect(send).toBeDisabled()
    await input.press('Enter')
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __chatRequestTest: { calls: number } }).__chatRequestTest.calls)).toBe(1)
    await app.evaluate(() => (globalThis as unknown as { __chatRequestTest: { reject(): void } }).__chatRequestTest.reject())
    await expect(page.getByTestId('chat-send-error')).toHaveText("Couldn't save your changes")
    await expect(input).toHaveValue('Who owns the release notes?')
    await expect(send).toBeEnabled()
    await input.press('Escape')
    await expect(page.getByTestId('chat-send-error')).toHaveCount(0)
    await expect(page.getByTestId('chat-open')).toBeFocused()
    await page.getByTestId('chat-open').click()
    await expect(input).toHaveValue('Who owns the release notes?')
    await page.getByTestId('note-transcript-toggle').click()
    await expect(page.getByTestId('transcript-panel')).toBeVisible()
    await expect(input).toHaveValue('Who owns the release notes?')
    await input.click()
    await expect(page.getByTestId('transcript-panel')).toBeVisible()
    await expect(input).toHaveValue('Who owns the release notes?')
    const current = await page.evaluate(async id => window.yogurt.conversations.get(await window.yogurt.conversations.current([{ kind: 'meeting', id }])), id)
    await app.evaluate(({ ipcMain, BrowserWindow }, current) => {
      ipcMain.removeHandler('conversations:ask')
      ipcMain.handle('conversations:ask', (_event, id: string, question: string) => {
        const view = { ...current, id, draft: '', turns: [{ id: 1, question, answer: 'Bo owns the release notes.', status: 'done', sources: [] }], waitsForMeeting: false, waitsForModel: false }
        for (const window of BrowserWindow.getAllWindows()) window.webContents.send('conversations:changed', view)
        return id
      })
    }, current)
    await send.click()
    await expect(page.getByTestId('chat-send-error')).toHaveCount(0)
    await expect(page.getByTestId('chat-answer')).toHaveText('Bo owns the release notes.')
    await expect(send).toBeDisabled()
    await expect(page.getByTestId('chat-follow-up')).toHaveCount(0)
  } finally { await app.close() }
})


for (const reducedMotion of ['reduce', 'no-preference'] as const) test(`the same composer survives opening and closing with ${reducedMotion} motion`, async () => {
  const { app, page } = await launch()
  try {
    await page.emulateMedia({ reducedMotion })
    const id = await fake<string>(app, 'bigMeeting', 10)
    await fake(app, 'go', `/note/${id}`)
    const input = page.getByTestId('chat-input'), toggle = page.getByTestId('chat-open')
    await input.fill('Keep this thought')
    const editor = await input.elementHandle()
    await toggle.click()
    await expect(page.getByTestId('chat-panel')).toBeVisible()
    await page.getByTestId('chat-close').click()
    await expect(page.getByTestId('chat-dock')).toBeVisible()
    expect(await editor!.evaluate(el => el === document.getElementById('meeting-question'))).toBe(true)
    await expect(input).toHaveValue('Keep this thought')
  } finally { await app.close() }
})

for (const width of [1100, 720]) test(`Command-J focuses contextual Ask at ${width}px and still opens Chat elsewhere`, async () => {
  const { app, page } = await launch()
  try {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 760), width)
    const id = await fake<string>(app, 'bigMeeting', 10)
    await fake(app, 'go', `/note/${id}`)
    const trigger = page.getByTestId('chat-open'), panel = page.getByTestId('chat-panel'), input = page.getByTestId('chat-input')
    await expect(trigger).toBeVisible()
    await page.keyboard.press('Meta+j')
    await expect(input).toBeFocused()
    await input.fill('Keep my draft')
    await page.keyboard.press('Meta+j')
    await expect(input).toBeFocused()
    await expect(panel).toHaveCount(0)
    await trigger.click()
    await expect(panel).toBeVisible()
    await page.getByTestId('chat-menu').focus()
    await page.keyboard.press('Meta+j')
    await expect(input).toBeFocused()
    await expect(input).toHaveValue('Keep my draft')
    await input.press('Escape')
    await fake(app, 'go', '')
    await expect(page.getByTestId('home')).toBeVisible()
    await page.keyboard.press('Meta+j')
    await expect(page.getByTestId('chat-page-input')).toBeEditable()
    await expect.poll(() => page.evaluate(() => window.yogurt.nav.current())).toMatch(/^\/chat\/.+/)

    await page.getByTestId('nav-chat').click()
    await expect(page.getByTestId('chat-empty')).toBeVisible()
    const field = page.locator('textarea#library-question')
    await field.fill('Keep this draft')
    await field.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(5, 9))
    for (const invoke of [() => page.keyboard.press('Meta+j'), () => fake(app, 'trayClick', 'ask')]) {
      await page.getByTestId('chat-recent').focus()
      await invoke()
      await expect(field).toBeFocused()
      await page.keyboard.press('Meta+j')
      await expect(field).toHaveValue('Keep this draft')
      expect(await field.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([5, 9])
      expect(await page.evaluate(() => window.yogurt.nav.current())).toBe('/chat')
    }
  } finally { await app.close() }
})
