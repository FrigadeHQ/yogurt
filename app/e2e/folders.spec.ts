import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')

async function launch(env: Record<string, string> = {}) {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData, ...env } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page }
}
const fake = <T>(app: ElectronApplication, fn: string, arg?: unknown): Promise<T> =>
  app.evaluate((_e, [fn, arg]) => (globalThis as unknown as Record<string, Record<string, (a?: unknown) => unknown>>).__fake__[fn as string](arg), [fn, arg] as const) as Promise<T>
/** four finished meetings, newest first: Budget review, Weekly sync, Customer call with Acme, Design crit */
async function withMeetings(app: ElectronApplication, page: Page) {
  await fake(app, 'manyMeetings', { n: 4, clean: true })
  await page.reload()
  await expect(page.getByTestId('past-note')).toHaveCount(4)
}
const folder = (page: Page, name: string) => page.getByTestId('sidebar-folder').filter({ hasText: name })
async function newFolder(page: Page, name: string) {
  await page.getByTestId('folder-create').click()
  await expect(page.getByTestId('folder-name-input')).toBeFocused()
  await page.keyboard.type(name)
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('folder-title')).toHaveText(name)
}
const openNote = async (page: Page, title: string) => {
  await page.getByTestId('nav-home').click()
  await page.getByTestId('past-note').filter({ hasText: title }).click()
  await expect(page.getByTestId('note-title')).toHaveText(title)
}

test('folder and Trash icons stay still on hover in either sidebar size and respect reduced motion', async () => {
  const { app, page } = await launch()
  try {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await newFolder(page, 'Standup')
    for (const compact of [false, true]) {
      if (compact) await page.getByTestId('sidebar-collapse').click()
      for (const row of [page.getByTestId('sidebar-folder-open'), page.getByTestId('nav-trash')]) {
        await page.mouse.move(700, 300)
        const svg = row.locator('svg').first()
        await expect(svg).toHaveCSS('animation-name', 'none')
        await row.hover()
        await expect(svg).toHaveCSS('animation-name', 'none')
        await expect(svg).toHaveCSS('animation-iteration-count', '1')
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await expect(svg).toHaveCSS('animation-name', 'none')
        await page.emulateMedia({ reducedMotion: 'no-preference' })
      }
    }
  } finally { await app.close() }
})

test('folders reorder within their section, persist, and remain keyboard accessible', async () => {
  const { app, page } = await launch()
  try {
    for (const name of ['Alpha', 'Bravo', 'Charlie']) await newFolder(page, name)
    await page.getByTestId('nav-home').click()
    const group = page.getByTestId('folder-reorder-list')
    const bounds = await group.boundingBox()
    const start = await folder(page, 'Charlie').getByTestId('sidebar-folder-open').boundingBox()
    expect(bounds).toBeTruthy(); expect(start).toBeTruthy()
    await page.mouse.move(start!.x + 70, start!.y + start!.height / 2)
    await page.mouse.down()
    await page.mouse.move(start!.x + 70, bounds!.y - 200, { steps: 20 })
    await expect.poll(async () => (await folder(page, 'Charlie').boundingBox())!.y).toBeGreaterThanOrEqual(bounds!.y - 1)
    await page.mouse.up()
    const labels = page.getByTestId('sidebar-folder-open')
    await expect(labels).toHaveText([/Charlie/, /Alpha/, /Bravo/])
    await expect(page.getByTestId('home')).toBeVisible()
    await expect.poll(() => page.evaluate(async () => (await window.yogurt.folders.list()).map(f => f.name))).toEqual(['Charlie', 'Alpha', 'Bravo'])
    await page.reload()
    await expect(labels).toHaveText([/Charlie/, /Alpha/, /Bravo/])
    await folder(page, 'Charlie').getByTestId('sidebar-folder-open').focus()
    await page.keyboard.press('Alt+ArrowDown')
    await expect(labels).toHaveText([/Alpha/, /Charlie/, /Bravo/])
    await folder(page, 'Charlie').getByTestId('sidebar-folder-open').click()
    await expect(page.getByTestId('folder-title')).toHaveText('Charlie')
  } finally { await app.close() }
})

