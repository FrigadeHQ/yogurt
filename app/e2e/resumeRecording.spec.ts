import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')
async function launch(profile: string, env: Record<string, string> = {}) {
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: profile, YOGURT_FAKE_LLM_MS: '1', ...env } })
  app.context().setDefaultTimeout(5000)
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page }
}

test('Stop summary preserves a saved rewrite and the header label stays still on hover and focus', async () => {
  const { app, page } = await launch(mkdtempSync(join(tmpdir(), 'yogurt-summary-stop-')), { YOGURT_FAKE_LLM_MS: '120' })
  try {
    const id = await app.evaluate(async () => (await (globalThis as unknown as { __fake__: { chatMeetings(): Promise<string[]> } }).__fake__.chatMeetings())[0])
    await page.evaluate(id => window.yogurt.nav.go(`/note/${id}`), id)
    await page.getByTestId('note-summary-tab').click()
    const before = await page.evaluate(id => window.yogurt.notes.get(id), id)
    await page.evaluate(id => window.yogurt.notes.writeAgain(id), id)
    const button = page.getByTestId('note-resume')
    await expect(button).toHaveText('Summarizing…')
    // the button eases to its label's width first; measure once the label's box has reached the words' own width
    await expect.poll(() => button.locator('.swap-text').evaluate(el => Math.abs(el.getBoundingClientRect().width - el.firstElementChild!.getBoundingClientRect().width) < 0.5)).toBe(true)
    const width = (await button.boundingBox())!.width
    await button.hover()
    await expect(button).toHaveAccessibleName('Stop summary')
    await expect(button).toHaveText('Summarizing…')
    // the same width, give or take how a display rounds the words (#93: 0.4 px apart on an M5's built-in screen)
    expect(Math.abs((await button.boundingBox())!.width - width)).toBeLessThan(1)
    await button.focus()
    await expect(page.locator('.summary-stop-square')).toHaveCSS('opacity', '1')
    await button.press('Enter')
    await expect.poll(async () => (await page.evaluate(id => window.yogurt.notes.get(id), id)).status).toBe('stopped')
    const after = await page.evaluate(id => window.yogurt.notes.get(id), id)
    expect(after.enhanced).toBe(before.enhanced)
    expect(after.edited).toBe(before.edited)
    expect(after.mine).toBe(before.mine)
    expect(after.draft).toBe('')
    await expect(page.locator('.summary-stopped')).toHaveCount(0)
    await expect(page.getByTestId('note-enhanced-editor')).toBeVisible()
  } finally { await app.close() }
})

