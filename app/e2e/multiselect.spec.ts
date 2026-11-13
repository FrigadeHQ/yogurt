import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function launch() {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-e2e-')),
  } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  await app.evaluate(() => (globalThis as unknown as { __fake__: { manyMeetings: (options: { n: number; clean: boolean }) => unknown } }).__fake__.manyMeetings({ n: 4, clean: true }))
  await page.reload()
  await expect(page.getByTestId('past-note')).toHaveCount(4)
  return { app, page }
}

async function selectFirst(page: Page) {
  const row = page.locator('.native-meeting-row').first()
  await row.hover()
  await row.getByTestId('past-note-more').click()
  const menu = page.getByTestId('meeting-row-menu')
  await expect(menu.getByRole('menuitem').first()).toHaveText('Select')
  await expect(menu.getByRole('separator')).toHaveCount(1)
  await menu.getByTestId('meeting-select').click()
  await expect(row.getByTestId('past-note').locator('.native-meeting-link')).toHaveAttribute('aria-pressed', 'true')
}

for (const theme of ['light', 'dark'] as const) test(`select from the menu, click to add, delete once and undo all in ${theme}`, async () => {
  const { app, page } = await launch()
  try {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
    const rows = page.getByTestId('past-note'), bar = page.getByTestId('meeting-selection-bar')
    await selectFirst(page)
    await expect(bar.getByRole('status')).toContainText('1 selected')
    await expect(bar).toContainText('Click meetings to add more')
    await rows.nth(1).click()
    await expect(page.getByTestId('home')).toBeVisible()
    await expect(rows.nth(1).locator('.native-meeting-link')).toHaveAttribute('aria-pressed', 'true')
    await expect(bar.getByRole('status')).toHaveText('2 selected')
    await expect(bar).not.toContainText('Click meetings to add more')
    await bar.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(rows).toHaveCount(2)
    await expect(bar).toHaveCount(0)
    const toast = page.getByTestId('trash-toast')
    await expect(toast).toHaveCount(1)
    await expect(toast).toContainText('2 meetings moved to Trash')
    expect(await rows.first().evaluate(el => el.matches(':focus-visible'))).toBe(false)
    await toast.getByTestId('trash-undo').click()
    await expect(rows).toHaveCount(4)
    await expect(toast).toHaveCount(0)
    await expect(page.locator('[data-selected=true]')).toHaveCount(0)
    await rows.first().click()
    await expect(page.getByTestId('note-title')).toBeVisible()
  } finally { await app.close() }
})

test('folder checks show mixed membership, toggle the selection, and dragging remains add-only', async () => {
  const { app, page } = await launch()
  try {
    const { target, other, ids } = await page.evaluate(async () => {
      const target = (await window.yogurt.folders.create('Launch'))!
      const other = (await window.yogurt.folders.create('Hiring'))!
      const cards = await window.yogurt.meetings.cards({ limit: 4 })
      await window.yogurt.folders.add(other.id, cards[0].id)
      return { target, other, ids: cards.map(card => card.id) }
    })
    await expect(page.getByTestId('past-note').first().getByTestId('past-note-folder')).toHaveText('Hiring')
    await selectFirst(page)
    await page.getByTestId('past-note').nth(1).click()
    const bar = page.getByTestId('meeting-selection-bar')
    await bar.getByRole('button', { name: 'Add to folder', exact: true }).click()
    const picker = page.getByTestId('selection-folders')
    const launch = picker.getByRole('menuitemcheckbox', { name: 'Launch', exact: true })
    const hiring = picker.getByRole('menuitemcheckbox', { name: 'Hiring', exact: true })
    await expect(launch).toHaveAttribute('aria-checked', 'false')
    await expect(hiring).toHaveAttribute('aria-checked', 'mixed')
    await launch.click()
    const memberships = () => page.evaluate(async ids => Promise.all(ids.slice(0, 2).map(async id => (await window.yogurt.folders.of(id)).map(folder => folder.id).sort())), ids)
    await expect.poll(memberships).toEqual([[other.id, target.id].sort(), [target.id]])
    await expect(page.getByTestId('past-note').nth(1).getByTestId('past-note-folder')).toHaveText('Launch')
    await expect(launch).toHaveAttribute('aria-checked', 'true')
    await expect(hiring).toHaveAttribute('aria-checked', 'mixed')
    await expect(hiring).toHaveAttribute('aria-disabled', 'false')
    await hiring.click()
    await expect.poll(memberships).toEqual([[other.id, target.id].sort(), [other.id, target.id].sort()])
    await expect(hiring).toHaveAttribute('aria-checked', 'true')
    await expect(hiring).toHaveAttribute('aria-disabled', 'false')
    await hiring.click()
    await expect.poll(memberships).toEqual([[target.id], [target.id]])
    await expect(hiring).toHaveAttribute('aria-checked', 'false')
    await expect(launch).toHaveAttribute('aria-checked', 'true')
    await expect(picker).toBeVisible()
    await page.keyboard.press('Escape')
    const folder = page.getByTestId('sidebar-folder').filter({ hasText: 'Hiring' })
    await page.getByTestId('past-note').first().dragTo(folder.getByTestId('sidebar-folder-open'))
    await expect(folder.getByTestId('sidebar-folder-count')).toHaveText('2')
    await folder.getByTestId('sidebar-folder-open').click()
    await expect(page.getByTestId('folder-page')).toBeVisible()
    await expect(bar).toHaveCount(0)
    await expect(page.getByTestId('past-note')).toHaveCount(2)
    await selectFirst(page)
    await page.getByTestId('past-note').nth(1).click()
    await expect(bar.getByRole('status')).toHaveText('2 selected')
    await page.getByTestId('nav-home').click()
    await expect(bar).toHaveCount(0)
    await selectFirst(page)
    await page.getByTestId('past-note').nth(1).click()
    await page.getByTestId('past-note').first().click({ button: 'right' })
    await page.getByTestId('meeting-row-menu').getByRole('menuitem', { name: 'Add 2 meetings to folder' }).click()
    const contextFolder = page.getByTestId('meeting-row-folders').getByRole('menuitemcheckbox', { name: 'Hiring', exact: true })
    await expect(contextFolder).toHaveAttribute('aria-checked', 'true')
    await contextFolder.click()
    await expect.poll(memberships).toEqual([[target.id], [target.id]])
    await expect(contextFolder).toHaveAttribute('aria-checked', 'false')
    await expect(page.getByTestId('meeting-row-folders')).toBeVisible()
  } finally { await app.close() }
})