test('a folder is made in the sidebar, opens empty, and is renamed in place and from its menu', async () => {
  const { app, page } = await launch()
  try {
    await expect(page.getByText('Folders and folders are being built.')).toHaveCount(0)
    await newFolder(page, 'Acme')
    await expect(page.getByTestId('folder-empty')).toBeVisible()
    await expect(page.getByTestId('workspace-heading')).toHaveText('Acme')
    await expect(folder(page, 'Acme').getByTestId('sidebar-folder-open')).toHaveAttribute('aria-current', 'page')

    await page.getByTestId('folder-title').getByRole('button').click()
    await page.getByTestId('folder-title-input').fill('Acme Inc')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('folder-title')).toHaveText('Acme Inc')
    await expect(folder(page, 'Acme Inc')).toBeVisible()

    await folder(page, 'Acme Inc').hover()
    await folder(page, 'Acme Inc').getByTestId('sidebar-folder-more').click()
    await page.getByTestId('sidebar-folder-rename').click()
    await page.getByTestId('folder-name-input').fill('Customers')
    await page.getByTestId('folder-name-save').click()
    await expect(page.getByTestId('folder-title')).toHaveText('Customers')
    await expect(page.getByTestId('sidebar-folder')).toHaveCount(1)
    // Escape keeps the name
    await page.getByTestId('folder-title').getByRole('button').click()
    await page.getByTestId('folder-title-input').fill('Nope')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('folder-title')).toHaveText('Customers')
  } finally { await app.close() }
})

test('a note goes into folders from its menu and its chip, and a new folder from the menu takes it at once', async () => {
  const { app, page } = await launch()
  try {
    await withMeetings(app, page)
    await newFolder(page, 'Acme')
    // A confident match stays unfiled until the person confirms it; taking it out sticks.
    await openNote(page, 'Customer call with Acme')
    await expect(page.getByTestId('note-folders-summary')).toHaveText('Acme')
    await expect(page.getByTestId('folder-suggestion')).toHaveText('Acme')
    await expect(folder(page, 'Acme').getByTestId('sidebar-folder-count')).toHaveText('0')
    await page.getByTestId('note-folders').click()
    const suggested = page.getByTestId('folder-chip-list').getByTestId('folder-option').first()
    await expect(suggested).toHaveText('AcmeSuggested')
    await expect(suggested).toHaveAttribute('aria-checked', 'false')
    await page.keyboard.press('Escape')
    await page.getByTestId('folder-suggestion-confirm').click()
    await expect(page.getByTestId('folder-suggestion')).toHaveCount(0)
    await expect(folder(page, 'Acme').getByTestId('sidebar-folder-count')).toHaveText('1')
    await page.getByTestId('note-folders').click()
    await page.getByTestId('folder-chip-list').getByTestId('folder-option').filter({ hasText: 'Acme' }).click()
    await expect(page.getByTestId('note-folders-summary')).toHaveText('Add to folder')
    await page.keyboard.press('Escape')
    await page.reload()
    await expect(page.getByTestId('note-folders-summary')).toHaveText('Add to folder')
    // one that fits no folder stays out of them
    await openNote(page, 'Weekly sync')
    await expect(page.getByTestId('note-folders-summary')).toHaveText('Add to folder')

    await page.getByTestId('note-menu-button').click()
    await page.getByTestId('note-add-to-folder').click()
    const option = page.getByTestId('note-menu-folders').getByTestId('folder-option').filter({ hasText: 'Acme' })
    await expect(option).toHaveAttribute('aria-checked', 'false')
    await option.click()
    await expect(option).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('note-folders-summary')).toHaveText('Acme')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('note-menu')).toHaveCount(0)

    // New folder… names one and puts this note in it
    await page.getByTestId('note-menu-button').click()
    await page.getByTestId('note-add-to-folder').click()
    await page.getByTestId('note-menu-folders').getByTestId('folder-new').click()
    await page.getByTestId('folder-name-input').fill('Board')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('note-folders-summary')).toHaveText('Acme + 1')
    await expect(folder(page, 'Board').getByTestId('sidebar-folder-count')).toHaveText('1')

    // the chip: same list; taking it out of Acme
    await page.getByTestId('note-folders').click()
    const list = page.getByTestId('folder-chip-list')
    await expect(list.getByTestId('folder-option').filter({ hasText: 'Board' })).toHaveAttribute('aria-checked', 'true')
    await list.getByTestId('folder-option').filter({ hasText: 'Acme' }).click()
    await expect(page.getByTestId('note-folders-summary')).toHaveText('Board')
    await page.keyboard.press('Escape')

    await openNote(page, 'Budget review')
    await page.getByTestId('note-folders').click()
    await page.getByTestId('folder-chip-list').getByTestId('folder-option').filter({ hasText: 'Board' }).click()
    await expect(page.getByTestId('note-folders-summary')).toHaveText('Board')

    // the folder's page: its meetings, newest first, as on Meetings
    await folder(page, 'Board').getByTestId('sidebar-folder-open').click()
    await expect(page.getByTestId('folder-page').getByTestId('past-note')).toHaveText([/Budget review/, /Weekly sync/])
    await page.getByTestId('folder-page').getByTestId('past-note').first().click()
    await expect(page.getByTestId('note-title')).toHaveText('Budget review')
  } finally { await app.close() }
})

