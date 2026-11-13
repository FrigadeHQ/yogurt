import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')
async function launch(env: Record<string, string> = {}) {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-audio-delete-'))
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData, ...env } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page, userData }
}
const fake = <T>(app: ElectronApplication, fn: string, arg?: unknown): Promise<T> =>
  app.evaluate((_e, [fn, arg]) => (globalThis as unknown as Record<string, Record<string, (a?: unknown) => unknown>>).__fake__[fn as string](arg), [fn, arg] as const) as Promise<T>

test('deleting audio asks first, preserves the note and search, and survives Trash restore and reopening', async () => {
  const { app, page, userData } = await launch()
  try {
    const id = await fake<string>(app, 'bigMeeting', 8)
    await page.evaluate(async id => { await window.yogurt.notes.setMine(id, 'Keep the launch decision.', 1); await window.yogurt.notes.setEnhanced(id, '## Launch\n- Keep the summary.', 1) }, id)
    await fake(app, 'go', `/note/${id}`)
    await page.getByRole('tab', { name: 'Transcript', exact: true }).click()
    const before = await page.evaluate(async id => ({ meeting: await window.yogurt.meetings.get(id), notes: await window.yogurt.notes.get(id), lines: await window.yogurt.transcript.get(id) }), id)
    await page.getByTestId('recording-menu').click()
    await page.getByTestId('recording-delete').click()
    await expect(page.getByTestId('recording-delete-cancel')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('recording-delete-confirm')).toHaveCount(0)
    expect(existsSync(join(userData, 'meetings', id, 'me.wav'))).toBe(true)
    await page.getByTestId('recording-menu').click()
    await page.getByTestId('recording-delete').click()
    await page.getByTestId('recording-delete-yes').click()
    await expect(page.getByTestId('player')).toHaveCount(0)
    await expect(page.getByTestId('recording-delete-confirm')).toHaveCount(0)
    expect(existsSync(join(userData, 'meetings', id, 'me.wav'))).toBe(false)
    expect(await page.evaluate(id => window.yogurt.audio.tracks(id), id)).toEqual([])
    const toast = page.getByTestId('recording-deleted-toast')
    await expect(toast).toContainText('Recording deleted')
    await expect(page.getByTestId('recording-settings')).toHaveText('Settings')
    expect(await toast.evaluate(el => ['.app-toast-title', '.app-toast-action'].every(selector => {
      const text = el.querySelector(selector)!, range = document.createRange(); range.selectNodeContents(text)
      return new Set(Array.from(range.getClientRects()).map(r => r.top)).size === 1 && text.scrollWidth <= text.clientWidth
    }))).toBe(true)
    await page.getByTestId('recording-settings').click()
    await expect(page.getByTestId('settings')).toBeVisible()
    await expect(page.getByTestId('keep-recordings-toggle')).toBeFocused()
    await expect(page.getByTestId('keep-recordings-toggle')).toHaveAttribute('aria-checked', 'true')
    expect((await page.evaluate(() => window.yogurt.settings.get())).keepRecordings).toBe(true)
    expect(await page.getByTestId('recording-setting').evaluate(el => {
      const row = el.getBoundingClientRect(), viewport = el.closest('.settings-scroll')!.getBoundingClientRect()
      return row.top >= viewport.top && row.bottom <= viewport.bottom
    })).toBe(true)
    expect(await page.getByTestId('recording-setting').locator('.settings-description').evaluate(el => el.getBoundingClientRect().height)).toBeLessThanOrEqual(18)
    const after = await page.evaluate(async id => ({ meeting: await window.yogurt.meetings.get(id), notes: await window.yogurt.notes.get(id), lines: await window.yogurt.transcript.get(id) }), id)
    expect(after).toEqual(before)
    await page.evaluate(async id => { await window.yogurt.meetings.trash(id); await window.yogurt.meetings.restore(id) }, id)
    await fake(app, 'go', '/')
    await fake(app, 'go', `/note/${id}`)
    await page.getByRole('tab', { name: 'Transcript', exact: true }).click()
    await expect(page.getByTestId('transcript-line')).toHaveCount(8)
    await expect(page.getByTestId('player')).toHaveCount(0)
    await page.getByTestId('chat-open').click()
    await page.getByTestId('chat-input').fill('What was discussed?')
    await page.getByTestId('chat-input').press('Enter')
    await expect.poll(async () => (await page.evaluate(id => window.yogurt.chat.get(id), id))?.turns.at(-1)?.answer, { timeout: 30_000 }).toBeTruthy()
    expect((await page.evaluate(() => window.yogurt.search.query('launch'))).some(hit => hit.meetingId === id)).toBe(true)
  } finally { await app.close() }
})