test('a finished note resumes after reopening, preserves original data, confirms edited Summary, and appends audio', async () => {
  test.setTimeout(90_000)
  const profile = mkdtempSync(join(tmpdir(), 'yogurt-resume-'))
  let { app, page } = await launch(profile)
  try {
    await page.locator('#workspace-actions').getByRole('button', { name: 'Start recording', exact: true }).click()
    const id = (await page.evaluate(() => window.yogurt.nav.current())).slice('/note/'.length)
    await page.evaluate((id) => window.yogurt.meetings.rename(id, 'Resume safety fixture'), id)
    await page.getByTestId('note-notes-tab').click()
    await page.getByRole('textbox', { name: 'My notes', exact: true }).fill('Keep this original decision.')
    await expect.poll(async () => (await page.evaluate((id) => window.yogurt.transcript.get(id), id)).length, { timeout: 20_000 }).toBeGreaterThan(0)
    await page.getByTestId('note-stop').click()
    await expect.poll(async () => (await page.evaluate((id) => window.yogurt.notes.get(id), id)).status).toBe('done')
    const prior = await page.evaluate(async (id) => ({ meeting: await window.yogurt.meetings.get(id), notes: await window.yogurt.notes.get(id), transcript: await window.yogurt.transcript.get(id) }), id)
    const dir = join(profile, 'meetings', id), originalAudio = readFileSync(join(dir, 'me.wav'))
    await app.close()
    ;({ app, page } = await launch(profile))
    await page.getByTestId('past-note').click()
    await page.getByRole('textbox', { name: 'Summary', exact: true }).fill('My edited summary is kept until I confirm.')
    await page.getByTestId('note-resume').click()
    await expect(page.getByTestId('resume-cancel')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('resume-confirm')).toHaveCount(0)
    await expect(page.getByTestId('note-resume')).toBeFocused()
    await expect(page.getByRole('textbox', { name: 'Summary', exact: true })).toHaveText('My edited summary is kept until I confirm.')
    expect(readFileSync(join(dir, 'me.wav'))).toEqual(originalAudio)

    // A bad retained part refuses Resume without changing the saved note or its previous audio.
    writeFileSync(join(dir, 'part.1.json'), JSON.stringify({ startMs: 5000 }))
    writeFileSync(join(dir, 'me.1.wav'), 'unreadable fixture')
    await page.getByTestId('note-resume').click(); await page.getByTestId('resume-yes').click()
    await expect(page.getByTestId('note-resume-failed')).toBeVisible()
    expect((await page.evaluate((id) => window.yogurt.meetings.get(id), id))?.state).toBe('done')
    expect(readFileSync(join(dir, 'me.wav'))).toEqual(originalAudio)
    unlinkSync(join(dir, 'part.1.json')); unlinkSync(join(dir, 'me.1.wav'))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('#'))!.setSize(720, 520))
    await page.getByTestId('note-resume').click(); await page.getByTestId('resume-yes').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    expect(await page.evaluate((id) => window.yogurt.meetings.get(id), id)).toMatchObject({ id, startedAt: prior.meeting!.startedAt, title: prior.meeting!.title })
    expect((await page.evaluate((id) => window.yogurt.notes.get(id), id)).mine).toBe(prior.notes.mine)
    expect(await page.evaluate((id) => window.yogurt.transcript.get(id), id)).toEqual(prior.transcript)
    expect(readFileSync(join(dir, 'me.wav'))).toEqual(originalAudio)
    await page.getByTestId('note-notes-tab').click()
    await page.getByRole('textbox', { name: 'My notes', exact: true }).fill('Keep this original decision.\nAdd this resumed decision.')
    await page.waitForTimeout(1500)
    await page.getByTestId('note-pause').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-paused', 'true')
    await page.getByTestId('note-pause').click()
    await page.getByTestId('note-stop').click()
    await expect.poll(async () => (await page.evaluate((id) => window.yogurt.notes.get(id), id)).status, { timeout: 20_000 }).toBe('done')
    const next = await page.evaluate(async (id) => ({ meeting: await window.yogurt.meetings.get(id), notes: await window.yogurt.notes.get(id), transcript: await window.yogurt.transcript.get(id) }), id)
    expect(next.meeting).toMatchObject({ id, startedAt: prior.meeting!.startedAt, title: prior.meeting!.title })
    expect(next.meeting!.durationMs).toBeGreaterThan(0)
    expect(next.notes.mine).toContain('Add this resumed decision.')
    expect(next.transcript.length).toBeGreaterThan(prior.transcript.length)
    for (const line of prior.transcript) expect(next.transcript.find((v) => v.id === line.id)).toEqual(line)
    const combined = readFileSync(join(dir, 'me.wav'))
    expect(combined.length).toBeGreaterThan(originalAudio.length)
    expect(combined.subarray(44, originalAudio.length)).toEqual(originalAudio.subarray(44))
    expect(await page.evaluate(() => window.yogurt.meetings.cards({ limit: 10 }))).toHaveLength(1)
  } finally { await app.close() }
})