for (const theme of ['light', 'dark'] as const) for (const action of ['confirm', 'cancel'] as const) for (const input of ['pointer', 'keyboard'] as const) test(`a row can ${action} its suggested folder by ${input} without opening the note in ${theme}`, async () => {
  const { app, page } = await launch()
  try {
    await page.evaluate(theme => window.yogurt.settings.setTheme(theme), theme)
    await withMeetings(app, page)
    await newFolder(page, 'Acme')
    await page.getByTestId('nav-home').click()
    const row = page.getByTestId('past-note').filter({ hasText: 'Customer call with Acme' })
    const chip = row.getByTestId('folder-suggestion')
    await expect(chip).toHaveText('Acme')
    const name = 'Acme community research and planning with the customer success team'
    const ids = await page.evaluate(async name => {
      const f = (await window.yogurt.folders.list())[0]
      await window.yogurt.folders.rename(f.id, name)
      await window.yogurt.folders.appearance(f.id, { icon: 'rocket', color: 'violet' })
      const meetings = await window.yogurt.meetings.cards({ limit: 4 })
      const meeting = meetings.find(m => m.title === 'Customer call with Acme')!
      await window.yogurt.folders.add(f.id, meetings.find(m => m.title === 'Weekly sync')!.id)
      return { folder: f.id, meeting: meeting.id }
    }, name)
    await expect(chip).toHaveText(name)
    await expect(chip.locator('.meeting-folder-dot')).toHaveAttribute('data-folder-color', 'violet')
    await expect(chip.locator('[data-folder-icon]')).toHaveCount(0)
    expect(await chip.locator('button').evaluateAll(buttons => buttons.map(button => button.dataset.testid)))
      .toEqual(['note-folders', 'folder-suggestion-cancel', 'folder-suggestion-confirm'])
    const filed = page.getByTestId('past-note').filter({ hasText: 'Weekly sync' }).getByTestId('past-note-folder')
    await expect(filed).toBeVisible()
    for (const property of ['height', 'border-radius', 'font-size', 'line-height']) {
      await expect(chip).toHaveCSS(property, await filed.evaluate((el, property) => getComputedStyle(el).getPropertyValue(property), property))
    }
    await expect(chip).toHaveCSS('border-style', 'dashed')
    await expect(chip).toHaveCSS('height', '22px')
    await expect(chip.locator('.meeting-folder-dot')).toHaveCSS('width', '7px')
    await expect(chip.locator('.note-folder-actions')).toHaveCSS('border-inline-start-width', '0px')
    await page.getByTestId('nav-home').hover()
    await expect(chip.locator('.note-folder-actions')).toHaveCSS('opacity', '1')
    for (const control of ['cancel', 'confirm']) {
      await expect(chip.getByTestId(`folder-suggestion-${control}`)).toBeVisible()
      await expect(chip.getByTestId(`folder-suggestion-${control}`).locator('svg')).toHaveAttribute('width', '12')
    }
    expect(await chip.getByTestId('note-folders-summary').evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true)
    if (input === 'keyboard') {
      await chip.getByTestId('note-folders').focus()
      await page.keyboard.press('Tab')
      await expect(chip.getByTestId('folder-suggestion-cancel')).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(chip.getByTestId('folder-suggestion-confirm')).toBeFocused()
      if (action === 'cancel') await page.keyboard.press('Shift+Tab')
      await page.keyboard.press(action === 'cancel' ? 'Space' : 'Enter')
    } else await chip.getByTestId(`folder-suggestion-${action}`).click()
    await expect(page.getByTestId('home')).toBeVisible()
    await expect(chip).toHaveCount(0)
    await expect(row.locator('.native-meeting-link')).toBeFocused()
    expect(await page.evaluate(id => window.yogurt.folders.of(id), ids.meeting)).toHaveLength(action === 'confirm' ? 1 : 0)
    if (action === 'confirm') {
      await expect(row.getByTestId('past-note-folder')).toHaveText(name)
      await page.evaluate(({ folder, meeting }) => window.yogurt.folders.remove(folder, meeting), ids)
    }
    await page.evaluate(() => window.yogurt.folders.create('Another folder'))
    await page.reload()
    await expect(row).toBeVisible()
    await expect(chip).toHaveCount(0)
    await row.locator('.native-meeting-link').click()
    await expect(page.getByTestId('note-folders-summary')).toHaveText('Add to folder')
    await expect(page.getByTestId('folder-suggestion')).toHaveCount(0)
  } finally { await app.close() }
})