for (const theme of ['light', 'dark'] as const) test(`one selected meeting has the same persistent folder toggles as its own menu in ${theme}`, async () => {
  const { app, page } = await launch()
  try {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
    const { id, launch, hiring } = await page.evaluate(async () => {
      const launch = (await window.yogurt.folders.create('Launch'))!.id
      const hiring = (await window.yogurt.folders.create('Hiring'))!.id
      const id = (await window.yogurt.meetings.cards({ limit: 1 }))[0].id
      await window.yogurt.folders.add(hiring, id)
      return { id, launch, hiring }
    })
    const row = page.getByTestId('past-note').first()
    await expect(row.getByTestId('past-note-folder')).toHaveText('Hiring')
    await selectFirst(page)
    const bar = page.getByTestId('meeting-selection-bar')
    await bar.getByRole('button', { name: 'Add to folder', exact: true }).click()
    const picker = page.getByTestId('selection-folders')
    const first = picker.getByRole('menuitemcheckbox', { name: 'Launch', exact: true })
    const second = picker.getByRole('menuitemcheckbox', { name: 'Hiring', exact: true })
    const memberships = () => page.evaluate(async id => (await window.yogurt.folders.of(id)).map(folder => folder.id).sort(), id)
    await expect(first).toHaveAttribute('aria-checked', 'false')
    await expect(second).toHaveAttribute('aria-checked', 'true')
    await first.click()
    await expect.poll(memberships).toEqual([launch, hiring].sort())
    await expect(first).toHaveAttribute('aria-checked', 'true')
    await expect(second).toHaveAttribute('aria-disabled', 'false')
    await second.click()
    await expect.poll(memberships).toEqual([launch])
    await expect(row.getByTestId('past-note-folder')).toHaveText('Launch')
    await expect(first).toHaveAttribute('aria-checked', 'true')
    await expect(second).toHaveAttribute('aria-checked', 'false')
    await expect(second).toHaveAttribute('aria-disabled', 'false')
    await second.click()
    await expect.poll(memberships).toEqual([launch, hiring].sort())
    await expect(first).toHaveAttribute('aria-disabled', 'false')
    await first.click()
    await expect.poll(memberships).toEqual([hiring])
    await expect(row.getByTestId('past-note-folder')).toHaveText('Hiring')
    await expect(first).toHaveAttribute('aria-checked', 'false')
    await expect(second).toHaveAttribute('aria-checked', 'true')
    await page.keyboard.press('Escape')
    await bar.getByRole('button', { name: 'Clear selection' }).click()
    await row.click({ button: 'right' })
    await page.getByTestId('meeting-row-menu').getByRole('menuitem', { name: 'Add to folder', exact: true }).click()
    const own = page.getByTestId('meeting-row-folders')
    await expect(own.getByRole('menuitemcheckbox', { name: 'Launch', exact: true })).toHaveAttribute('aria-checked', 'false')
    await expect(own.getByRole('menuitemcheckbox', { name: 'Hiring', exact: true })).toHaveAttribute('aria-checked', 'true')
  } finally { await app.close() }
})

test('selection menus, range, select all and Escape stay within the current list', async () => {
  const { app, page } = await launch()
  try {
    const rows = page.getByTestId('past-note'), menu = page.getByTestId('meeting-row-menu'), bar = page.getByTestId('meeting-selection-bar')
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
    await rows.first().click({ modifiers: [modifier] })
    await rows.nth(2).click({ modifiers: ['Shift'] })
    await expect(bar.getByRole('status')).toHaveText('3 selected')
    await rows.first().click({ button: 'right' })
    await expect(menu.getByRole('menuitem')).toHaveText(['Add 3 meetings to folder', 'Move 3 meetings to Trash'])
    await page.keyboard.press('Escape')
    await rows.last().click({ button: 'right' })
    await expect(menu.getByRole('menuitem')).toHaveText(['Select', 'Add to folder', 'Move to Trash'])
    await page.keyboard.press('Escape')
    await page.keyboard.press(`${modifier}+a`)
    await expect(bar.getByRole('status')).toHaveText('4 selected')
    await page.keyboard.press('Escape')
    await expect(bar).toHaveCount(0)
    await rows.first().click({ modifiers: [modifier] })
    await rows.first().click()
    await expect(bar).toHaveCount(0)
    await expect(page.getByTestId('home')).toBeVisible()
    await rows.first().click({ modifiers: [modifier] })
    await page.getByTestId('nav-home').focus()
    await page.keyboard.press('Escape')
    await expect(bar).toHaveCount(0)
  } finally { await app.close() }
})