test('Stop offers Stop summary and Generate summary before recording resumes', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'yogurt-resume-writing-'))
  const { app, page } = await launch(profile, { YOGURT_FAKE_LLM_MS: '120' })
  try {
    await page.locator('#workspace-actions').getByRole('button', { name: 'Start recording', exact: true }).click()
    const id = (await page.evaluate(() => window.yogurt.nav.current())).slice('/note/'.length)
    await page.getByTestId('note-notes-tab').click()
    await page.getByRole('textbox', { name: 'My notes', exact: true }).fill('First session manual note.')
    await page.waitForTimeout(800)
    await page.getByTestId('note-stop').click()
    await expect.poll(async () => (await page.evaluate((id) => window.yogurt.notes.get(id), id)).status).toBe('writing')
    await expect(page.getByTestId('note-resume')).toBeEnabled()
    await expect(page.getByTestId('note-resume')).toHaveAccessibleName('Stop summary')
    await expect(page.getByTestId('note-resume')).toHaveText('Summarizing…')
    await page.getByTestId('nav-chat').click()
    await page.evaluate((id) => window.yogurt.nav.go(`/note/${id}`), id)
    await expect(page.getByTestId('note-resume')).toBeEnabled()
    await page.getByTestId('note-resume').hover()
    await expect(page.getByTestId('note-resume')).toHaveText('Summarizing…')
    await expect(page.locator('.summary-stop-square')).toHaveCSS('opacity', '1')
    await page.getByTestId('note-resume').click()
    await page.getByTestId('note-summary-tab').click()
    await expect(page.getByText('Summary stopped.', { exact: true })).toBeVisible()
    expect((await page.evaluate(id => window.yogurt.notes.get(id), id)).enhanced).toBeNull()
    await page.locator('.summary-generate').click()
    await expect(page.getByTestId('note-resume')).toHaveAccessibleName('Stop summary')
    await expect(page.getByTestId('note-resume')).toHaveText('Resume recording', { timeout: 30_000 })
    await page.getByTestId('note-resume').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    await expect(page.getByTestId('note-notes-tab')).toHaveAttribute('aria-selected', 'true')
    await page.getByRole('textbox', { name: 'My notes', exact: true }).fill('Second session decision, with the first session retained.')
    await app.evaluate(() => { process.env.YOGURT_FAKE_LLM_MS = '1' })
    await page.waitForTimeout(800)
    await page.getByTestId('note-stop').click()
    await expect.poll(async () => (await page.evaluate((id) => window.yogurt.notes.get(id), id)).status, { timeout: 20_000 }).toBe('done')
    expect((await page.evaluate((id) => window.yogurt.notes.get(id), id)).enhanced).toContain('Second session decision')
    expect(await page.evaluate(() => window.yogurt.meetings.cards({ limit: 10 }))).toHaveLength(1)
  } finally { await app.close() }
})


test('queued summaries offer Stop and completed, unsuccessful or empty summaries offer Resume', async () => {
  const { app, page } = await launch(mkdtempSync(join(tmpdir(), 'yogurt-summary-states-')))
  try {
    const id = await app.evaluate(() => (globalThis as unknown as { __fake__: { bigMeeting(n: number): string } }).__fake__.bigMeeting(10))
    await page.evaluate((id) => window.yogurt.nav.go(`/note/${id}`), id)
    const notes = await page.evaluate((id) => window.yogurt.notes.get(id), id)
    for (const status of ['waiting', 'failed', 'writing', 'empty', 'stopped', 'done'] as const) {
      await app.evaluate(({ BrowserWindow }, view) => {
        BrowserWindow.getAllWindows().find((win) => !win.webContents.getURL().includes('#'))!.webContents.send('notes:changed', view)
      }, { ...notes, status })
      const busy = status === 'waiting' || status === 'writing'
      await expect(page.getByTestId('note-resume')).toBeEnabled()
      await expect(page.getByTestId('note-resume')).toHaveAccessibleName(busy ? 'Stop summary' : 'Resume recording')
      await expect(page.getByTestId('note-resume')).toHaveAttribute('aria-busy', String(busy))
      await expect(page.getByTestId('note-state')).not.toHaveAttribute('data-state', 'recording')
    }
  } finally { await app.close() }
})
