import { _electron as electron, expect, test, type Locator } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const menus = [
  { trigger: 'share-button', surface: 'share-menu', first: 'share-copy-notes', logical: false },
  { trigger: 'note-menu-button', surface: 'note-menu', first: 'note-rename', logical: true, end: true },
  { trigger: 'note-date', surface: 'note-date-card', first: 'note-date-heading', logical: true },
  { trigger: 'note-attendees', surface: 'people-card', first: 'people-add', logical: true },
]

async function launch() {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-menu-motion-')),
  } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  await app.evaluate(() => (globalThis as unknown as { __fake__: { manyMeetings(o: { n: number; clean: boolean }): void } }).__fake__.manyMeetings({ n: 1, clean: true }))
  await page.reload()
  await page.getByTestId('past-note').click()
  await expect(page.getByTestId('note-enhanced')).toBeVisible()
  return { app, page }
}

const motion = (surface: Locator) => surface.evaluate((el) => {
  const style = getComputedStyle(el), origin = style.transformOrigin.split(' ').map(parseFloat)
  return { transition: style.transitionProperty, duration: style.transitionDuration, x: origin[0], y: origin[1], width: (el as HTMLElement).offsetWidth }
})

test('keyboard menus open with the same quick motion as a click, focus immediately and dismiss back to their triggers', async () => {
  const { app, page } = await launch()
  try {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    for (const key of ['Enter', 'Space']) for (const menu of menus) {
      const trigger = page.getByTestId(menu.trigger), surface = page.getByTestId(menu.surface)
      await trigger.focus()
      await page.keyboard.press(key)
      await expect(surface).toBeVisible()
      expect((await motion(surface)).duration).toBe('0.18s, 0.18s')
      await expect(page.getByTestId(menu.first)).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(surface).toHaveCount(0)
      await expect(trigger).toBeFocused()
    }
  } finally { await app.close() }
})

test('pointer menus share anchored entry in LTR and RTL; reduced motion keeps only the short fade without delaying focus', async () => {
  const { app, page } = await launch()
  try {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    for (const dir of ['ltr', 'rtl']) {
      await page.evaluate((dir) => { document.documentElement.dir = dir }, dir)
      for (const menu of menus) {
        const surface = page.getByTestId(menu.surface)
        await page.getByTestId(menu.trigger).click()
        await expect(surface).toBeVisible()
        const actual = await motion(surface)
        expect(actual.transition).toBe('opacity, transform')
        expect(actual.duration).toBe('0.18s, 0.18s')
        expect(actual.y).toBe(0)
        const left = menu.logical && (menu.end ? dir === 'rtl' : dir === 'ltr')
        expect(actual.x).toBeCloseTo(left ? 0 : actual.width, 1)
        await expect(page.getByTestId(menu.first)).toBeFocused()
        if (menu.surface === 'note-menu') {
          await page.keyboard.press('ArrowDown')
          await expect(surface.locator(':focus')).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
        }
        await page.keyboard.press('Escape')
        await expect(surface).toHaveCount(0)
        await expect(page.getByTestId(menu.trigger)).toBeFocused()
        await expect(page.getByTestId(menu.trigger)).toHaveCSS('outline-style', 'none')
      }
    }
    await page.emulateMedia({ reducedMotion: 'reduce' })
    for (const menu of menus) {
      const surface = page.getByTestId(menu.surface)
      await page.getByTestId(menu.trigger).click()
      await expect(surface).toBeVisible()
      expect((await motion(surface)).transition).toBe('opacity')
      expect((await motion(surface)).duration).toBe('0.12s')
      await expect(page.getByTestId(menu.first)).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(surface).toHaveCount(0)
    }
  } finally { await app.close() }
})

test('regeneration uses the top menu anchor and restores it after Escape', async () => {
  const { app, page } = await launch()
  try {
    await expect(page.getByTestId('note-view-menu')).toHaveCount(0)
    await page.getByTestId('note-menu-button').click()
    await page.getByTestId('note-write-again').click()
    const popup = page.getByTestId('note-regenerate')
    await expect(popup).toBeVisible()
    await expect(page.getByTestId('note-menu')).toHaveCount(0)
    await expect(page.getByTestId('note-regenerate-input')).toBeFocused()
    const anchor = await page.getByTestId('note-menu-button').boundingBox()
    const box = await popup.boundingBox()
    expect(box!.y).toBeCloseTo(anchor!.y + anchor!.height + 8, 0)
    await page.keyboard.press('Escape')
    await expect(popup).toHaveCount(0)
    await expect(page.getByTestId('note-menu-button')).toBeFocused()
  } finally { await app.close() }
})
