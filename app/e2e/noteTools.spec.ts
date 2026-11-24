import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('meeting tools expose all copy choices, an anchored search, and a multiline chat composer', async () => {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_BACKGROUND: '1', YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-note-tools-')),
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    await app.evaluate(() => (globalThis as unknown as { __fake__: { manyMeetings(n: number): void } }).__fake__.manyMeetings(1))
    await page.reload()
    await page.getByTestId('past-note').click()
    const share = page.getByTestId('share-button')
    await expect(page.locator('.note-header').getByTestId('share-button')).toHaveText('Share')
    await share.click()
    await expect(page.getByTestId('share-menu').getByRole('menuitem')).toHaveText(['Copy summary', 'Copy my notes', 'Copy transcript', 'Save Markdown…'])
    await expect(page.getByTestId('share-copy-summary')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('share-menu')).toHaveCount(0)
    await page.getByTestId('note-transcript-toggle').click()
    const search = page.getByTestId('transcript-search'), field = page.locator('.transcript-search-field')
    const trigger = page.getByTestId('transcript-find-open')
    await expect(page.locator('.note-primary-tabs').getByTestId('transcript-find-open')).toBeVisible()
    const tabs = (await page.locator('.note-primary-tabs').boundingBox())!
    const compact = (await trigger.boundingBox())!
    expect(compact.x + compact.width).toBeCloseTo(tabs.x + tabs.width, 1)
    await expect(page.getByTestId('transcript-copy')).toHaveCount(0)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await trigger.click()
    await expect(search).toBeFocused()
    await expect(search).toHaveCSS('text-align', 'start')
    await expect(field).toHaveCSS('transition-property', 'transform')
    await expect(field).toHaveCSS('transition-duration', '0.18s')
    const previous = page.getByTestId('transcript-find-previous'), next = page.getByTestId('transcript-find-next')
    await expect(page.locator('.transcript-find-results')).toHaveAttribute('inert', '')
    await expect(page.locator('.transcript-find-results')).toHaveCSS('opacity', '0')
    await expect(previous).toBeDisabled()
    await expect(next).toBeDisabled()
    await expect(page.locator('.transcript-find-arrows')).toHaveCSS('gap', '2px')
    const close = page.getByTestId('transcript-find-close')
    await expect(close).toBeEnabled()
    await expect(close).toHaveCSS('opacity', '1')
    await expect(close).toHaveAttribute('title', 'Close (Esc)')
    await expect(page.locator('.transcript-find-controls')).toHaveCSS('gap', '8px')
    for (const arrow of [previous, next, close]) {
      await expect(arrow).toHaveCSS('width', '28px')
      await expect(arrow).toHaveCSS('height', '28px')
      await expect(arrow.locator('svg')).toHaveAttribute('width', '14')
    }
    const arrowX = (await next.boundingBox())!.x
    const lines = page.getByTestId('transcript-line')
    await expect(lines.first()).toBeVisible()
    const lineCount = await lines.count()
    await search.fill('not present')
    await expect(page.locator('.transcript-find-results')).toHaveCSS('opacity', '1')
    await expect(page.getByTestId('transcript-find-count')).toHaveText('No matches')
    await expect(lines).toHaveCount(lineCount)
    await expect(previous).toBeDisabled()
    await expect(next).toBeDisabled()
    expect((await next.boundingBox())!.x).toBe(arrowX)
    await close.click()
    await expect(trigger).toBeFocused()
    await expect(search).toHaveValue('')
    await trigger.click()
    await expect(close).toBeEnabled()
    await page.getByTestId('note-transcript-toggle').click()
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await trigger.click()
    await expect(field).toHaveCSS('transition-duration', '0s')
    await search.fill('not present')
    for (const width of [1100, 720, 640, 520]) {
      await page.setViewportSize({ width, height: 700 })
      const openBox = (await field.boundingBox())!
      const tabBoxes = await page.locator('.note-primary-tabs [role=tab]').evaluateAll(tabs => tabs.map(tab => { const r=tab.getBoundingClientRect();return { top:r.top,bottom:r.bottom,left:r.left,right:r.right } }))
      expect(tabBoxes.every(tab => openBox.y >= tab.bottom || openBox.x >= tab.right || openBox.x + openBox.width <= tab.left)).toBe(true)
      const available = (await page.locator('.note-primary-tools').boundingBox())!.width
      const minimum = Math.max(240, (await page.locator('.transcript-find-controls').boundingBox())!.width + 76)
      const anchor = (await trigger.boundingBox())!
      if (available >= minimum) {
        expect(openBox.y).toBeCloseTo(anchor.y, 0)
        expect(openBox.width).toBeCloseTo(Math.min(376, available), 1)
      } else expect(openBox.y).toBeGreaterThanOrEqual(anchor.y + anchor.height)
      const blocked = await page.locator('.note-meta-row button').evaluateAll(buttons => buttons.flatMap(button => {
        const r = button.getBoundingClientRect()
        if (!r.width || !r.height) return []
        const points = [[r.x + r.width / 2, r.y + r.height / 2], [r.left + 3, r.top + 3], [r.right - 3, r.bottom - 3]]
        return points.every(([x, y]) => button.contains(document.elementFromPoint(x, y))) ? [] : [button.getAttribute('data-testid') ?? button.textContent]
      }))
      expect(blocked).toEqual([])
      // Normal clicks must reach the header while find stays open; Escape belongs to each open menu.
      await page.getByTestId('note-folders').click()
      await expect(page.getByTestId('folder-menu')).toBeVisible()
      // Folder rows load asynchronously; Escape must wait for the menu to own focus.
      await expect(page.getByTestId('folder-new')).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('folder-menu')).toHaveCount(0)
      await expect(page.getByTestId('note-folders')).toBeFocused()
      await share.click()
      await expect(page.getByTestId('share-menu')).toBeVisible()
      await expect(page.getByTestId('share-copy-summary')).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('share-menu')).toHaveCount(0)
      await expect(share).toBeFocused()
      await expect(trigger).toHaveAttribute('aria-expanded', 'true')
      await expect(search).toHaveValue('not present')
    }
    await page.setViewportSize({ width: 1100, height: 760 })
    await page.getByTestId('chat-open').click()
    const input = page.getByTestId('chat-input')
    await expect(input).toHaveJSProperty('tagName', 'TEXTAREA')
    await input.fill('What was decided?')
    await input.press('End')
    await input.press('Shift+Enter')
    await input.pressSequentially('And who owns it?')
    await expect(input).toHaveValue('What was decided?\nAnd who owns it?')
    await expect(page.getByTestId('chat-turn')).toHaveCount(0)
    await input.press('Enter')
    await expect(page.getByTestId('chat-question')).toHaveText('What was decided?\nAnd who owns it?')
    await expect(page.getByTestId('chat-turn')).toHaveAttribute('data-status', 'done', { timeout: 30_000 })
    await expect(page.getByTestId('chat-copy-answer')).toBeVisible()
  } finally { await app.close() }
})