test('turning retention off deletes only after saved transcript and summary and updates the open player', async () => {
  const { app, page, userData } = await launch({ YOGURT_FAKE_NOTES_MODEL_MS: '16000' })
  try {
    await page.getByTestId('settings-open').click()
    const toggle = page.getByTestId('keep-recordings-toggle')
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await toggle.click(); await expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')).keepRecordings).toBe(false)
    await page.getByTestId('nav-home').click()
    await page.getByRole('button', { name: 'Start recording', exact: true }).click()
    const id = (await page.evaluate(() => window.yogurt.nav.current())).slice('/note/'.length)
    await expect.poll(async () => (await page.evaluate(id => window.yogurt.transcript.get(id), id)).length, { timeout: 30_000 }).toBeGreaterThan(0)
    await page.getByTestId('note-stop').click()
    await page.getByRole('tab', { name: 'Transcript', exact: true }).click()
    await expect(page.getByTestId('player')).toBeVisible()
    expect(existsSync(join(userData, 'meetings', id, 'me.wav'))).toBe(true)
    await expect.poll(async () => (await page.evaluate(id => window.yogurt.notes.get(id), id)).status, { timeout: 40_000 }).toBe('done')
    await expect(page.getByTestId('player')).toHaveCount(0)
    expect(existsSync(join(userData, 'meetings', id, 'me.wav'))).toBe(false)
    expect((await page.evaluate(id => window.yogurt.transcript.get(id), id)).length).toBeGreaterThan(0)
  } finally { await app.close() }
})

test('@everywhere a backup with deleted audio restores text without recreating recordings', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'yogurt-audio-backup-')), 'backup.zip')
  const a = await launch({ YOGURT_BACKUP_PATH: file })
  let id: string
  try {
    id = await fake<string>(a.app, 'bigMeeting', 4)
    expect(await a.page.evaluate(id => window.yogurt.audio.delete(id), id)).toBe('deleted')
    await a.page.getByTestId('settings-open').click(); await a.page.getByTestId('backup-export').click()
    await expect(a.page.getByTestId('backup-said')).toContainText('Exported 1 meeting')
  } finally { await a.app.close() }
  const b = await launch({ YOGURT_BACKUP_PATH: file })
  try {
    await b.page.getByTestId('settings-open').click(); await b.page.getByTestId('backup-import').click()
    await expect(b.page.getByTestId('backup-said')).toHaveText('Added 1 meeting.')
    expect(await b.page.evaluate(id => window.yogurt.audio.tracks(id), id)).toEqual([])
    expect((await b.page.evaluate(id => window.yogurt.transcript.get(id), id)).length).toBe(4)
  } finally { await b.app.close() }
})

test('a meeting with deleted audio resumes after its retained transcript', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_LLM_MS: '1' })
  try {
    await page.getByRole('button', { name: 'Start recording', exact: true }).click()
    const id = (await page.evaluate(() => window.yogurt.nav.current())).slice('/note/'.length)
    await expect.poll(async () => (await page.evaluate(id => window.yogurt.transcript.get(id), id)).length, { timeout: 20_000 }).toBeGreaterThan(0)
    await page.getByTestId('note-stop').click()
    await expect.poll(async () => (await page.evaluate(id => window.yogurt.notes.get(id), id)).status).toBe('done')
    const before = await page.evaluate(id => window.yogurt.transcript.get(id), id)
    expect(await page.evaluate(id => window.yogurt.audio.delete(id), id)).toBe('deleted')
    expect(await page.evaluate(id => window.yogurt.meetings.resume(id), id)).toEqual({ id })
    await expect.poll(async () => (await page.evaluate(id => window.yogurt.transcript.get(id), id)).length, { timeout: 20_000 }).toBeGreaterThan(before.length)
    await page.getByTestId('note-stop').click()
    await expect.poll(async () => (await page.evaluate(id => window.yogurt.notes.get(id), id)).status).toBe('done')
    const after = await page.evaluate(id => window.yogurt.transcript.get(id), id)
    expect(after.slice(0, before.length)).toEqual(before)
    expect(after[before.length].startMs).toBeGreaterThanOrEqual(Math.max(...before.map(s => s.endMs)))
    expect(await page.evaluate(id => window.yogurt.audio.tracks(id), id)).toEqual(['me', 'them'])
  } finally { await app.close() }
})


test('turning retention off leaves older recordings even when their summaries are generated later', async () => {
  const { app, page, userData } = await launch({ YOGURT_FAKE_LLM_MS: '1' })
  try {
    const id = await fake<string>(app, 'bigMeeting', 4)
    await page.getByTestId('settings-open').click()
    await expect(page.getByText("When off, new meetings' audio is deleted once the summary is saved.")).toBeVisible()
    await page.getByTestId('keep-recordings-toggle').click()
    await expect(page.getByTestId('keep-recordings-toggle')).toHaveAttribute('aria-checked', 'false')
    await page.evaluate(id => window.yogurt.notes.writeAgain(id), id)
    await expect.poll(async () => (await page.evaluate(id => window.yogurt.notes.get(id), id)).status).toBe('done')
    expect(await page.evaluate(id => window.yogurt.audio.tracks(id), id)).toEqual(['me', 'them'])
    expect(existsSync(join(userData, 'meetings', id, 'me.wav'))).toBe(true)
  } finally { await app.close() }
})


test('manual deletion with retention off confirms without offering Settings', async () => {
  const { app, page } = await launch()
  try {
    const id = await fake<string>(app, 'bigMeeting', 4)
    await page.evaluate(() => window.yogurt.settings.setKeepRecordings(false))
    await fake(app, 'go', `/note/${id}`)
    await page.getByRole('tab', { name: 'Transcript', exact: true }).click()
    await page.getByTestId('recording-menu').click()
    await page.getByTestId('recording-delete').click()
    await page.getByTestId('recording-delete-yes').click()
    await expect(page.getByTestId('recording-deleted-toast')).toContainText('Recording deleted')
    await expect(page.getByTestId('recording-settings')).toHaveCount(0)
    expect((await page.evaluate(() => window.yogurt.settings.get())).keepRecordings).toBe(false)
  } finally { await app.close() }
})