for (const input of ['pointer', 'keyboard'] as const) test(`the suggested row name opens its folder menu by ${input} and choosing any folder removes the proposal everywhere`, async () => {
  const { app, page } = await launch()
  try {
    await withMeetings(app, page)
    await newFolder(page, 'Acme')
    await page.getByTestId('nav-home').click()
    const row = page.getByTestId('past-note').filter({ hasText: 'Customer call with Acme' })
    await expect(row.getByTestId('folder-suggestion')).toBeVisible()
    await page.evaluate(() => window.yogurt.folders.create('Alpha'))
    if (input === 'keyboard') {
      await row.getByTestId('note-folders').focus()
      await page.keyboard.press('Enter')
    } else await row.getByTestId('note-folders').click()
    await expect(page.getByTestId('home')).toBeVisible()
    const picker = page.getByTestId('meeting-row-folders')
    await expect(picker.getByTestId('folder-option').first()).toHaveText('AcmeSuggested')
    await picker.getByRole('menuitemcheckbox', { name: 'Alpha', exact: true }).click()
    await expect(row.getByTestId('past-note-folder')).toHaveText('Alpha')
    await expect(row.getByTestId('folder-suggestion')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await page.evaluate(() => window.yogurt.folders.create('Customer calls'))
    await page.reload()
    await expect(row.getByTestId('past-note-folder')).toHaveText('Alpha')
    await expect(row.getByTestId('folder-suggestion')).toHaveCount(0)
    await row.locator('.native-meeting-link').click()
    await expect(page.getByTestId('note-folders-summary')).toHaveText('Alpha')
    await expect(page.getByTestId('folder-suggestion')).toHaveCount(0)
  } finally { await app.close() }
})

for (const colorScheme of ['light', 'dark'] as const) test(`the divided suggestion chip supports long names, its picker and dismissal in ${colorScheme}`, async () => {
  const { app, page } = await launch()
  try {
    await page.emulateMedia({ colorScheme })
    await withMeetings(app, page)
    await newFolder(page, 'Acme')
    await openNote(page, 'Customer call with Acme')
    const proposal = page.getByTestId('folder-suggestion')
    await expect(proposal).toBeVisible()
    const name = 'Acme community research and planning with the customer success team'
    await page.evaluate(async name => {
      const f = (await window.yogurt.folders.list())[0]
      await window.yogurt.folders.rename(f.id, name)
      await window.yogurt.folders.appearance(f.id, { icon: 'rocket', color: 'violet' })
      await window.yogurt.folders.create('Alpha')
    }, name)
    await expect(proposal).toHaveText(name)
    await expect(proposal.locator('[data-folder-icon=rocket]')).toHaveAttribute('data-folder-color', 'violet')
    expect(await proposal.locator('button').evaluateAll(buttons => buttons.map(button => button.dataset.testid)))
      .toEqual(['note-folders', 'folder-suggestion-cancel', 'folder-suggestion-confirm'])
    for (const action of ['cancel', 'confirm']) {
      await expect(proposal.getByTestId(`folder-suggestion-${action}`).locator('svg')).toHaveAttribute('width', '15')
    }
    const label = page.getByTestId('note-folders-summary')
    expect(await label.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true)
    expect((await proposal.boundingBox())!.width).toBeLessThanOrEqual(256)
    await page.getByTestId('note-folders').click()
    const options = page.getByTestId('folder-chip-list').getByTestId('folder-option')
    await expect(options.first()).toHaveText(`${name}Suggested`)
    await expect(options.first()).toBeFocused()
    await expect(options.first()).toHaveAttribute('aria-checked', 'false')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('note-folders')).toBeFocused()
    await page.getByTestId('folder-suggestion-cancel').click()
    await expect(proposal).toHaveCount(0)
    await expect(label).toHaveText('Add to folder')
    await expect(page.getByTestId('note-folders')).toBeFocused()
    await page.evaluate(() => window.yogurt.folders.create('Another folder'))
    await page.reload()
    await expect(page.getByTestId('note-folders-summary')).toHaveText('Add to folder')
    await expect(proposal).toHaveCount(0)
    await expect(folder(page, name).getByTestId('sidebar-folder-count')).toHaveText('0')
  } finally { await app.close() }
})

