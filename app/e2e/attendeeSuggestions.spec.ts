import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('attendee suggestions rank invitees, keep distinct email identities, and support keyboard and pointer selection', async () => {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'attendee-suggestions-')),
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    await app.evaluate(() => (globalThis as any).__fake__.manyMeetings({ n: 3, clean: true }))
    const [target, recent, older] = await page.evaluate(() => window.yogurt.meetings.cards({ limit: 3 }))
    await page.evaluate(async ({ recent, older }) => {
      await window.yogurt.settings.setName('Owner Example')
      await window.yogurt.meetings.setAttendees(recent, [{ name: 'Guest Recent', email: 'recent@example.test' }, { name: 'Guest Shared', email: null }])
      await window.yogurt.meetings.setAttendees(older, [{ name: 'Guest Older', email: 'older@example.test' }, { name: 'Guest Shared', email: 'second@example.test' }])
    }, { recent: recent.id, older: older.id })
    const at = target.startedAt + 86_400_000
    await app.evaluate((_e, at) => (globalThis as any).__fake__.calendarEvents([
      { id: 'current', title: 'Planning', start: new Date(at).toISOString(), end: new Date(at + 1_800_000).toISOString(), attendees: [
        { name: 'Guest Invitee', email: 'invitee@example.test' }, { name: 'Guest Shared', email: 'first@example.test' },
      ] },
      { id: 'other', title: 'Other event', start: new Date(at + 1_800_000).toISOString(), end: new Date(at + 3_600_000).toISOString(), attendees: [{ name: 'Guest Calendar', email: 'calendar@example.test' }] },
    ]), at)
    await page.evaluate(async ({ id, at }) => {
      await window.yogurt.meetings.linkEvent(id, 'current', at)
      await window.yogurt.meetings.setAttendees(id, [])
      window.yogurt.nav.go(`/note/${id}`)
    }, { id: target.id, at })
    await page.getByTestId('note-attendees').click()
    const input = page.getByTestId('people-add'), options = page.getByRole('option')
    await input.fill('Guest')
    await expect(options).toHaveCount(5)
    await expect(options.nth(0)).toContainText('Guest Invitee')
    await expect(options.nth(1)).toContainText('first@example.test')
    await expect(options.nth(2)).toContainText('Guest Recent')
    await input.press('ArrowDown')
    await expect(options.first()).toHaveAttribute('aria-selected', 'true')
    await expect(input).toHaveAttribute('aria-activedescendant', await options.first().getAttribute('id') as string)
    await input.press('Enter')
    await expect(input).toHaveValue('')
    await expect(page.getByTestId('people-list')).toContainText('invitee@example.test')
    await input.fill('Guest Shared')
    await expect(options).toHaveCount(2)
    await options.filter({ hasText: 'first@example.test' }).click()
    await expect(input).toBeFocused()
    await expect(input).toHaveValue('')
    await input.fill('Guest Shared')
    await expect(options).toHaveCount(1)
    await expect(options).toContainText('second@example.test')
    await input.press('ArrowUp')
    await input.press('Enter')
    await expect(page.getByTestId('people-list')).toContainText('second@example.test')
    await input.fill('Guest Calendar')
    await expect(options).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('people-card')).toHaveCount(0)
    await expect(page.getByTestId('note-attendees')).toBeFocused()
  } finally { await app.close() }
})

test('auto titles use current attendees after edits while an edited summary stays intact', async () => {
  test.setTimeout(90_000)
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_FAKE_LLM_MS: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'attendee-titles-')),
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    await page.evaluate(() => window.yogurt.settings.setName('Owner Example'))
    await app.evaluate(() => (globalThis as any).__fake__.calendarEvents([]))
    await page.reload()
    await page.getByTestId('new-note').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    const id = await page.evaluate(async () => (await window.yogurt.nav.current()).slice('/note/'.length))
    await expect.poll(() => page.evaluate(id => window.yogurt.transcript.get(id).then(lines => lines.length), id), { timeout: 20_000 }).toBeGreaterThan(0)
    await page.getByTestId('note-stop').click()
    await expect.poll(() => page.evaluate(id => window.yogurt.meetings.get(id).then(m => m?.titleSource), id), { timeout: 30_000 }).toBe('auto')
    await page.getByTestId('note-summary-tab').click()
    await page.getByRole('textbox', { name: 'Summary', exact: true }).fill('Keep this edited summary.')
    await expect.poll(() => page.evaluate(id => window.yogurt.notes.get(id).then(n => n.enhanced), id)).toContain('Keep this edited summary.')
    await app.evaluate(() => { (globalThis as any).__fake__.prompts().notes.length = 0 })
    await page.evaluate(async id => {
      await window.yogurt.meetings.setAttendees(id, [{ name: 'Guest Previous', email: null }])
      await window.yogurt.meetings.setAttendees(id, [{ name: 'Guest Current', email: 'current@example.test' }])
    }, id)
    const titles = () => app.evaluate(() => ((globalThis as any).__fake__.prompts().notes as string[]).filter(p => p.startsWith('Now give this meeting a title')))
    await expect.poll(async () => (await titles()).length, { timeout: 20_000 }).toBe(1)
    const [prompt] = await titles()
    expect(prompt).toContain('Owner Example')
    expect(prompt).toContain('["Guest Current"]')
    expect(prompt).not.toContain('Guest Previous')
    expect(await page.evaluate(id => window.yogurt.notes.get(id).then(n => n.enhanced), id)).toContain('Keep this edited summary.')
    await expect(page.getByTestId('note-title')).not.toContainText('Owner')
  } finally { await app.close() }
})
