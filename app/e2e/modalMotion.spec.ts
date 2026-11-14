import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('shared dialogs use one soft surface, keep focus safe, and dismiss without opening commands', async () => {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-modal-motion-')),
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const trigger = page.getByTestId('folder-create')
    const capture = page.evaluate(async () => {
      let el: HTMLElement | null = null, animations: Animation[] = []
      for (let frame = 0; frame < 120; frame++) {
        await new Promise(requestAnimationFrame)
        el = document.querySelector('[data-testid="folder-name"]')
        animations = el?.getAnimations() ?? []
        if (animations.length) break
      }
      if (!el || !animations.length) throw new Error('Dialog entry did not animate')
      animations.forEach(a => a.pause())
      const durations = animations.map(a => a.effect!.getTiming().duration)
      const samples = []
      for (const time of [0, 144, 240]) {
        animations.forEach(a => { a.currentTime = time })
        await new Promise(requestAnimationFrame)
        const style = getComputedStyle(el), matrix = new DOMMatrix(style.transform)
        samples.push({ scaleX: matrix.m11, scaleY: matrix.m22, opacity: Number(style.opacity) })
      }
      animations.forEach(a => a.finish())
      return { durations, samples }
    })
    await trigger.click()
    const modal = page.getByTestId('folder-name')
    await expect(modal).toBeVisible()
    const motion = await capture
    expect(motion.durations.every(duration => duration === 240)).toBe(true)
    expect(motion.samples[0].scaleX).toBeCloseTo(.97, 3)
    expect(motion.samples[0].opacity).toBe(0)
    for (const sample of motion.samples) {
      expect(sample.scaleX).toBeCloseTo(sample.scaleY, 4)
      expect(sample.scaleX).toBeLessThanOrEqual(1.02)
    }
    expect(motion.samples.at(-1)!.scaleX).toBeCloseTo(1, 3)
    expect(motion.samples.at(-1)!.opacity).toBe(1)
    await expect(modal.locator('.dialog-motion-surface,.dialog-motion-content')).toHaveCount(0)
    await expect(page.locator('.app-modal-backdrop')).toBeVisible()
    await expect(page.getByTestId('folder-name-input')).toBeFocused()
    await page.keyboard.press('Meta+k')
    await expect(page.getByTestId('search')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(modal).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await trigger.click()
    await expect(page.getByTestId('folder-name-input')).toBeFocused()
    await expect(modal).toHaveCSS('transform', 'none')
    await expect(modal).toHaveCSS('filter', 'none')
    await expect(modal).toHaveCSS('transition-property', 'opacity')
    await expect(modal).toHaveCSS('transition-duration', '0.12s')
    await page.getByTestId('folder-name-cancel').click()
    await expect(modal).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await trigger.click()
    await expect(page.getByTestId('folder-name-input')).toBeFocused()
    await page.mouse.click(5, 100)
    await expect(modal).toHaveCount(0)
    await expect(trigger).toBeFocused()
  } finally { await app.close() }
})