test('a meeting row dragged onto a folder goes into it; ⌘K on a folder page looks only there', async () => {
  const { app, page } = await launch()
  try {
    await withMeetings(app, page)
    await newFolder(page, 'Acme')
    await page.getByTestId('nav-home').click()
    const preview = page.evaluate(() => new Promise<{ width: number; height: number; text: string | null; icon: boolean }>((resolve) => {
      const original = DataTransfer.prototype.setDragImage
      DataTransfer.prototype.setDragImage = function (element, x, y) {
        const { width, height } = element.getBoundingClientRect()
        resolve({ width, height, text: element.textContent, icon: !!element.querySelector('.meeting-identity') })
        DataTransfer.prototype.setDragImage = original
        original.call(this, element, x, y)
      }
    }))
    await page.getByTestId('past-note').filter({ hasText: 'Customer call with Acme' }).dragTo(folder(page, 'Acme').getByTestId('sidebar-folder-open'))
    const dragged = await preview
    expect(dragged).toMatchObject({ text: 'Customer call with Acme', icon: true })
    expect(dragged.width).toBeLessThanOrEqual(280)
    expect(dragged.height).toBeLessThanOrEqual(54)
    await expect(page.locator('.meeting-drag-preview')).toHaveCount(0)
    await expect(folder(page, 'Acme').getByTestId('sidebar-folder-count')).toHaveText('1')
    await page.getByTestId('past-note').filter({ hasText: 'Design crit' }).dragTo(folder(page, 'Acme').getByTestId('sidebar-folder-open'))
    await expect(folder(page, 'Acme').getByTestId('sidebar-folder-count')).toHaveText('2')
    // dropping it twice changes nothing
    await page.getByTestId('past-note').filter({ hasText: 'Design crit' }).dragTo(folder(page, 'Acme').getByTestId('sidebar-folder-open'))
    await folder(page, 'Acme').getByTestId('sidebar-folder-open').click()
    await expect(page.getByTestId('folder-page').getByTestId('past-note')).toHaveText([/Customer call with Acme/, /Design crit/])

    await page.keyboard.press('Meta+k')
    await expect(page.getByTestId('search-scope')).toHaveText('Acme')
    await expect(page.getByTestId('search-result')).toHaveCount(2)
    await page.keyboard.type('budget')
    await expect(page.getByTestId('search-result')).toHaveCount(0)
    await expect(page.getByTestId('search-ask')).toHaveAttribute('aria-selected', 'true')
    await page.getByTestId('search-scope-clear').click()
    await expect(page.getByTestId('search-result').first()).toContainText('Budget review')
    await expect(page.getByTestId('search-input')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('search')).toHaveCount(0)
    // from anywhere else, search looks everywhere
    await page.getByTestId('nav-home').click()
    await page.keyboard.press('Meta+k')
    await expect(page.getByTestId('search-scope')).toHaveCount(0)
    await expect(page.getByTestId('search-result')).toHaveCount(3)
    // The fourth meeting is outside the recent preview, but still searchable without a folder scope.
    await page.getByTestId('search-input').fill('design crit')
    await expect(page.getByTestId('search-result')).toHaveCount(1)
    await expect(page.getByTestId('search-result')).toContainText('Design crit')
  } finally { await app.close() }
})

