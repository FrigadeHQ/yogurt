import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NoteView } from '../src/shared/types'

for (const theme of ['light', 'dark'] as const) for (const width of [420, 860]) {
  test(`summary frame follows writing and yields to reading at ${width}px in ${theme}`, async () => {
    // the window's own setting (hidden locally, shown on CI): the summary unrolls on animation frames, which a hidden
    // window pauses on Linux and Windows, so forcing it hidden left the summary empty now and then
    const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
      ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-summary-rim-')),
    } })
    try {
      const page = await app.firstWindow()
      await expect(page.getByTestId('home')).toBeVisible()
      const win = await app.browserWindow(page)
      await win.evaluate(w => w.setContentSize(1200, 850))
      const id = await app.evaluate(async () => (await (globalThis as unknown as { __fake__: { chatMeetings(): Promise<string[]> } }).__fake__.chatMeetings())[0])
      await page.evaluate(id => window.yogurt.nav.go(`/note/${id}`), id)
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'no-preference' })
      await page.getByTestId('note-summary-tab').click()
      await page.locator('.note-layout').evaluate((el, width) => { el.style.flex = 'none'; el.style.width = `${width}px` }, width)
      const base = await page.evaluate(id => window.yogurt.notes.get(id), id)
      const push = async (status: NoteView['status'], draft: string) => {
        const view = { ...base, status, draft, enhanced: status === 'done' ? draft : null }
        await app.evaluate(({ BrowserWindow }, view) => {
          BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes('#'))!.webContents.send('notes:changed', view)
        }, view)
      }
      const rim = page.getByTestId('note-summary-rim'), pane = page.locator('#note-notes-panel'), latest = page.getByTestId('note-summary-latest')
      const summaryTab = page.getByRole('tab', { name: 'Summary', exact: true })
      const mark = page.locator('#note-summary-tab .summary-writing-mark')
      await push('waiting', '')
      await expect(mark).toBeVisible()
      await expect(summaryTab).toHaveAccessibleDescription('Preparing…')
      const stop = page.getByRole('button', { name: 'Stop summarizing', exact: true })
      await expect(stop).toBeEnabled()
      await expect(stop).toHaveText('Stop summarizing')
      await expect(stop.locator('svg, .summary-writing-mark')).toHaveCount(0)
      await expect(rim).toHaveCount(0)
      await expect(page.getByTestId('note-enhanced-waiting')).toBeVisible()
      expect(await pane.evaluate(el => el.scrollTop)).toBe(0)
      const tabs = (await page.locator('.note-primary-tabs').boundingBox())!, reading = (await page.locator('.note-reading-area').boundingBox())!
      const viewport = (await pane.boundingBox())!
      expect(viewport.y).toBeCloseTo(tabs.y + tabs.height, 0)
      expect(viewport.y + viewport.height).toBeCloseTo(reading.y + reading.height, 0)
      const text = (n: number) => Array.from({ length: n }, (_, i) => `## Section ${i + 1}\nThe team agreed to review the launch notes and confirm the next step before publishing.\n`).join('\n')
      await push('writing', text(18))
      await expect(mark).toBeVisible()
      await expect(summaryTab).toHaveAccessibleDescription('Writing the summary')
      // the words unroll on animation frames: a busy machine needs longer than the default 5 s (#93)
      await expect(page.getByTestId('note-enhanced-editor')).toContainText('Section 18', { timeout: 15_000 })
      await expect.poll(() => pane.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(24)
      await expect(rim).toHaveCount(0)
      await page.getByTestId('note-transcript-toggle').click()
      await expect(page.locator('.note-reading-frame')).toBeHidden()
      await expect(page.locator('.note-reading-frame')).toHaveAttribute('data-active', 'false')
      await page.getByTestId('note-summary-tab').click()
      await expect(page.locator('.note-reading-frame')).toHaveAttribute('data-active', 'true')
      await pane.evaluate(el => { el.dispatchEvent(new WheelEvent('wheel', { deltaY: -400 })); el.scrollTop = 100 })
      await expect(latest).toBeVisible()
      await push('writing', text(22))
      await expect(page.getByTestId('note-enhanced-editor')).toContainText('Section 22', { timeout: 15_000 })
      expect(await pane.evaluate(el => el.scrollTop)).toBeCloseTo(100, 0)
      await latest.click()
      await expect(latest).toBeHidden()
      await expect.poll(() => pane.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(24)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await expect(mark).toBeVisible()
      await expect(mark).toHaveCSS('animation-name', 'none')
      await expect(page.locator('.note-summary-status')).toHaveCount(0)
      await expect(rim).toHaveCount(0)
      const before = await pane.boundingBox(), scrollTop = await pane.evaluate(el => el.scrollTop)
      await push('done', text(22))
      await expect(rim).toHaveCount(0)
      await expect(latest).toBeHidden()
      const after = (await pane.boundingBox())!
      expect(after.y).toBe(before!.y)
      expect(after.width).toBe(before!.width)
      // Reading and writing use the full pane without a status lane.
      expect(after.height).toBe(before!.height)
      // where the reader was, give or take a pixel of rounding (#93)
      expect(Math.abs(await pane.evaluate(el => el.scrollTop) - scrollTop)).toBeLessThanOrEqual(1)
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await expect(page.locator('.note-reading-frame')).toHaveAttribute('data-active', 'false')
      await expect(page.getByTestId('note-summary-tab')).toHaveText('Summary')
      await expect(mark).toHaveCount(0)
      await expect(summaryTab).toHaveAccessibleDescription('')
      await expect(page.locator('.note-reading-clip')).toHaveCSS('overflow', 'hidden')
      await expect(page.locator('.note-reading-clip')).toHaveCSS('border-radius', '10px')
    } finally { await app.close() }
  })
}