test('deleting a folder asks first and keeps its meetings; deleting a meeting takes it out of its folders', async () => {
  const { app, page } = await launch()
  try {
    await withMeetings(app, page)
    await newFolder(page, 'Partners')
    for (const title of ['Weekly sync', 'Design crit']) {
      await page.getByTestId('nav-home').click()
      await page.getByTestId('past-note').filter({ hasText: title }).dragTo(folder(page, 'Partners').getByTestId('sidebar-folder-open'))
    }
    await expect(folder(page, 'Partners').getByTestId('sidebar-folder-count')).toHaveText('2')

    // a meeting deleted from the folder's page (to the Trash) leaves the folder too
    await folder(page, 'Partners').getByTestId('sidebar-folder-open').click()
    const row = page.getByTestId('folder-page').getByRole('listitem').filter({ hasText: 'Design crit' })
    await row.hover()
    await row.getByTestId('past-note-more').click()
    await page.getByTestId('past-note-trash').click()
    await expect(page.getByTestId('folder-page').getByTestId('past-note')).toHaveText([/Weekly sync/])
    await expect(folder(page, 'Partners').getByTestId('sidebar-folder-count')).toHaveText('1')

    await folder(page, 'Partners').hover()
    await folder(page, 'Partners').getByTestId('sidebar-folder-more').click()
    await page.getByTestId('sidebar-folder-delete').click()
    const confirm = page.getByTestId('folder-delete-confirm')
    await expect(confirm).toContainText('Its meetings stay in Meetings.')
    await expect(page.getByTestId('folder-delete-cancel')).toBeFocused()
    await page.getByTestId('folder-delete-cancel').click()
    await expect(page.getByTestId('sidebar-folder')).toHaveCount(1)

    await folder(page, 'Partners').hover()
    await folder(page, 'Partners').getByTestId('sidebar-folder-more').click()
    await page.getByTestId('sidebar-folder-delete').click()
    await page.getByTestId('folder-delete-yes').click()
    await expect(page.getByTestId('sidebar-folder')).toHaveCount(0)
    // it was open: back to Meetings, where every meeting still is
    await expect(page.getByTestId('home')).toBeVisible()
    await expect(page.getByTestId('past-note')).toHaveCount(3)
  } finally { await app.close() }
})

test('a backup carries folders and which meetings are in them', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'yogurt-backup-')), 'Yogurt backup.zip')
  const a = await launch({ YOGURT_BACKUP_PATH: file })
  try {
    await withMeetings(a.app, a.page)
    await newFolder(a.page, 'Partners')
    await a.page.getByTestId('nav-home').click()
    await a.page.getByTestId('past-note').filter({ hasText: 'Weekly sync' }).dragTo(folder(a.page, 'Partners').getByTestId('sidebar-folder-open'))
    await expect(folder(a.page, 'Partners').getByTestId('sidebar-folder-count')).toHaveText('1')
    await newFolder(a.page, 'Zulu')
    await a.page.evaluate(async () => { const folders = await window.yogurt.folders.list(); await window.yogurt.folders.reorder(folders.map(f => f.id).reverse()) })
    await a.page.getByTestId('settings-open').click()
    await a.page.getByTestId('backup-export').click()
    await expect(a.page.getByTestId('backup-said')).toContainText('Exported 4 meetings')
  } finally { await a.app.close() }

  const b = await launch({ YOGURT_BACKUP_PATH: file })
  try {
    await expect(b.page.getByTestId('sidebar-folder')).toHaveCount(0)
    await b.page.getByTestId('settings-open').click()
    await b.page.getByTestId('backup-import').click()
    await expect(b.page.getByTestId('backup-said')).toHaveText('Added 4 meetings.')
    await expect(b.page.getByTestId('sidebar-folder-open')).toHaveText([/Zulu/, /Partners/])
    // the sidebar heard about it without a reload
    await expect(folder(b.page, 'Partners').getByTestId('sidebar-folder-count')).toHaveText('1')
    await folder(b.page, 'Partners').getByTestId('sidebar-folder-open').click()
    await expect(b.page.getByTestId('folder-page').getByTestId('past-note')).toHaveText([/Weekly sync/])
  } finally { await b.app.close() }
})

test('24 folder icons and eight colors persist, label filed meetings without replacing their identity, and cancel without saving', async () => {
  const { app, page } = await launch()
  try {
    await withMeetings(app, page)
    await page.getByTestId('folder-create').click()
    await page.getByTestId('folder-name-input').fill('Design')
    await expect(page.getByRole('radiogroup', { name: 'Icon', exact: true }).getByRole('radio')).toHaveCount(24)
    await expect(page.getByRole('radiogroup', { name: 'Color', exact: true }).getByRole('radio')).toHaveCount(8)
    await page.getByTestId('folder-icon-palette').click()
    await page.getByTestId('folder-color-violet').click()
    await page.getByTestId('folder-name-save').click()
    const nav = folder(page, 'Design')
    await expect(nav.locator('[data-folder-icon=palette]')).toHaveAttribute('data-folder-color', 'violet')
    await expect(page.getByTestId('folder-heading-icon').locator('[data-folder-icon=palette]')).toBeVisible()
    await page.getByTestId('nav-home').click()
    await page.getByTestId('past-note').filter({ hasText: 'Weekly sync' }).dragTo(nav.getByTestId('sidebar-folder-open'))
    const card = page.getByTestId('past-note').filter({ hasText: 'Weekly sync' })
    await expect(card.getByTestId('past-note-folder')).toHaveText('Design')
    await expect(card.getByTestId('past-note-folder')).toHaveAttribute('data-folder-color', 'violet')
    await expect(card.locator('.meeting-identity')).toBeVisible()
    await expect(card.locator('.meeting-identity[data-folder-color], .meeting-identity [data-folder-icon]')).toHaveCount(0)
    await card.click()
    await expect(page.getByTestId('note-folders').locator('[data-folder-icon=palette]')).toBeVisible()

    await nav.getByTestId('sidebar-folder-more').click()
    await page.getByTestId('sidebar-folder-appearance').click()
    await expect(page.getByTestId('folder-icon-palette')).toBeFocused()
    await page.getByTestId('folder-icon-rocket').click()
    await page.getByTestId('folder-color-blue').click()
    await page.keyboard.press('Escape')
    await expect(nav.locator('[data-folder-icon=palette]')).toBeVisible()
    await expect(nav.getByTestId('sidebar-folder-more')).toBeFocused()

    await nav.getByTestId('sidebar-folder-open').click()
    await page.getByTestId('folder-heading-icon').click()
    await page.getByTestId('folder-icon-folder').click()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByTestId('folder-icon-star')).toHaveAttribute('aria-checked', 'true')
    await page.getByTestId('folder-color-amber').click()
    await page.getByTestId('folder-appearance-save').click()
    await page.reload()
    await expect(nav.locator('[data-folder-icon=star]')).toHaveAttribute('data-folder-color', 'amber')
    await nav.getByTestId('sidebar-folder-open').click()
    await expect(page.getByTestId('folder-heading-icon').locator('[data-folder-icon=star]')).toBeVisible()
    await expect(card).toBeVisible()
    await expect(card.getByTestId('past-note-folder')).toHaveCount(0)
    await expect(card.locator('.meeting-identity[data-folder-color], .meeting-identity [data-folder-icon]')).toHaveCount(0)
    await page.keyboard.press('Meta+k')
    await page.getByTestId('search-input').fill('Design')
    await expect(page.getByTestId('search').locator('[data-folder-icon=star]').last()).toBeVisible()
  } finally { await app.close() }
})
